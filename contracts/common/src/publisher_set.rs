use alloc::vec::Vec;

use crate::protocol_hash::{ckb_hash, DOMAIN_SET_POP, DOMAIN_SET_STATE, DOMAIN_SET_UPDATE};

pub const PUBLISHER_SET_MAGIC: &[u8; 4] = b"PSET";
pub const PUBLISHER_SET_VERSION: u8 = 1;
pub const MAX_PUBLISHERS: usize = 9;
pub const GOVERNANCE_LOCKED: u8 = 0x01;
pub const GOVERNANCE_PAUSED: u8 = 0x02;
pub const OP_ROTATE: u8 = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublisherSet {
    pub set_index: u32,
    pub pubkeys: Vec<[u8; 33]>,
}

impl PublisherSet {
    fn decode(data: &[u8], offset: &mut usize) -> Option<Self> {
        let set_index = read_u32(data, offset)?;
        let count = read_u8(data, offset)? as usize;
        let mut pubkeys = Vec::with_capacity(count);
        for _ in 0..count {
            let bytes = take(data, offset, 33)?;
            let mut key = [0u8; 33];
            key.copy_from_slice(bytes);
            pubkeys.push(key);
        }
        Some(Self { set_index, pubkeys })
    }

    fn encode(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.set_index.to_le_bytes());
        out.push(self.pubkeys.len() as u8);
        for key in &self.pubkeys {
            out.extend_from_slice(key);
        }
    }

    pub fn validate(&self) -> bool {
        let n = self.pubkeys.len();
        if n == 0 || n > MAX_PUBLISHERS {
            return false;
        }
        for (i, key) in self.pubkeys.iter().enumerate() {
            if key[0] != 2 && key[0] != 3 {
                return false;
            }
            if i > 0 && self.pubkeys[i - 1] >= *key {
                return false;
            }
        }
        true
    }

    pub fn quorum(&self) -> usize {
        (2 * self.pubkeys.len()) / 3 + 1
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublisherSetData {
    pub network_id: [u8; 32],
    pub governance_nonce: u64,
    pub governance_flags: u8,
    pub current: PublisherSet,
}

impl PublisherSetData {
    pub fn from_bytes(data: &[u8]) -> Option<Self> {
        if data.len() < 4 + 1 + 32 + 8 + 2 || &data[..4] != PUBLISHER_SET_MAGIC || data[4] != PUBLISHER_SET_VERSION {
            return None;
        }
        let mut offset = 5usize;
        let mut network_id = [0u8; 32];
        network_id.copy_from_slice(take(data, &mut offset, 32)?);
        let governance_nonce = read_u64(data, &mut offset)?;
        let governance_flags = read_u8(data, &mut offset)?;
        let reserved = read_u8(data, &mut offset)?;
        if reserved != 0 {
            return None;
        }
        let current = PublisherSet::decode(data, &mut offset)?;
        if offset != data.len() {
            return None;
        }
        let value = Self {
            network_id,
            governance_nonce,
            governance_flags,
            current,
        };
        value.validate().then_some(value)
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(PUBLISHER_SET_MAGIC);
        out.push(PUBLISHER_SET_VERSION);
        out.extend_from_slice(&self.network_id);
        out.extend_from_slice(&self.governance_nonce.to_le_bytes());
        out.push(self.governance_flags);
        out.push(0);
        self.current.encode(&mut out);
        out
    }

    pub fn validate(&self) -> bool {
        if !self.current.validate() {
            return false;
        }
        if self.governance_flags & GOVERNANCE_LOCKED != 0
            && (self.current.quorum() * 2 <= self.current.pubkeys.len())
        {
            return false;
        }
        true
    }

    pub fn state_hash(&self) -> [u8; 32] {
        let bytes = self.to_bytes();
        ckb_hash(&[DOMAIN_SET_STATE, &bytes])
    }

    pub fn update_hash(&self, next: &Self, operation: u8) -> [u8; 32] {
        let old_hash = self.state_hash();
        let next_hash = next.state_hash();
        ckb_hash(&[DOMAIN_SET_UPDATE, &[operation], &old_hash, &next_hash])
    }

    pub fn pop_hash(&self) -> [u8; 32] {
        let state_hash = self.state_hash();
        ckb_hash(&[DOMAIN_SET_POP, &state_hash])
    }

    pub fn active_set(&self, set_index: u32) -> Option<&PublisherSet> {
        (set_index == self.current.set_index).then_some(&self.current)
    }
}

fn take<'a>(data: &'a [u8], offset: &mut usize, len: usize) -> Option<&'a [u8]> {
    let end = offset.checked_add(len)?;
    let result = data.get(*offset..end)?;
    *offset = end;
    Some(result)
}

