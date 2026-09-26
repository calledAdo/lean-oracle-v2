//! Signed price updates: header, per-feed leaves, Merkle proofs and blob verification.
//! Layouts follow docs/oracle-design.md section 6. All integers are little-endian.

use alloc::vec::Vec;

use crate::protocol_hash::{ckb_hash, DOMAIN_PRICE_LEAF, DOMAIN_PRICE_NODE, DOMAIN_PRICE_UPDATE};
use crate::publisher_set::{PublisherSetData, GOVERNANCE_PAUSED};
use crate::signatures::SignatureBundle;

pub const PRICE_UPDATE_MAGIC: &[u8; 4] = b"LOPU";
pub const PRICE_UPDATE_VERSION: u8 = 1;
pub const HEADER_LEN: usize = 119;
pub const MESSAGE_LEN: usize = 86;
pub const MESSAGE_TYPE_PRICE: u8 = 0;
/// `leaf_count` is a u16, so no valid proof is deeper than 16 levels.
pub const MAX_PROOF_LEN: usize = 16;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PriceUpdateHeader {
    pub publisher_set_type_hash: [u8; 32],
    pub set_index: u32,
    pub publish_time_ms: u64,
    pub tick_period_ms: u32,
    pub config_hash: [u8; 32],
    pub leaf_count: u16,
    pub merkle_root: [u8; 32],
}

impl PriceUpdateHeader {
    pub fn from_bytes(data: &[u8]) -> Option<Self> {
        if data.len() != HEADER_LEN || &data[..4] != PRICE_UPDATE_MAGIC || data[4] != PRICE_UPDATE_VERSION {
            return None;
        }
        let mut offset = 5usize;
        let header = Self {
            publisher_set_type_hash: array(data, &mut offset)?,
            set_index: u32::from_le_bytes(array(data, &mut offset)?),
            publish_time_ms: u64::from_le_bytes(array(data, &mut offset)?),
            tick_period_ms: u32::from_le_bytes(array(data, &mut offset)?),
            config_hash: array(data, &mut offset)?,
            leaf_count: u16::from_le_bytes(array(data, &mut offset)?),
            merkle_root: array(data, &mut offset)?,
        };
        (header.leaf_count > 0).then_some(header)
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(HEADER_LEN);
        out.extend_from_slice(PRICE_UPDATE_MAGIC);
        out.push(PRICE_UPDATE_VERSION);
        out.extend_from_slice(&self.publisher_set_type_hash);
        out.extend_from_slice(&self.set_index.to_le_bytes());
        out.extend_from_slice(&self.publish_time_ms.to_le_bytes());
        out.extend_from_slice(&self.tick_period_ms.to_le_bytes());
        out.extend_from_slice(&self.config_hash);
        out.extend_from_slice(&self.leaf_count.to_le_bytes());
        out.extend_from_slice(&self.merkle_root);
        out
    }

    pub fn signing_hash(&self) -> [u8; 32] {
        ckb_hash(&[DOMAIN_PRICE_UPDATE, &self.to_bytes()])
    }
}

/// One Merkle leaf: the committee's price for one feed at the header's tick.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PriceMessage {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub expo: i32,
    pub prev_publish_time_ms: u64,
    pub ema_price: i64,
    pub ema_conf: u64,
    pub source_time_ms: u64,
    pub num_publishers: u8,
}

