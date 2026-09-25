use blake2b_ref::Blake2bBuilder;

pub const DOMAIN_SET_STATE: &[u8] = b"LEAN/PUBLISHER_SET_STATE/V1";
pub const DOMAIN_SET_UPDATE: &[u8] = b"LEAN/PUBLISHER_SET_UPDATE/V1";
pub const DOMAIN_SET_POP: &[u8] = b"LEAN/PUBLISHER_SET_POP/V1";
pub const DOMAIN_FEED: &[u8] = b"LEAN/FEED/V1";
pub const DOMAIN_PRICE_UPDATE: &[u8] = b"LEAN/PRICE_UPDATE/V1";
pub const DOMAIN_PRICE_LEAF: &[u8] = b"LEAN/PRICE_LEAF/V1";
pub const DOMAIN_PRICE_NODE: &[u8] = b"LEAN/PRICE_NODE/V1";
pub const DOMAIN_OBSERVATION: &[u8] = b"LEAN/OBSERVATION/V1";
pub const DOMAIN_COMMITTEE_CONFIG: &[u8] = b"LEAN/COMMITTEE_CONFIG/V1";

pub fn ckb_hash(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    for part in parts {
        hasher.update(part);
    }
    let mut out = [0u8; 32];
    hasher.finalize(&mut out);
    out
}

/// Canonical feed identifier, e.g. `feed_id(b"Crypto.BTC/USD")`.
pub fn feed_id(symbol: &[u8]) -> [u8; 32] {
    ckb_hash(&[DOMAIN_FEED, symbol])
}

/// Type ID seed: `ckb_hash(first_input || output_index as u64 LE)`.
pub fn type_id_seed(first_input: &[u8], output_index: u64) -> [u8; 32] {
    ckb_hash(&[first_input, &output_index.to_le_bytes()])
}
