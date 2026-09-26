//! Committee cell data (PublisherSet v2) and its governance transitions.
//!
//! Layout (little-endian):
//! `magic "PSET" | version u8 = 2 | network_id [32] | governance_nonce u64 | governance_flags u8 |
//!  reserved u8 = 0 | min_rotation_interval_s u64 | current set | has_previous u8 |
//!  [previous set | previous_until_ms u64]`, where a set is `set_index u32 | count u8 | count × pubkey [33]`.
//!
//! The previous set keeps verifying updates for ticks before `previous_until_ms` (the first tick of the
//! current set), so a routine rotation does not invalidate recent history. An emergency rotation, or
//! a later `OP_REVOKE_PREVIOUS`, drops it.

use alloc::vec::Vec;

use crate::protocol_hash::{ckb_hash, DOMAIN_SET_POP, DOMAIN_SET_STATE, DOMAIN_SET_UPDATE};

pub const PUBLISHER_SET_MAGIC: &[u8; 4] = b"PSET";
pub const PUBLISHER_SET_VERSION: u8 = 2;
pub const MAX_PUBLISHERS: usize = 9;
pub const GOVERNANCE_LOCKED: u8 = 0x01;
pub const GOVERNANCE_PAUSED: u8 = 0x02;

/// Rotate to the next set; the outgoing set becomes `previous`.
pub const OP_ROTATE: u8 = 1;
/// Rotate to the next set and drop every earlier set (emergency; not subject to the interval).
pub const OP_ROTATE_REVOKE: u8 = 2;
pub const OP_PAUSE: u8 = 3;
pub const OP_UNPAUSE: u8 = 4;
/// Drop the previous set at any time (e.g. retired keys leaked after the rotation).
pub const OP_REVOKE_PREVIOUS: u8 = 5;

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

/// The set that signed before the current one, valid for ticks before `until_ms`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviousSet {
    pub set: PublisherSet,
    /// First tick of the current set; the previous set verifies only `publish_time_ms < until_ms`.
    pub until_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublisherSetData {
    pub network_id: [u8; 32],
    pub governance_nonce: u64,
    pub governance_flags: u8,
    /// Minimum age of the committee cell before a routine rotation (enforced with a relative `since`).
    pub min_rotation_interval_s: u64,
    pub current: PublisherSet,
    pub previous: Option<PreviousSet>,
}

/// Why a governance transition is invalid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransitionError {
    /// Nonce, network, interval or the LOCKED flag broke continuity.
    Continuity,
    /// The next state is not the one this operation produces.
    Operation,
}

impl PublisherSetData {
    pub fn from_bytes(data: &[u8]) -> Option<Self> {
        if data.len() < 4 + 1 + 32 + 8 + 2 + 8 || &data[..4] != PUBLISHER_SET_MAGIC || data[4] != PUBLISHER_SET_VERSION {
            return None;
        }
        let mut offset = 5usize;
        let mut network_id = [0u8; 32];
        network_id.copy_from_slice(take(data, &mut offset, 32)?);
        let governance_nonce = read_u64(data, &mut offset)?;
        let governance_flags = read_u8(data, &mut offset)?;
        if read_u8(data, &mut offset)? != 0 {
            return None;
        }
        let min_rotation_interval_s = read_u64(data, &mut offset)?;
        let current = PublisherSet::decode(data, &mut offset)?;
        let previous = match read_u8(data, &mut offset)? {
            0 => None,
            1 => {
                let set = PublisherSet::decode(data, &mut offset)?;
                let until_ms = read_u64(data, &mut offset)?;
                Some(PreviousSet { set, until_ms })
            }
            _ => return None,
        };
        if offset != data.len() {
            return None;
        }
        let value = Self { network_id, governance_nonce, governance_flags, min_rotation_interval_s, current, previous };
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
        out.extend_from_slice(&self.min_rotation_interval_s.to_le_bytes());
        self.current.encode(&mut out);
        match &self.previous {
            None => out.push(0),
            Some(previous) => {
                out.push(1);
                previous.set.encode(&mut out);
                out.extend_from_slice(&previous.until_ms.to_le_bytes());
            }
        }
        out
    }

    pub fn validate(&self) -> bool {
        if !self.current.validate() || self.min_rotation_interval_s == 0 {
            return false;
        }
        if self.governance_flags & !(GOVERNANCE_LOCKED | GOVERNANCE_PAUSED) != 0 {
            return false;
        }
        if let Some(previous) = &self.previous {
            if !previous.set.validate() || previous.until_ms == 0 || previous.set.set_index.checked_add(1) != Some(self.current.set_index) {
                return false;
            }
        }
        true
    }

