use lean_oracle_common::{
    price_feed::{PriceFeedData, PRICE_FEED_LEN},
    price_update::*,
    protocol_hash::feed_id,
    publisher_set::GOVERNANCE_PAUSED,
};

use crate::fixtures::*;

const SET_HASH: [u8; 32] = [0x5e; 32];

fn basket() -> Vec<PriceMessage> {
    ["Crypto.BTC/USD", "Crypto.ETH/USD", "Crypto.SOL/USD", "Crypto.USDT/USD", "Crypto.USDC/USD"]
        .iter()
        .enumerate()
        .map(|(i, symbol)| message(feed_id(symbol.as_bytes()), 1_000_000_000 * (i as i64 + 1)))
        .collect()
}

#[test]
fn merkle_proofs_verify_for_every_leaf_and_size() {
    for size in 1..=17usize {
        let leaves: Vec<[u8; 32]> = (0..size).map(|i| leaf_hash(&[i as u8])).collect();
        let root = merkle_root(&leaves).unwrap();
        for (i, leaf) in leaves.iter().enumerate() {
            let proof = merkle_proof(&leaves, i).unwrap();
            assert!(proof.len() <= MAX_PROOF_LEN);
            assert!(verify_proof(&root, *leaf, &proof), "size {size} leaf {i}");
            assert!(!verify_proof(&root, leaf_hash(b"other"), &proof));
        }
    }
    assert_eq!(merkle_root(&[]), None);
}

#[test]
fn codecs_round_trip_and_reject_bad_shapes() {
    let committee = Committee::new(4, 0);
    let blob = signed_update(&committee, SET_HASH, 1_700_000_000_000, basket(), &committee.quorum_indexes());
    let bytes = blob.to_bytes();
    assert_eq!(PriceUpdateBlob::from_bytes(&bytes), Some(blob.clone()));
    assert_eq!(blob.header.to_bytes().len(), HEADER_LEN);
    assert_eq!(PriceUpdateHeader::from_bytes(&blob.header.to_bytes()), Some(blob.header.clone()));

    let mut trailing = bytes.clone();
    trailing.push(0);
    assert_eq!(PriceUpdateBlob::from_bytes(&trailing), None);
    assert_eq!(PriceUpdateBlob::from_bytes(&bytes[..bytes.len() - 1]), None);
    let mut bad_magic = bytes.clone();
    bad_magic[0] ^= 1;
    assert_eq!(PriceUpdateBlob::from_bytes(&bad_magic), None);

    let message = &blob.entries[0].message_bytes;
    assert_eq!(message.len(), MESSAGE_LEN);
    let mut wrong_type = message.clone();
    wrong_type[0] = 1;
    assert_eq!(PriceMessage::from_bytes(&wrong_type), None);

    let feed = PriceFeedData { feed_id: btc(), publisher_set_type_hash: SET_HASH, ..Default::default() };
    assert_eq!(feed.to_bytes().len(), PRICE_FEED_LEN);
    assert_eq!(PriceFeedData::from_bytes(&feed.to_bytes()), Some(feed.clone()));
    assert!(feed.is_uninitialized());
}

#[test]
fn verify_accepts_quorum_and_rejects_every_failure_mode() {
    let committee = Committee::new(4, 0);
    let quorum = committee.quorum_indexes();
    assert_eq!(quorum.len(), 3);
    let time = 1_700_000_000_000;
    let good = signed_update(&committee, SET_HASH, time, basket(), &quorum).to_bytes();

    let verified = verify_price_update(&good, &btc(), &SET_HASH, &committee.data).unwrap();
    assert_eq!(verified.message.feed_id, btc());
    assert_eq!(verified.header.publish_time_ms, time);

    // Every feed in the basket verifies with its own proof.
    for m in basket() {
        assert!(verify_price_update(&good, &m.feed_id, &SET_HASH, &committee.data).is_ok());
    }

    assert_eq!(verify_price_update(&good, &feed_id(b"Crypto.DOGE/USD"), &SET_HASH, &committee.data), Err(VerifyError::FeedNotFound));
    assert_eq!(verify_price_update(&good, &btc(), &[0x11; 32], &committee.data), Err(VerifyError::PublisherSet));

    let mut paused = committee.data.clone();
    paused.governance_flags = GOVERNANCE_PAUSED;
    assert_eq!(verify_price_update(&good, &btc(), &SET_HASH, &paused), Err(VerifyError::Paused));

    // Current-set-only: after rotation the old set's updates are rejected.
    let rotated = Committee::new(4, 1);
    assert_eq!(verify_price_update(&good, &btc(), &SET_HASH, &rotated.data), Err(VerifyError::SetIndex));

    let under = signed_update(&committee, SET_HASH, time, basket(), &quorum[..2]).to_bytes();
    assert_eq!(verify_price_update(&under, &btc(), &SET_HASH, &committee.data), Err(VerifyError::Signature));

    // A forged price inside a signed update breaks the Merkle proof.
    let mut forged = PriceUpdateBlob::from_bytes(&good).unwrap();
    let index = forged.entries.iter().position(|e| e.message_bytes[1..33] == btc()).unwrap();
    let mut m = PriceMessage::from_bytes(&forged.entries[index].message_bytes).unwrap();
    m.price += 1;
    forged.entries[index].message_bytes = m.to_bytes();
    assert_eq!(verify_price_update(&forged.to_bytes(), &btc(), &SET_HASH, &committee.data), Err(VerifyError::Proof));

    // Changing the header (e.g. its time) invalidates the quorum signatures.
    let mut retimed = PriceUpdateBlob::from_bytes(&good).unwrap();
    retimed.header.publish_time_ms += 1000;
    assert_eq!(verify_price_update(&retimed.to_bytes(), &btc(), &SET_HASH, &committee.data), Err(VerifyError::Signature));

    // The same feed may not appear twice in one blob.
    let mut duplicated = PriceUpdateBlob::from_bytes(&good).unwrap();
    duplicated.entries.push(duplicated.entries[index].clone());
    assert_eq!(verify_price_update(&duplicated.to_bytes(), &btc(), &SET_HASH, &committee.data), Err(VerifyError::DuplicateFeed));
}

#[test]
fn single_publisher_committee_verifies() {
    let committee = Committee::new(1, 0);
    let blob = signed_update(&committee, SET_HASH, 1_000, vec![message(btc(), 42)], &[0]).to_bytes();
    assert!(verify_price_update(&blob, &btc(), &SET_HASH, &committee.data).is_ok());
}
