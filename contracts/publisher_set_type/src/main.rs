//! Committee cell type script (docs/oracle-design.md section 3, PublisherSet v2).
//!
//! - Create (0 → 1): nonce 0, set index 0, no previous set, valid Type ID seed.
//! - Update (1 → 1): one governance operation, authorized by the current quorum over
//!   `update_hash(committee, next, op)`; rotations also need proof of possession from every new key.
//!   A routine rotation (`OP_ROTATE`) needs the committee cell to be at least
//!   `min_rotation_interval_s` old, proven with a relative timestamp `since` on the input.
//!   The cell keeps its lock and never loses capacity, so an always-success lock is safe.
//! - Burn (1 → 0): never.
//!
//! Witness (`WitnessArgs.input_type` of the group input):
//! `operation u8 | authorization SignatureBundle | [proof of possession SignatureBundle]`.

#![no_std]
#![cfg_attr(not(test), no_main)]

#[cfg(test)]
extern crate alloc;

#[cfg(not(test))]
use ckb_std::default_alloc;
#[cfg(not(test))]
ckb_std::entry!(program_entry);
#[cfg(not(test))]
default_alloc!(16384, 1258306, 64);

use ckb_std::{
    ckb_constants::Source,
    ckb_types::prelude::*,
    high_level::{
        load_cell_capacity, load_cell_data, load_cell_lock_hash, load_cell_type, load_input, load_input_since, load_script,
        load_script_hash, load_witness_args, QueryIter,
    },
};
use lean_oracle_common::{
    errors::*,
    protocol_hash::type_id_seed,
    publisher_set::{PublisherSetData, TransitionError},
    signatures::SignatureBundle,
};

/// `since` flags: relative (bit 63) with the timestamp metric (bits 61-62 = 0b10), in seconds.
const SINCE_RELATIVE_TIMESTAMP: u64 = 0xC000_0000_0000_0000;
const SINCE_FLAGS_MASK: u64 = 0xFF00_0000_0000_0000;
const SINCE_VALUE_MASK: u64 = 0x00FF_FFFF_FFFF_FFFF;

pub fn program_entry() -> i8 {
    let inputs = QueryIter::new(load_cell_data, Source::GroupInput).count();
    let outputs = QueryIter::new(load_cell_data, Source::GroupOutput).count();
    match (inputs, outputs) {
        (0, 1) => validate_create(),
        (1, 1) => validate_update(),
        _ => ERROR_INVALID_SCRIPT_GROUP,
    }
}

fn validate_create() -> i8 {
    let state = match load_cell_data(0, Source::GroupOutput).ok().and_then(|data| PublisherSetData::from_bytes(&data)) {
        Some(value) => value,
        None => return ERROR_PUBLISHER_SET_MALFORMED,
    };
    if state.governance_nonce != 0 || state.current.set_index != 0 || state.previous.is_some() {
        return ERROR_PUBLISHER_SET_CONTINUITY;
    }
    validate_type_id_seed()
}