fn read_u8(data: &[u8], offset: &mut usize) -> Option<u8> {
    Some(*take(data, offset, 1)?.first()?)
}

fn read_u32(data: &[u8], offset: &mut usize) -> Option<u32> {
    Some(u32::from_le_bytes(take(data, offset, 4)?.try_into().ok()?))
}

fn read_u64(data: &[u8], offset: &mut usize) -> Option<u64> {
    Some(u64::from_le_bytes(take(data, offset, 8)?.try_into().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(prefix: u8, byte: u8) -> [u8; 33] {
        let mut out = [byte; 33];
        out[0] = prefix;
        out
    }

    #[test]
    fn publisher_set_has_one_active_set() {
        let old = PublisherSetData {
            network_id: [0xaa; 32],
            governance_nonce: 0,
            governance_flags: 0,
            current: PublisherSet {
                set_index: 0,
                pubkeys: alloc::vec![key(2, 0x11)],
            },
        };
        let bytes = old.to_bytes();
        assert_eq!(bytes.len(), 85);
        assert_eq!(bytes[4], PUBLISHER_SET_VERSION);
        assert_eq!(PublisherSetData::from_bytes(&bytes), Some(old.clone()));
        assert_eq!(old.active_set(0), Some(&old.current));
        assert_eq!(old.active_set(1), None);

        let mut wrong_version = bytes.clone();
        wrong_version[4] = PUBLISHER_SET_VERSION + 1;
        assert_eq!(PublisherSetData::from_bytes(&wrong_version), None);
        let mut trailing = bytes;
        trailing.push(0);
        assert_eq!(PublisherSetData::from_bytes(&trailing), None);

        let next = PublisherSetData {
            network_id: [0xaa; 32],
            governance_nonce: 1,
            governance_flags: 0,
            current: PublisherSet {
                set_index: 1,
                pubkeys: alloc::vec![key(2, 0x22), key(2, 0x44), key(3, 0x33)],
            },
        };
        assert_eq!(PublisherSetData::from_bytes(&next.to_bytes()), Some(next.clone()));
        assert_eq!(next.active_set(0), None);
        assert_eq!(next.active_set(1), Some(&next.current));
        assert_ne!(old.state_hash(), next.state_hash());
        assert_ne!(old.update_hash(&next, OP_ROTATE), next.pop_hash());
    }

    #[test]
    fn quorum_is_derived_for_every_supported_publisher_count() {
        let expected = [1, 2, 3, 3, 4, 5, 5, 6, 7];
        for (index, quorum) in expected.iter().enumerate() {
            let set = PublisherSet {
                set_index: 0,
                pubkeys: (1..=index + 1).map(|byte| key(2, byte as u8)).collect(),
            };
            assert!(set.validate());
            assert_eq!(set.quorum(), *quorum);
            let state = PublisherSetData {
                network_id: [0xaa; 32],
                governance_nonce: 0,
                governance_flags: GOVERNANCE_LOCKED,
                current: set,
            };
            assert_eq!(PublisherSetData::from_bytes(&state.to_bytes()), Some(state));
        }

        let empty = PublisherSet { set_index: 0, pubkeys: Vec::new() };
        assert!(!empty.validate());
        let too_many = PublisherSet {
            set_index: 0,
            pubkeys: (1..=MAX_PUBLISHERS + 1).map(|byte| key(2, byte as u8)).collect(),
        };
        assert!(!too_many.validate());
    }
}
