//! Price feed type script (docs/oracle-design.md section 7). Mirrors lean-oracle's `oracle_script`.
//!
//! `args = feed_id (32) || type_id (32)`.
//!
//! - Create (0 → 1): data is configuration only (price/time fields zero), `args[32..]` is the
//!   Type ID seed of this output, and the anchored PublisherSet dep is present and valid.
//! - Update (1 → 1): configuration unchanged, `publish_time_ms` strictly increases, and the
//!   output equals a price update authenticated by the committee (current set, or the previous set
//!   for ticks before its switch).
//!
//! Several feed cells of one committee may move in one transaction and share one verification:
//! the **leader** is the lowest-index input that is an updating feed cell (same code, same
//! committee, with a continuing output). Its witness carries the only update blob. The leader checks
//! the committee's signatures once; every feed cell (leader included) takes its own entry and Merkle
//! proof from that same blob. A cell being burned is never a leader, and a feed whose entry is not
//! in the leader's blob fails, so one transaction uses exactly one signed header per committee.
//! - Burn (1 → 0): the lock alone decides.

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
    error::SysError,
    high_level::{load_cell_data, load_cell_type, load_cell_type_hash, load_input, load_script, load_witness_args, QueryIter},
};
use ckb_std::ckb_types::packed::Script;
use lean_oracle_common::{
    errors::*,
    price_feed::PriceFeedData,
    price_update::{find_entry, verify_header, PriceUpdateBlob, VerifiedPrice, VerifyError},
    protocol_hash::type_id_seed,
    publisher_set::PublisherSetData,
};

pub fn program_entry() -> i8 {
    let script = match load_script() { Ok(value) => value, Err(_) => return ERROR_SYSCALL };
    let args = script.args().raw_data();
    if args.len() != 64 {
        return ERROR_ENCODING;
    }
    let mut feed_id = [0u8; 32];
    feed_id.copy_from_slice(&args[..32]);

    let inputs = QueryIter::new(load_cell_data, Source::GroupInput).count();
    let outputs = QueryIter::new(load_cell_data, Source::GroupOutput).count();
    match (inputs, outputs) {
        (0, 1) => validate_create(&feed_id, &args[32..]),
        (1, 1) => validate_update(&feed_id),
        (1, 0) => 0,
        _ => ERROR_INVALID_SCRIPT_GROUP,
    }
}

fn validate_create(feed_id: &[u8; 32], type_id: &[u8]) -> i8 {
    let state = match load_cell_data(0, Source::GroupOutput).ok().and_then(|data| PriceFeedData::from_bytes(&data)) {
        Some(value) => value,
        None => return ERROR_FEED_DATA_MALFORMED,
    };
    if &state.feed_id != feed_id {
        return ERROR_FEED_ID_MISMATCH;
    }
    if !state.is_uninitialized() {
        return ERROR_FEED_CREATION_NONZERO;
    }
    if let Err(code) = load_publisher_set(&state.publisher_set_type_hash) {
        return code;
    }
    validate_type_id(type_id)
}

fn validate_update(feed_id: &[u8; 32]) -> i8 {
    let old = match load_cell_data(0, Source::GroupInput).ok().and_then(|data| PriceFeedData::from_bytes(&data)) {
        Some(value) => value,
        None => return ERROR_FEED_DATA_MALFORMED,
    };
    let new = match load_cell_data(0, Source::GroupOutput).ok().and_then(|data| PriceFeedData::from_bytes(&data)) {
        Some(value) => value,
        None => return ERROR_FEED_DATA_MALFORMED,
    };
    if &new.feed_id != feed_id {
        return ERROR_FEED_ID_MISMATCH;
    }
    if !old.static_fields_unchanged(&new) {
        return ERROR_CONFIG_MUTATED;
    }
    if new.publish_time_ms <= old.publish_time_ms {
        return ERROR_FEED_NOT_FORWARD;
    }
    let script = match load_script() { Ok(value) => value, Err(_) => return ERROR_SYSCALL };
    let (leader, is_self) = match find_leader(&script, &new.publisher_set_type_hash) { Ok(value) => value, Err(code) => return code };
    let blob = match load_update_blob(leader) { Ok(value) => value, Err(code) => return code };
    let update = match PriceUpdateBlob::from_bytes(&blob) { Some(value) => value, None => return ERROR_UPDATE_MALFORMED };
    if is_self {
        let publisher_set = match load_publisher_set(&new.publisher_set_type_hash) { Ok(value) => value, Err(code) => return code };
        if let Err(error) = verify_header(&update.header, &update.signatures, &new.publisher_set_type_hash, &publisher_set) {
            return verify_error_code(error);
        }
    } else if update.header.publisher_set_type_hash != new.publisher_set_type_hash {
        return ERROR_UPDATE_SET;
    }
    let message = match find_entry(&update, feed_id) { Ok(value) => value, Err(error) => return verify_error_code(error) };
    if !new.matches(&VerifiedPrice { header: update.header, message }) {
        return ERROR_UPDATE_MISMATCH;
    }
    0
}