fn validate_update() -> i8 {
    let old = match load_cell_data(0, Source::GroupInput).ok().and_then(|data| PublisherSetData::from_bytes(&data)) {
        Some(value) => value,
        None => return ERROR_PUBLISHER_SET_MALFORMED,
    };
    let new = match load_cell_data(0, Source::GroupOutput).ok().and_then(|data| PublisherSetData::from_bytes(&data)) {
        Some(value) => value,
        None => return ERROR_PUBLISHER_SET_MALFORMED,
    };
    if let Err(code) = check_cell_continuity() {
        return code;
    }

    let witness = match update_witness() { Ok(value) => value, Err(code) => return code };
    let operation = witness[0];
    match old.check_transition(&new, operation) {
        Ok(()) => {}
        Err(TransitionError::Continuity) => return ERROR_PUBLISHER_SET_CONTINUITY,
        Err(TransitionError::Operation) => return ERROR_PUBLISHER_SET_OPERATION,
    }
    if PublisherSetData::needs_interval(operation) {
        if let Err(code) = check_interval(old.min_rotation_interval_s) {
            return code;
        }
    }

    let committee = load_script_hash().map_err(|_| ERROR_SYSCALL);
    let committee = match committee { Ok(value) => value, Err(code) => return code };
    let (authorization, used) = match SignatureBundle::parse_prefix(&witness[1..]) {
        Some(value) => value,
        None => return ERROR_ENCODING,
    };
    if !authorization.verify_threshold(&old.update_hash(&committee, &new, operation), &old.current) {
        return ERROR_PUBLISHER_SET_AUTH;
    }

    let rest = &witness[1 + used..];
    if PublisherSetData::needs_pop(operation) {
        let pop = match SignatureBundle::from_bytes(rest) {
            Some(value) => value,
            None => return ERROR_ENCODING,
        };
        if !pop.verify_all(&new.pop_hash(&committee), &new.current) {
            return ERROR_PUBLISHER_SET_POP;
        }
    } else if !rest.is_empty() {
        return ERROR_ENCODING;
    }
    0
}

/// The committee cell continues under the same lock with at least the same capacity, so an
/// always-success lock lets anyone submit a quorum-authorized operation but no one can take the
/// cell or its CKB. (Exactly one continuing output is guaranteed by the 1 → 1 group shape.)
fn check_cell_continuity() -> Result<(), i8> {
    let lock_in = load_cell_lock_hash(0, Source::GroupInput).map_err(|_| ERROR_SYSCALL)?;
    let lock_out = load_cell_lock_hash(0, Source::GroupOutput).map_err(|_| ERROR_SYSCALL)?;
    if lock_in != lock_out {
        return Err(ERROR_CONFIG_MUTATED);
    }
    let capacity_in = load_cell_capacity(0, Source::GroupInput).map_err(|_| ERROR_SYSCALL)?;
    let capacity_out = load_cell_capacity(0, Source::GroupOutput).map_err(|_| ERROR_SYSCALL)?;
    if capacity_out < capacity_in {
        return Err(ERROR_PUBLISHER_SET_CELL);
    }
    Ok(())
}

/// A relative timestamp `since` of at least `interval_s` on the committee input: the chain proves the
/// cell was created at least that long ago (the last governance operation).
fn check_interval(interval_s: u64) -> Result<(), i8> {
    let since = load_input_since(0, Source::GroupInput).map_err(|_| ERROR_SYSCALL)?;
    if since & SINCE_FLAGS_MASK != SINCE_RELATIVE_TIMESTAMP || since & SINCE_VALUE_MASK < interval_s {
        return Err(ERROR_PUBLISHER_SET_INTERVAL);
    }
    Ok(())
}

fn update_witness() -> Result<alloc::vec::Vec<u8>, i8> {
    let args = load_witness_args(0, Source::GroupInput).map_err(|_| ERROR_SYSCALL)?;
    let bytes = args.input_type().to_opt().ok_or(ERROR_ENCODING)?.raw_data();
    if bytes.is_empty() {
        return Err(ERROR_ENCODING);
    }
    Ok(bytes.to_vec())
}

fn validate_type_id_seed() -> i8 {
    let script = match load_script() { Ok(value) => value, Err(_) => return ERROR_SYSCALL };
    let args = script.args().raw_data();
    if args.len() != 32 {
        return ERROR_TYPE_ID_INVALID;
    }
    let first_input = match load_input(0, Source::Input) { Ok(value) => value, Err(_) => return ERROR_SYSCALL };
    let output_index = QueryIter::new(load_cell_type, Source::Output)
        .enumerate()
        .find_map(|(index, candidate)| candidate.filter(|s| s.as_slice() == script.as_slice()).map(|_| index as u64));
    match output_index {
        Some(index) if type_id_seed(first_input.as_slice(), index) == args.as_ref() => 0,
        _ => ERROR_TYPE_ID_INVALID,
    }
}
