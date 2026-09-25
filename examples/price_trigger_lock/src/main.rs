//! Example Lean Oracle consumer: a lock that releases funds to a beneficiary once a price crosses a
//! level (a limit order or stop in miniature), or back to the owner at any time.
//!
//! `args` (173 bytes):
//!
//! | Bytes | Field |
//! |---|---|
//! | 0..32 | feed cell type hash (the feed cell this lock trusts) |
//! | 32..64 | committee type hash the feed cell must be anchored to |
//! | 64..96 | feed id |
//! | 96..104 | strike price, i64 LE, at `expo` |
//! | 104..108 | expo, i32 LE |
//! | 108 | direction: 0 = release when price ≥ strike, 1 = when price ≤ strike |
//! | 109..141 | owner lock hash (cancel path) |
//! | 141..173 | beneficiary lock hash (trigger path) |
//!
//! Unlocks when either:
//! - **cancel:** an input is locked by the owner's lock (which checks the owner's signature); or
//! - **trigger (anyone, e.g. a keeper):**
//!   1. the pinned feed cell is a cell dep, for the right feed and committee, with an authenticated price;
//!   2. that price was published **after** every cell of this lock was created: each input's block
//!      header is a header dep, so the script can prove when the cell appeared (scripts cannot
//!      read the current time);
//!   3. the price, rescaled to `expo`, meets the strike in `direction`;
//!   4. outputs locked by the beneficiary receive at least the capacity of this lock's inputs.
//!
//! The feed cell only moves forward (price_feed_type), so an old price can never be replayed
//! against it.

#![no_std]
#![cfg_attr(not(test), no_main)]

#[cfg(test)]
extern crate alloc;

#[cfg(not(test))]
use ckb_std::default_alloc;
#[cfg(not(test))]
ckb_std::entry!(program_entry);
#[cfg(not(test))]
default_alloc!(4096, 65536, 64);

use ckb_std::{
    ckb_constants::Source,
    ckb_types::prelude::*,
    high_level::{load_cell_capacity, load_cell_data, load_cell_lock_hash, load_cell_type_hash, load_header, load_script, QueryIter},
};
use lean_oracle_common::consumer::{check_feed_cell, price_at_expo, published_after, FeedCheckError};

pub const ERROR_ARGS: i8 = 100;
pub const ERROR_FEED_DEP_MISSING: i8 = 101;
pub const ERROR_FEED_MALFORMED: i8 = 102;
pub const ERROR_FEED_WRONG_FEED: i8 = 103;
pub const ERROR_FEED_WRONG_COMMITTEE: i8 = 104;
pub const ERROR_FEED_UNINITIALIZED: i8 = 105;
pub const ERROR_PRICE_STALE: i8 = 106;
pub const ERROR_HEADER_DEP_MISSING: i8 = 107;
pub const ERROR_CONDITION_NOT_MET: i8 = 108;
pub const ERROR_BENEFICIARY_UNDERPAID: i8 = 109;
pub const ERROR_PRICE_SCALE: i8 = 110;

const ARGS_LEN: usize = 173;

struct Args {
    feed_type_hash: [u8; 32],
    committee: [u8; 32],
    feed_id: [u8; 32],
    strike: i64,
    expo: i32,
    at_or_below: bool,
    owner: [u8; 32],
    beneficiary: [u8; 32],
}

fn parse_args(a: &[u8]) -> Option<Args> {
    if a.len() != ARGS_LEN || a[108] > 1 {
        return None;
    }
    let h = |from: usize| -> [u8; 32] { a[from..from + 32].try_into().unwrap() };
    Some(Args {
        feed_type_hash: h(0),
        committee: h(32),
        feed_id: h(64),
        strike: i64::from_le_bytes(a[96..104].try_into().ok()?),
        expo: i32::from_le_bytes(a[104..108].try_into().ok()?),
        at_or_below: a[108] == 1,
        owner: h(109),
        beneficiary: h(141),
    })
}

pub fn program_entry() -> i8 {
    let args = match load_script().ok().and_then(|s| parse_args(&s.args().raw_data())) {
        Some(args) => args,
        None => return ERROR_ARGS,
    };
    // Cancel: the owner's lock is in the transaction and verifies the owner.
    if QueryIter::new(load_cell_lock_hash, Source::Input).any(|hash| hash == args.owner) {
        return 0;
    }
    match trigger(&args) {
        Ok(()) => 0,
        Err(code) => code,
    }
}

fn trigger(args: &Args) -> Result<(), i8> {
    // 1. The pinned feed cell, checked.
    let index = QueryIter::new(load_cell_type_hash, Source::CellDep)
        .position(|hash| hash == Some(args.feed_type_hash))
        .ok_or(ERROR_FEED_DEP_MISSING)?;
    let data = load_cell_data(index, Source::CellDep).map_err(|_| ERROR_FEED_DEP_MISSING)?;
    let feed = check_feed_cell(&data, &args.feed_id, &args.committee).map_err(|error| match error {
        FeedCheckError::Malformed => ERROR_FEED_MALFORMED,
        FeedCheckError::WrongFeed => ERROR_FEED_WRONG_FEED,
        FeedCheckError::WrongCommittee => ERROR_FEED_WRONG_COMMITTEE,
        FeedCheckError::Uninitialized => ERROR_FEED_UNINITIALIZED,
        FeedCheckError::Stale => ERROR_PRICE_STALE,
    })?;

    // 2. Published after every locked cell was created (block timestamps via header deps).
    let mut created_at_ms = 0u64;
    let mut locked = 0u64;
    for i in 0.. {
        let capacity = match load_cell_capacity(i, Source::GroupInput) {
            Ok(capacity) => capacity,
            Err(_) => break,
        };
        let header = load_header(i, Source::GroupInput).map_err(|_| ERROR_HEADER_DEP_MISSING)?;
        created_at_ms = created_at_ms.max(header.raw().timestamp().unpack());
        locked = locked.checked_add(capacity).ok_or(ERROR_BENEFICIARY_UNDERPAID)?;
    }
    published_after(&feed, created_at_ms).map_err(|_| ERROR_PRICE_STALE)?;

    // 3. The condition, at the strike's exponent.
    let price = price_at_expo(&feed, args.expo).ok_or(ERROR_PRICE_SCALE)?;
    let met = if args.at_or_below { price <= args.strike } else { price >= args.strike };
    if !met {
        return Err(ERROR_CONDITION_NOT_MET);
    }

    // 4. The beneficiary is paid what was locked.
    let mut paid = 0u64;
    for i in 0.. {
        match load_cell_lock_hash(i, Source::Output) {
            Ok(hash) if hash == args.beneficiary => paid = paid.saturating_add(load_cell_capacity(i, Source::Output).map_err(|_| ERROR_BENEFICIARY_UNDERPAID)?),
            Ok(_) => {}
            Err(_) => break,
        }
    }
    if paid < locked {
        return Err(ERROR_BENEFICIARY_UNDERPAID);
    }
    Ok(())
}