impl PriceMessage {
    pub fn from_bytes(data: &[u8]) -> Option<Self> {
        if data.len() != MESSAGE_LEN || data[0] != MESSAGE_TYPE_PRICE {
            return None;
        }
        let mut offset = 1usize;
        Some(Self {
            feed_id: array(data, &mut offset)?,
            price: i64::from_le_bytes(array(data, &mut offset)?),
            conf: u64::from_le_bytes(array(data, &mut offset)?),
            expo: i32::from_le_bytes(array(data, &mut offset)?),
            prev_publish_time_ms: u64::from_le_bytes(array(data, &mut offset)?),
            ema_price: i64::from_le_bytes(array(data, &mut offset)?),
            ema_conf: u64::from_le_bytes(array(data, &mut offset)?),
            source_time_ms: u64::from_le_bytes(array(data, &mut offset)?),
            num_publishers: data[offset],
        })
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(MESSAGE_LEN);
        out.push(MESSAGE_TYPE_PRICE);
        out.extend_from_slice(&self.feed_id);
        out.extend_from_slice(&self.price.to_le_bytes());
        out.extend_from_slice(&self.conf.to_le_bytes());
        out.extend_from_slice(&self.expo.to_le_bytes());
        out.extend_from_slice(&self.prev_publish_time_ms.to_le_bytes());
        out.extend_from_slice(&self.ema_price.to_le_bytes());
        out.extend_from_slice(&self.ema_conf.to_le_bytes());
        out.extend_from_slice(&self.source_time_ms.to_le_bytes());
        out.push(self.num_publishers);
        out
    }
}

pub fn leaf_hash(message_bytes: &[u8]) -> [u8; 32] {
    ckb_hash(&[DOMAIN_PRICE_LEAF, message_bytes])
}

pub fn node_hash(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    ckb_hash(&[DOMAIN_PRICE_NODE, lo, hi])
}

pub fn verify_proof(root: &[u8; 32], leaf: [u8; 32], proof: &[[u8; 32]]) -> bool {
    proof.iter().fold(leaf, |current, sibling| node_hash(&current, sibling)) == *root
}

/// Root over leaf hashes (in ascending `feed_id` order); an odd node is promoted unchanged.
pub fn merkle_root(leaves: &[[u8; 32]]) -> Option<[u8; 32]> {
    let mut level: Vec<[u8; 32]> = leaves.to_vec();
    if level.is_empty() {
        return None;
    }
    while level.len() > 1 {
        level = level
            .chunks(2)
            .map(|pair| if pair.len() == 2 { node_hash(&pair[0], &pair[1]) } else { pair[0] })
            .collect();
    }
    Some(level[0])
}

/// Sibling path for `leaves[index]`, matching `merkle_root`.
pub fn merkle_proof(leaves: &[[u8; 32]], mut index: usize) -> Option<Vec<[u8; 32]>> {
    if index >= leaves.len() {
        return None;
    }
    let mut level: Vec<[u8; 32]> = leaves.to_vec();
    let mut proof = Vec::new();
    while level.len() > 1 {
        let sibling = index ^ 1;
        if sibling < level.len() {
            proof.push(level[sibling]);
        }
        level = level
            .chunks(2)
            .map(|pair| if pair.len() == 2 { node_hash(&pair[0], &pair[1]) } else { pair[0] })
            .collect();
        index /= 2;
    }
    Some(proof)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateEntry {
    pub message_bytes: Vec<u8>,
    pub proof: Vec<[u8; 32]>,
}

/// `header | SignatureBundle | entry_count u8 | entries { message | proof_len u8 | proof }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PriceUpdateBlob {
    pub header: PriceUpdateHeader,
    pub signatures: SignatureBundle,
    pub entries: Vec<UpdateEntry>,
}

