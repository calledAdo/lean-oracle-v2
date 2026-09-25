//! Deterministic committee keys and signed price-update builders.

use k256::ecdsa::{RecoveryId, SigningKey, VerifyingKey};
use lean_oracle_common::{
    price_update::{leaf_hash, merkle_proof, merkle_root, PriceMessage, PriceUpdateBlob, PriceUpdateHeader, UpdateEntry},
    protocol_hash::feed_id,
    publisher_set::{PublisherSet, PublisherSetData},
    signatures::{IndexedSignature, SignatureBundle},
};

/// A committee whose keys are sorted by compressed public key, as `PublisherSet` requires.
pub struct Committee {
    pub keys: Vec<SigningKey>,
    pub data: PublisherSetData,
}

impl Committee {
    pub fn new(n: usize, set_index: u32) -> Self {
        let mut keys: Vec<SigningKey> = (1..=n)
            .map(|i| SigningKey::from_bytes(&[i as u8 + 0x10 * set_index as u8 + 1; 32].into()).unwrap())
            .collect();
        keys.sort_by_key(compressed);
        let pubkeys = keys.iter().map(compressed).collect();
        let data = PublisherSetData {
            network_id: [0xaa; 32],
            governance_nonce: set_index as u64,
            governance_flags: 0,
            current: PublisherSet { set_index, pubkeys },
        };
        Self { keys, data }
    }

    /// Signatures from the given publisher indexes (ascending) over `digest`.
    pub fn sign(&self, digest: &[u8; 32], indexes: &[usize]) -> SignatureBundle {
        let signatures = indexes
            .iter()
            .map(|&index| {
                let (signature, _) = self.keys[index].sign_prehash_recoverable(digest).unwrap();
                let signature = signature.normalize_s().unwrap_or(signature);
                let recovery = (0u8..2)
                    .filter_map(RecoveryId::from_byte)
                    .find(|id| {
                        VerifyingKey::recover_from_prehash(digest, &signature, *id).ok().as_ref()
                            == Some(self.keys[index].verifying_key())
                    })
                    .unwrap();
                let mut raw = [0u8; 65];
                raw[..64].copy_from_slice(&signature.to_bytes());
                raw[64] = recovery.to_byte();
                IndexedSignature { publisher_index: index as u8, signature: raw }
            })
            .collect();
        SignatureBundle { signatures }
    }

    pub fn quorum_indexes(&self) -> Vec<usize> {
        (0..self.data.current.quorum()).collect()
    }
}

fn compressed(key: &SigningKey) -> [u8; 33] {
    key.verifying_key().to_encoded_point(true).as_bytes().try_into().unwrap()
}

pub fn btc() -> [u8; 32] {
    feed_id(b"Crypto.BTC/USD")
}

pub fn message(feed: [u8; 32], price: i64) -> PriceMessage {
    PriceMessage {
        feed_id: feed,
        price,
        conf: 1_500_000,
        expo: -8,
        prev_publish_time_ms: 0,
        ema_price: price - 1_000,
        ema_conf: 2_000_000,
        source_time_ms: 0,
        num_publishers: 3,
    }
}

/// A finalized tick for `messages` (sorted by feed id), signed by `indexes`, carrying every leaf.
pub fn signed_update(
    committee: &Committee,
    publisher_set_type_hash: [u8; 32],
    publish_time_ms: u64,
    mut messages: Vec<PriceMessage>,
    indexes: &[usize],
) -> PriceUpdateBlob {
    messages.sort_by_key(|m| m.feed_id);
    for m in &mut messages {
        m.prev_publish_time_ms = publish_time_ms.saturating_sub(1000);
        m.source_time_ms = publish_time_ms - 150;
    }
    let leaves: Vec<[u8; 32]> = messages.iter().map(|m| leaf_hash(&m.to_bytes())).collect();
    let header = PriceUpdateHeader {
        publisher_set_type_hash,
        set_index: committee.data.current.set_index,
        publish_time_ms,
        tick_period_ms: 1000,
        config_hash: [0xcf; 32],
        leaf_count: messages.len() as u16,
        merkle_root: merkle_root(&leaves).unwrap(),
    };
    let signatures = committee.sign(&header.signing_hash(), indexes);
    let entries = messages
        .iter()
        .enumerate()
        .map(|(i, m)| UpdateEntry { message_bytes: m.to_bytes(), proof: merkle_proof(&leaves, i).unwrap() })
        .collect();
    PriceUpdateBlob { header, signatures, entries }
}