    pub fn is_paused(&self) -> bool {
        self.governance_flags & GOVERNANCE_PAUSED != 0
    }

    pub fn state_hash(&self) -> [u8; 32] {
        ckb_hash(&[DOMAIN_SET_STATE, &self.to_bytes()])
    }

    /// Digest the current quorum signs to move from `self` to `next`. Bound to one committee cell
    /// (`committee` = its type script hash), so an authorization cannot be replayed on another
    /// committee with identical state.
    pub fn update_hash(&self, committee: &[u8; 32], next: &Self, operation: u8) -> [u8; 32] {
        ckb_hash(&[DOMAIN_SET_UPDATE, committee, &[operation], &self.state_hash(), &next.state_hash()])
    }

    /// Digest every key of a new set signs to prove possession, bound to one committee cell.
    pub fn pop_hash(&self, committee: &[u8; 32]) -> [u8; 32] {
        ckb_hash(&[DOMAIN_SET_POP, committee, &self.state_hash()])
    }

    /// The set that may have signed an update with `set_index` at tick `publish_time_ms`:
    /// the current set, or the previous set for ticks before its `until_ms`.
    pub fn set_for(&self, set_index: u32, publish_time_ms: u64) -> Option<&PublisherSet> {
        if set_index == self.current.set_index {
            return Some(&self.current);
        }
        match &self.previous {
            Some(previous) if previous.set.set_index == set_index && publish_time_ms < previous.until_ms => Some(&previous.set),
            _ => None,
        }
    }

    /// Whether prices signed by `set_index` are still trusted (current, or a non-revoked previous).
    pub fn trusts(&self, set_index: u32) -> bool {
        set_index == self.current.set_index || self.previous.as_ref().map_or(false, |p| p.set.set_index == set_index)
    }

    /// Check that `next` is exactly what `operation` produces from `self`. Signatures, proof of
    /// possession and the rotation interval are checked by the type script.
    pub fn check_transition(&self, next: &Self, operation: u8) -> Result<(), TransitionError> {
        if next.network_id != self.network_id
            || self.governance_nonce.checked_add(1) != Some(next.governance_nonce)
            || next.min_rotation_interval_s != self.min_rotation_interval_s
            || (self.governance_flags & GOVERNANCE_LOCKED != 0 && next.governance_flags & GOVERNANCE_LOCKED == 0)
        {
            return Err(TransitionError::Continuity);
        }
        let same_flags = next.governance_flags == self.governance_flags;
        let same_sets = next.current == self.current && next.previous == self.previous;
        let next_index = self.current.set_index.checked_add(1);
        let ok = match operation {
            OP_ROTATE => {
                same_flags
                    && Some(next.current.set_index) == next_index
                    && match &next.previous {
                        Some(previous) => {
                            previous.set == self.current
                                && self.previous.as_ref().map_or(true, |old| previous.until_ms > old.until_ms)
                        }
                        None => false,
                    }
            }
            OP_ROTATE_REVOKE => same_flags && Some(next.current.set_index) == next_index && next.previous.is_none(),
            OP_PAUSE => !self.is_paused() && next.governance_flags == self.governance_flags | GOVERNANCE_PAUSED && same_sets,
            OP_UNPAUSE => self.is_paused() && next.governance_flags == self.governance_flags & !GOVERNANCE_PAUSED && same_sets,
            OP_REVOKE_PREVIOUS => {
                same_flags && self.previous.is_some() && next.previous.is_none() && next.current == self.current
            }
            _ => false,
        };
        if ok { Ok(()) } else { Err(TransitionError::Operation) }
    }

    /// Operations that change the key set need proof of possession from every new key.
    pub fn needs_pop(operation: u8) -> bool {
        matches!(operation, OP_ROTATE | OP_ROTATE_REVOKE)
    }