impl PriceUpdateBlob {
    pub fn from_bytes(data: &[u8]) -> Option<Self> {
        let header = PriceUpdateHeader::from_bytes(data.get(..HEADER_LEN)?)?;
        let (signatures, used) = SignatureBundle::parse_prefix(&data[HEADER_LEN..])?;
        let mut offset = HEADER_LEN + used;
        let count = *data.get(offset)? as usize;
        offset += 1;
        if count == 0 {
            return None;
        }
        let mut entries = Vec::with_capacity(count);
        for _ in 0..count {
            let message_bytes = take(data, &mut offset, MESSAGE_LEN)?.to_vec();
            let proof_len = *take(data, &mut offset, 1)?.first()? as usize;
            if proof_len > MAX_PROOF_LEN {
                return None;
            }
            let mut proof = Vec::with_capacity(proof_len);
            for _ in 0..proof_len {
                proof.push(array::<32>(data, &mut offset)?);
            }
            entries.push(UpdateEntry { message_bytes, proof });
        }
        (offset == data.len()).then_some(Self { header, signatures, entries })
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = self.header.to_bytes();
        out.extend_from_slice(&self.signatures.to_bytes());
        out.push(self.entries.len() as u8);
        for entry in &self.entries {
            out.extend_from_slice(&entry.message_bytes);
            out.push(entry.proof.len() as u8);
            for node in &entry.proof {
                out.extend_from_slice(node);
            }
        }
        out
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerifyError {
    Malformed,
    FeedNotFound,
    DuplicateFeed,
    Proof,
    PublisherSet,
    Paused,
    SetIndex,
    Signature,
}

/// A price authenticated by the committee, ready to be written to a feed cell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedPrice {
    pub header: PriceUpdateHeader,
    pub message: PriceMessage,
}

/// The committee's signatures over `header`: the header names this committee, the committee is not
/// paused, and a quorum of the set that was valid for the header's tick signed it (the current set,
/// or the previous set for ticks before its switch).
pub fn verify_header(
    header: &PriceUpdateHeader,
    signatures: &SignatureBundle,
    publisher_set_type_hash: &[u8; 32],
    publisher_set: &PublisherSetData,
) -> Result<(), VerifyError> {
    if &header.publisher_set_type_hash != publisher_set_type_hash {
        return Err(VerifyError::PublisherSet);
    }
    if publisher_set.governance_flags & GOVERNANCE_PAUSED != 0 {
        return Err(VerifyError::Paused);
    }
    let set = publisher_set.set_for(header.set_index, header.publish_time_ms).ok_or(VerifyError::SetIndex)?;
    if !signatures.verify_threshold(&header.signing_hash(), set) {
        return Err(VerifyError::Signature);
    }
    Ok(())
}

/// The one entry for `feed_id` in `update`, with a valid Merkle proof against the header's root.
/// Signatures are not checked here.
pub fn find_entry(update: &PriceUpdateBlob, feed_id: &[u8; 32]) -> Result<PriceMessage, VerifyError> {
    let mut found: Option<&UpdateEntry> = None;
    for entry in &update.entries {
        if entry.message_bytes[1..33] == feed_id[..] {
            if found.is_some() {
                return Err(VerifyError::DuplicateFeed);
            }
            found = Some(entry);
        }
    }
    let entry = found.ok_or(VerifyError::FeedNotFound)?;
    let message = PriceMessage::from_bytes(&entry.message_bytes).ok_or(VerifyError::Malformed)?;
    if !verify_proof(&update.header.merkle_root, leaf_hash(&entry.message_bytes), &entry.proof) {
        return Err(VerifyError::Proof);
    }
    Ok(message)
}

/// Verify one feed's price inside an update blob against the committee cell's current data:
/// the entry and its proof, then the committee's signatures over the header.
pub fn verify_price_update(
    blob: &[u8],
    feed_id: &[u8; 32],
    publisher_set_type_hash: &[u8; 32],
    publisher_set: &PublisherSetData,
) -> Result<VerifiedPrice, VerifyError> {
    let update = PriceUpdateBlob::from_bytes(blob).ok_or(VerifyError::Malformed)?;
    let message = find_entry(&update, feed_id)?;
    verify_header(&update.header, &update.signatures, publisher_set_type_hash, publisher_set)?;
    Ok(VerifiedPrice { header: update.header, message })
}

fn take<'a>(data: &'a [u8], offset: &mut usize, len: usize) -> Option<&'a [u8]> {
    let end = offset.checked_add(len)?;
    let result = data.get(*offset..end)?;
    *offset = end;
    Some(result)
}

fn array<const N: usize>(data: &[u8], offset: &mut usize) -> Option<[u8; N]> {
    take(data, offset, N)?.try_into().ok()
}