fn verify_error_code(error: VerifyError) -> i8 {
    match error {
        VerifyError::Malformed => ERROR_UPDATE_MALFORMED,
        VerifyError::FeedNotFound | VerifyError::DuplicateFeed => ERROR_UPDATE_FEED_NOT_FOUND,
        VerifyError::Proof => ERROR_UPDATE_PROOF,
        VerifyError::PublisherSet | VerifyError::Paused | VerifyError::SetIndex => ERROR_UPDATE_SET,
        VerifyError::Signature => ERROR_UPDATE_SIGNATURE,
    }
}

/// The leader for this committee in this transaction: the lowest-index input whose type script has
/// this script's code, whose data names the same committee, and which continues as an output (an
/// update, not a burn). Returns its input index and whether it is this cell.
fn find_leader(script: &Script, committee: &[u8; 32]) -> Result<(usize, bool), i8> {
    let mut index = 0usize;
    loop {
        match load_cell_type(index, Source::Input) {
            Ok(Some(candidate)) if candidate.code_hash().as_slice() == script.code_hash().as_slice()
                && candidate.hash_type().as_slice() == script.hash_type().as_slice() =>
            {
                let same_committee = load_cell_data(index, Source::Input)
                    .ok()
                    .and_then(|data| PriceFeedData::from_bytes(&data))
                    .map_or(false, |feed| &feed.publisher_set_type_hash == committee);
                if same_committee && continues(&candidate)? {
                    return Ok((index, candidate.as_slice() == script.as_slice()));
                }
            }
            Ok(_) => {}
            Err(SysError::IndexOutOfBound) => return Err(ERROR_FEED_LEADER),
            Err(_) => return Err(ERROR_SYSCALL),
        }
        index += 1;
    }
}

/// Whether an output carries exactly this type script (Type ID args make it unique).
fn continues(candidate: &Script) -> Result<bool, i8> {
    let mut index = 0usize;
    loop {
        match load_cell_type(index, Source::Output) {
            Ok(Some(output)) if output.as_slice() == candidate.as_slice() => return Ok(true),
            Ok(_) => {}
            Err(SysError::IndexOutOfBound) => return Ok(false),
            Err(_) => return Err(ERROR_SYSCALL),
        }
        index += 1;
    }
}

/// Witness: `WitnessArgs.input_type` of the leader's input = `update_len u32 LE | update blob`.
fn load_update_blob(leader: usize) -> Result<alloc::vec::Vec<u8>, i8> {
    let args = load_witness_args(leader, Source::Input).map_err(|_| ERROR_FEED_WITNESS_MALFORMED)?;
    let bytes = args.input_type().to_opt().ok_or(ERROR_FEED_WITNESS_MALFORMED)?.raw_data();
    if bytes.len() < 4 {
        return Err(ERROR_FEED_WITNESS_MALFORMED);
    }
    let len = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    if bytes.len() - 4 != len {
        return Err(ERROR_FEED_WITNESS_MALFORMED);
    }
    Ok(bytes[4..].to_vec())
}

fn load_publisher_set(expected: &[u8; 32]) -> Result<PublisherSetData, i8> {
    let mut found: Option<usize> = None;
    let mut index = 0usize;
    loop {
        match load_cell_type_hash(index, Source::CellDep) {
            Ok(Some(hash)) if &hash == expected => {
                if found.is_some() {
                    return Err(ERROR_FEED_SET_DEP);
                }
                found = Some(index);
            }
            Ok(_) => {}
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(ERROR_SYSCALL),
        }
        index += 1;
    }
    let data = load_cell_data(found.ok_or(ERROR_FEED_SET_DEP)?, Source::CellDep).map_err(|_| ERROR_SYSCALL)?;
    PublisherSetData::from_bytes(&data).ok_or(ERROR_PUBLISHER_SET_MALFORMED)
}

fn validate_type_id(type_id: &[u8]) -> i8 {
    let script = match load_script() { Ok(value) => value, Err(_) => return ERROR_SYSCALL };
    let first_input = match load_input(0, Source::Input) { Ok(value) => value, Err(_) => return ERROR_SYSCALL };
    let output_index = QueryIter::new(load_cell_type, Source::Output)
        .enumerate()
        .find_map(|(index, candidate)| candidate.filter(|s| s.as_slice() == script.as_slice()).map(|_| index as u64));
    match output_index {
        Some(index) if type_id_seed(first_input.as_slice(), index) == type_id => 0,
        _ => ERROR_TYPE_ID_INVALID,
    }
}
