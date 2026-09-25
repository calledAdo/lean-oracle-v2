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
    high_level::{load_cell_data, load_cell_lock_hash, load_cell_type, load_input, load_script, load_witness_args, QueryIter},
};
use lean_oracle_common::{
    errors::*,
    publisher_set::{PublisherSetData, GOVERNANCE_LOCKED, OP_ROTATE},
    signatures::SignatureBundle,
};

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
    if state.governance_nonce != 0 || state.current.set_index != 0 {
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
    if load_cell_lock_hash(0, Source::GroupInput).ok() != load_cell_lock_hash(0, Source::GroupOutput).ok() {
        return ERROR_CONFIG_MUTATED;
    }
    if old.network_id != new.network_id
        || old.governance_nonce.checked_add(1) != Some(new.governance_nonce)
        || old.current.set_index.checked_add(1) != Some(new.current.set_index)
        || (old.governance_flags & GOVERNANCE_LOCKED != 0 && new.governance_flags & GOVERNANCE_LOCKED == 0)
    {
        return ERROR_PUBLISHER_SET_CONTINUITY;
    }

    let witness = match update_witness() { Ok(value) => value, Err(code) => return code };
    let operation = witness[0];
    if operation != OP_ROTATE { return ERROR_PUBLISHER_SET_OPERATION; }
    let (authorization, used) = match SignatureBundle::parse_prefix(&witness[1..]) {
        Some(value) => value,
        None => return ERROR_ENCODING,
    };
    if !authorization.verify_threshold(&old.update_hash(&new, operation), &old.current) {
        return ERROR_PUBLISHER_SET_AUTH;
    }

    let pop = match SignatureBundle::from_bytes(&witness[1 + used..]) {
        Some(value) => value,
        None => return ERROR_ENCODING,
    };
    if !pop.verify_all(&new.pop_hash(), &new.current) { return ERROR_PUBLISHER_SET_POP; }
    0
}

fn update_witness() -> Result<alloc::vec::Vec<u8>, i8> {
    let args = load_witness_args(0, Source::GroupInput).map_err(|_| ERROR_SYSCALL)?;
    let bytes = args.input_type().to_opt().ok_or(ERROR_ENCODING)?.raw_data();
    if bytes.is_empty() { return Err(ERROR_ENCODING); }
    Ok(bytes.to_vec())
}

fn validate_type_id_seed() -> i8 {
    use blake2b_ref::Blake2bBuilder;
    let script = match load_script() { Ok(value) => value, Err(_) => return ERROR_SYSCALL };
    let args = script.args().raw_data();
    if args.len() != 32 { return ERROR_TYPE_ID_INVALID; }
    let first_input = match load_input(0, Source::Input) { Ok(value) => value, Err(_) => return ERROR_SYSCALL };
    let output_index = QueryIter::new(load_cell_type, Source::Output)
        .enumerate()
        .find_map(|(index, candidate)| candidate.filter(|s| s.as_slice() == script.as_slice()).map(|_| index as u64));
    let output_index = match output_index { Some(value) => value, None => return ERROR_TYPE_ID_INVALID };
    let mut hasher = Blake2bBuilder::new(32).personal(b"ckb-default-hash").build();
    hasher.update(first_input.as_slice());
    hasher.update(&output_index.to_le_bytes());
    let mut expected = [0u8; 32];
    hasher.finalize(&mut expected);
    if args.as_ref() == expected { 0 } else { ERROR_TYPE_ID_INVALID }
}
