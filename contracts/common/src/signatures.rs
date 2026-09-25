use alloc::vec::Vec;
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};

use crate::publisher_set::PublisherSet;

pub const SIGNATURE_LEN: usize = 65;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexedSignature {
    pub publisher_index: u8,
    pub signature: [u8; SIGNATURE_LEN],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignatureBundle {
    pub signatures: Vec<IndexedSignature>,
}

impl SignatureBundle {
    pub fn from_bytes(data: &[u8]) -> Option<Self> {
        let (bundle, used) = Self::parse_prefix(data)?;
        (used == data.len()).then_some(bundle)
    }

    pub fn parse_prefix(data: &[u8]) -> Option<(Self, usize)> {
        let count = *data.first()? as usize;
        let expected = 1usize.checked_add(count.checked_mul(1 + SIGNATURE_LEN)?)?;
        if data.len() < expected {
            return None;
        }
        let mut signatures = Vec::with_capacity(count);
        let mut offset = 1usize;
        for _ in 0..count {
            let publisher_index = data[offset];
            offset += 1;
            let mut signature = [0u8; SIGNATURE_LEN];
            signature.copy_from_slice(&data[offset..offset + SIGNATURE_LEN]);
            offset += SIGNATURE_LEN;
            signatures.push(IndexedSignature { publisher_index, signature });
        }
        Some((Self { signatures }, expected))
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(1 + self.signatures.len() * (1 + SIGNATURE_LEN));
        out.push(self.signatures.len() as u8);
        for entry in &self.signatures {
            out.push(entry.publisher_index);
            out.extend_from_slice(&entry.signature);
        }
        out
    }

    pub fn verify_threshold(&self, digest: &[u8; 32], set: &PublisherSet) -> bool {
        if self.signatures.len() < set.quorum() || self.signatures.len() > set.pubkeys.len() {
            return false;
        }
        let mut previous: Option<u8> = None;
        for entry in &self.signatures {
            if previous.map_or(false, |p| entry.publisher_index <= p) {
                return false;
            }
            previous = Some(entry.publisher_index);
            let expected = match set.pubkeys.get(entry.publisher_index as usize) {
                Some(key) => key,
                None => return false,
            };
            if !verify_one(digest, &entry.signature, expected) {
                return false;
            }
        }
        true
    }

    pub fn verify_all(&self, digest: &[u8; 32], set: &PublisherSet) -> bool {
        if self.signatures.len() != set.pubkeys.len() {
            return false;
        }
        for (index, entry) in self.signatures.iter().enumerate() {
            if entry.publisher_index as usize != index
                || !verify_one(digest, &entry.signature, &set.pubkeys[index])
            {
                return false;
            }
        }
        true
    }
}

fn verify_one(digest: &[u8; 32], raw: &[u8; SIGNATURE_LEN], expected: &[u8; 33]) -> bool {
    let signature = match Signature::from_slice(&raw[..64]) {
        Ok(value) => value,
        Err(_) => return false,
    };
    if signature.normalize_s().is_some() {
        return false;
    }
    let recovery_id = match RecoveryId::try_from(raw[64]) {
        Ok(value) => value,
        Err(_) => return false,
    };
    let recovered = match VerifyingKey::recover_from_prehash(digest, &signature, recovery_id) {
        Ok(value) => value,
        Err(_) => return false,
    };
    recovered.to_encoded_point(true).as_bytes() == expected
}