    /// Only a routine rotation must wait `min_rotation_interval_s`: it is the operation that keeps an
    /// older set verifying, and at most one previous set is ever kept.
    pub fn needs_interval(operation: u8) -> bool {
        operation == OP_ROTATE
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

    const COMMITTEE: [u8; 32] = [0xcc; 32];

    fn key(prefix: u8, byte: u8) -> [u8; 33] {
        let mut out = [byte; 33];
        out[0] = prefix;
        out
    }

    fn set(index: u32, bytes: &[u8]) -> PublisherSet {
        PublisherSet { set_index: index, pubkeys: bytes.iter().map(|b| key(2, *b)).collect() }
    }

    fn genesis() -> PublisherSetData {
        PublisherSetData {
            network_id: [0xaa; 32],
            governance_nonce: 0,
            governance_flags: 0,
            min_rotation_interval_s: 86_400,
            current: set(0, &[0x11]),
            previous: None,
        }
    }

    fn rotated(from: &PublisherSetData, keys: &[u8], until_ms: u64) -> PublisherSetData {
        PublisherSetData {
            governance_nonce: from.governance_nonce + 1,
            current: set(from.current.set_index + 1, keys),
            previous: Some(PreviousSet { set: from.current.clone(), until_ms }),
            ..from.clone()
        }
    }

    #[test]
    fn round_trips_and_rejects_bad_encodings() {
        let old = genesis();
        let bytes = old.to_bytes();
        assert_eq!(bytes.len(), 4 + 1 + 32 + 8 + 2 + 8 + 5 + 33 + 1);
        assert_eq!(PublisherSetData::from_bytes(&bytes), Some(old.clone()));

        let next = rotated(&old, &[0x22, 0x33, 0x44], 1_000);
        assert_eq!(PublisherSetData::from_bytes(&next.to_bytes()), Some(next.clone()));

        let mut wrong_version = bytes.clone();
        wrong_version[4] = 1;
        assert_eq!(PublisherSetData::from_bytes(&wrong_version), None);
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert_eq!(PublisherSetData::from_bytes(&trailing), None);
        let mut bad_marker = bytes.clone();
        *bad_marker.last_mut().unwrap() = 2;
        assert_eq!(PublisherSetData::from_bytes(&bad_marker), None);

        let zero_interval = PublisherSetData { min_rotation_interval_s: 0, ..old.clone() };
        assert_eq!(PublisherSetData::from_bytes(&zero_interval.to_bytes()), None);
        let unknown_flag = PublisherSetData { governance_flags: 0x04, ..old.clone() };
        assert_eq!(PublisherSetData::from_bytes(&unknown_flag.to_bytes()), None);
        let gap = PublisherSetData { previous: Some(PreviousSet { set: set(5, &[0x11]), until_ms: 1 }), ..next.clone() };
        assert_eq!(PublisherSetData::from_bytes(&gap.to_bytes()), None);
        let zero_until = PublisherSetData { previous: Some(PreviousSet { set: old.current.clone(), until_ms: 0 }), ..next };
        assert_eq!(PublisherSetData::from_bytes(&zero_until.to_bytes()), None);
    }

    #[test]
    fn quorum_is_derived_for_every_supported_publisher_count() {
        let expected = [1, 2, 3, 3, 4, 5, 5, 6, 7];
        for (index, quorum) in expected.iter().enumerate() {
            let s = PublisherSet { set_index: 0, pubkeys: (1..=index + 1).map(|b| key(2, b as u8)).collect() };
            assert!(s.validate());
            assert_eq!(s.quorum(), *quorum);
        }
        assert!(!PublisherSet { set_index: 0, pubkeys: Vec::new() }.validate());
        assert!(!PublisherSet { set_index: 0, pubkeys: (1..=MAX_PUBLISHERS + 1).map(|b| key(2, b as u8)).collect() }.validate());
    }

    #[test]
    fn previous_set_verifies_only_before_the_switch_and_until_revoked() {
        let old = genesis();
        let next = rotated(&old, &[0x22], 1_000);
        assert_eq!(next.set_for(1, 5_000), Some(&next.current));
        assert_eq!(next.set_for(0, 999), Some(&old.current));
        assert_eq!(next.set_for(0, 1_000), None);
        assert_eq!(next.set_for(7, 1), None);
        assert!(next.trusts(0) && next.trusts(1) && !next.trusts(2));

        let revoked = PublisherSetData { governance_nonce: 2, previous: None, ..next.clone() };
        assert_eq!(next.check_transition(&revoked, OP_REVOKE_PREVIOUS), Ok(()));
        assert_eq!(revoked.set_for(0, 999), None);
        assert!(!revoked.trusts(0));

        // A second routine rotation replaces the previous set; the oldest set stops verifying.
        let third = rotated(&next, &[0x33], 2_000);
        assert_eq!(next.check_transition(&third, OP_ROTATE), Ok(()));
        assert_eq!(third.set_for(0, 10), None);
        assert_eq!(third.set_for(1, 1_500), Some(&next.current));
    }

    #[test]
    fn transitions_follow_their_operation() {
        let old = genesis();
        let next = rotated(&old, &[0x22], 1_000);
        assert_eq!(old.check_transition(&next, OP_ROTATE), Ok(()));
        assert_eq!(old.check_transition(&next, OP_ROTATE_REVOKE), Err(TransitionError::Operation));
        let revoke = PublisherSetData { previous: None, ..next.clone() };
        assert_eq!(old.check_transition(&revoke, OP_ROTATE_REVOKE), Ok(()));
        assert_eq!(old.check_transition(&revoke, OP_ROTATE), Err(TransitionError::Operation));

        // Rotation must not move the switch tick backwards or skip a set index.
        let backwards = rotated(&next, &[0x33], 500);
        assert_eq!(next.check_transition(&backwards, OP_ROTATE), Err(TransitionError::Operation));
        let skip = PublisherSetData { current: set(3, &[0x33]), ..rotated(&next, &[0x33], 2_000) };
        assert_eq!(next.check_transition(&skip, OP_ROTATE), Err(TransitionError::Operation));

        let paused = PublisherSetData { governance_nonce: 1, governance_flags: GOVERNANCE_PAUSED, ..old.clone() };
        assert_eq!(old.check_transition(&paused, OP_PAUSE), Ok(()));
        assert_eq!(paused.check_transition(&PublisherSetData { governance_nonce: 2, ..paused.clone() }, OP_PAUSE), Err(TransitionError::Operation));
        let resumed = PublisherSetData { governance_nonce: 2, governance_flags: 0, ..paused.clone() };
        assert_eq!(paused.check_transition(&resumed, OP_UNPAUSE), Ok(()));
        assert_eq!(old.check_transition(&PublisherSetData { governance_nonce: 1, ..old.clone() }, OP_UNPAUSE), Err(TransitionError::Operation));
        // Pausing may not change keys.
        let sneaky = PublisherSetData { current: set(0, &[0x99]), ..paused.clone() };
        assert_eq!(old.check_transition(&sneaky, OP_PAUSE), Err(TransitionError::Operation));
        // Revoking needs a previous set.
        assert_eq!(old.check_transition(&PublisherSetData { governance_nonce: 1, ..old.clone() }, OP_REVOKE_PREVIOUS), Err(TransitionError::Operation));
        assert_eq!(old.check_transition(&next, 9), Err(TransitionError::Operation));
    }

    #[test]
    fn continuity_is_enforced_for_every_operation() {
        let old = PublisherSetData { governance_flags: GOVERNANCE_LOCKED, ..genesis() };
        let next = rotated(&old, &[0x22], 1_000);
        assert_eq!(old.check_transition(&next, OP_ROTATE), Ok(()));
        for broken in [
            PublisherSetData { governance_nonce: 5, ..next.clone() },
            PublisherSetData { network_id: [0xbb; 32], ..next.clone() },
            PublisherSetData { min_rotation_interval_s: 1, ..next.clone() },
            PublisherSetData { governance_flags: 0, ..next.clone() },
        ] {
            assert_eq!(old.check_transition(&broken, OP_ROTATE), Err(TransitionError::Continuity));
        }
    }

    #[test]
    fn governance_digests_are_bound_to_one_committee() {
        let old = genesis();
        let next = rotated(&old, &[0x22], 1_000);
        let other = [0xdd; 32];
        assert_ne!(old.update_hash(&COMMITTEE, &next, OP_ROTATE), old.update_hash(&other, &next, OP_ROTATE));
        assert_ne!(old.update_hash(&COMMITTEE, &next, OP_ROTATE), old.update_hash(&COMMITTEE, &next, OP_ROTATE_REVOKE));
        assert_ne!(next.pop_hash(&COMMITTEE), next.pop_hash(&other));
        assert!(PublisherSetData::needs_pop(OP_ROTATE) && PublisherSetData::needs_pop(OP_ROTATE_REVOKE));
        assert!(!PublisherSetData::needs_pop(OP_PAUSE) && !PublisherSetData::needs_pop(OP_REVOKE_PREVIOUS));
        assert!(PublisherSetData::needs_interval(OP_ROTATE));
        assert!(!PublisherSetData::needs_interval(OP_ROTATE_REVOKE) && !PublisherSetData::needs_interval(OP_PAUSE));
    }
}
