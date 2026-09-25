//! Runs the example consumer `price_trigger_lock` through `ckb-testtool`: a lock that releases to a
//! beneficiary once a Lean Oracle price crosses a strike, or back to the owner at any time.

use ckb_testtool::{
    ckb_error::Error,
    ckb_types::{
        bytes::Bytes,
        core::{HeaderBuilder, ScriptHashType, TransactionBuilder},
        packed::{Byte32, CellDep, CellInput, CellOutput, OutPoint, Script},
        prelude::*,
    },
    context::Context,
};
use lean_oracle_common::price_feed::PriceFeedData;

use crate::fixtures::btc;

const MAX_CYCLES: u64 = 10_000_000;
const LOCKED: u64 = 500_00000000;
const CREATED_AT: u64 = 1_700_000_000_000;
const COMMITTEE: [u8; 32] = [0xc0; 32];

struct Env {
    context: Context,
    lock_code: OutPoint,
    always: OutPoint,
    owner: Script,
    beneficiary: Script,
    keeper: Script,
    feed_type: Script,
}

struct Order {
    strike: i64,
    expo: i32,
    at_or_below: bool,
}

impl Env {
    fn new() -> Self {
        let mut context = Context::default();
        let binary = std::fs::read("../target/riscv64imac-unknown-none-elf/release/price_trigger_lock")
            .expect("build contracts first: scripts/build-contracts.sh");
        let lock_code = context.deploy_cell(binary.into());
        let always = context.deploy_cell(Bytes::from(ckb_testtool::builtin::ALWAYS_SUCCESS.to_vec()));
        let owner = context.build_script(&always, Bytes::from_static(b"owner")).unwrap();
        let beneficiary = context.build_script(&always, Bytes::from_static(b"beneficiary")).unwrap();
        let keeper = context.build_script(&always, Bytes::from_static(b"keeper")).unwrap();
        // Only the feed cell's type hash matters to the lock (its own script does not run as a dep).
        let feed_type = context.build_script(&always, Bytes::from_static(b"btc-feed-cell")).unwrap();
        Self { context, lock_code, always, owner, beneficiary, keeper, feed_type }
    }

    fn lock(&mut self, order: &Order) -> Script {
        let hash = |s: &Script| -> [u8; 32] { s.calc_script_hash().unpack() };
        let mut args = hash(&self.feed_type).to_vec();
        args.extend_from_slice(&COMMITTEE);
        args.extend_from_slice(&btc());
        args.extend_from_slice(&order.strike.to_le_bytes());
        args.extend_from_slice(&order.expo.to_le_bytes());
        args.push(order.at_or_below as u8);
        args.extend_from_slice(&hash(&self.owner));
        args.extend_from_slice(&hash(&self.beneficiary));
        self.context.build_script_with_hash_type(&self.lock_code, ScriptHashType::Data2, Bytes::from(args)).unwrap()
    }

    /// A locked cell created in a block with timestamp `CREATED_AT`; returns it and that block's hash.
    fn locked_cell(&mut self, order: &Order) -> (OutPoint, Byte32) {
        let lock = self.lock(order);
        let cell = self.context.create_cell(CellOutput::new_builder().capacity(LOCKED).lock(lock).build(), Bytes::new());
        let header = HeaderBuilder::default().timestamp(CREATED_AT).number(0u64).compact_target(0x1e083126u32).build();
        self.context.insert_header(header.clone());
        self.context.link_cell_with_block(cell.clone(), header.hash(), 0);
        (cell, header.hash())
    }

    fn feed_dep(&mut self, feed: &PriceFeedData) -> CellDep {
        let cell = self.context.create_cell(
            CellOutput::new_builder().capacity(300_00000000u64).lock(self.keeper.clone()).type_(Some(self.feed_type.clone()).pack()).build(),
            Bytes::from(feed.to_bytes()),
        );
        CellDep::new_builder().out_point(cell).build()
    }

    fn input_with(&mut self, lock: Script) -> CellInput {
        let cell = self.context.create_cell(CellOutput::new_builder().capacity(100_00000000u64).lock(lock).build(), Bytes::new());
        CellInput::new_builder().previous_output(cell).build()
    }

    /// Keeper transaction: spend the locked cell, pay `pay` to the beneficiary.
    fn trigger(&mut self, order: &Order, feed: Option<&PriceFeedData>, with_header: bool, pay: u64) -> Result<u64, Error> {
        let (cell, block) = self.locked_cell(order);
        let mut deps = vec![
            CellDep::new_builder().out_point(self.lock_code.clone()).build(),
            CellDep::new_builder().out_point(self.always.clone()).build(),
        ];
        if let Some(feed) = feed {
            deps.push(self.feed_dep(feed));
        }
        let fee_input = self.input_with(self.keeper.clone());
        let mut tx = TransactionBuilder::default()
            .cell_deps(deps)
            .input(CellInput::new_builder().previous_output(cell).build())
            .input(fee_input)
            .output(CellOutput::new_builder().capacity(pay).lock(self.beneficiary.clone()).build())
            .output_data(Bytes::new().pack());
        if with_header {
            tx = tx.header_dep(block);
        }
        let tx = self.context.complete_tx(tx.build());
        self.context.verify_tx(&tx, MAX_CYCLES)
    }
}

/// BTC/USDT 84,359.375 (expo -8), published `after_ms` after the locked cell's block.
fn btc_feed(after_ms: i64) -> PriceFeedData {
    PriceFeedData {
        feed_id: btc(),
        publisher_set_type_hash: COMMITTEE,
        price: 8_435_937_500_000,
        conf: 1_000_000,
        expo: -8,
        publish_time_ms: (CREATED_AT as i64 + after_ms) as u64,
        num_publishers: 1,
        ..Default::default()
    }
}

const ABOVE_80K: Order = Order { strike: 8_000_000_000_000, expo: -8, at_or_below: false };

fn assert_code(result: Result<u64, Error>, code: i8) {
    let error = result.expect_err("transaction should fail").to_string();
    assert!(error.contains(&format!("error code {code} ")), "expected error code {code}, got: {error}");
}

#[test]
fn keeper_releases_to_beneficiary_when_price_crosses() {
    let mut env = Env::new();
    let cycles = env.trigger(&ABOVE_80K, Some(&btc_feed(1_000)), true, LOCKED).expect("trigger");
    println!("price_trigger_lock trigger: {cycles} cycles");
}

#[test]
fn condition_direction_and_exponent() {
    let mut env = Env::new();
    assert_code(env.trigger(&Order { strike: 9_000_000_000_000, ..ABOVE_80K }, Some(&btc_feed(1_000)), true, LOCKED), 108);
    // ≤ 90,000.00 with the strike at expo -2 (rescaled from the feed's -8).
    env.trigger(&Order { strike: 9_000_000, expo: -2, at_or_below: true }, Some(&btc_feed(1_000)), true, LOCKED).expect("stop triggers");
    assert_code(env.trigger(&Order { strike: 8_000_000, expo: -2, at_or_below: true }, Some(&btc_feed(1_000)), true, LOCKED), 108);
}

#[test]
fn price_must_be_published_after_the_cell_was_created() {
    let mut env = Env::new();
    assert_code(env.trigger(&ABOVE_80K, Some(&btc_feed(0)), true, LOCKED), 106);
    assert_code(env.trigger(&ABOVE_80K, Some(&btc_feed(-60_000)), true, LOCKED), 106);
    assert_code(env.trigger(&ABOVE_80K, Some(&btc_feed(1_000)), false, LOCKED), 107);
}

#[test]
fn feed_cell_is_checked() {
    let mut env = Env::new();
    assert_code(env.trigger(&ABOVE_80K, None, true, LOCKED), 101);
    assert_code(env.trigger(&ABOVE_80K, Some(&PriceFeedData { publisher_set_type_hash: [0xee; 32], ..btc_feed(1_000) }), true, LOCKED), 104);
    assert_code(env.trigger(&ABOVE_80K, Some(&PriceFeedData { publish_time_ms: 0, ..btc_feed(1_000) }), true, LOCKED), 105);
    assert_code(env.trigger(&ABOVE_80K, Some(&PriceFeedData { feed_id: [3; 32], ..btc_feed(1_000) }), true, LOCKED), 103);
}

#[test]
fn beneficiary_must_receive_the_locked_capacity() {
    let mut env = Env::new();
    assert_code(env.trigger(&ABOVE_80K, Some(&btc_feed(1_000)), true, LOCKED - 1), 109);
}

#[test]
fn owner_can_cancel_without_a_price() {
    let mut env = Env::new();
    let (cell, _) = env.locked_cell(&ABOVE_80K);
    let owner_input = env.input_with(env.owner.clone());
    let tx = TransactionBuilder::default()
        .cell_deps(vec![
            CellDep::new_builder().out_point(env.lock_code.clone()).build(),
            CellDep::new_builder().out_point(env.always.clone()).build(),
        ])
        .input(CellInput::new_builder().previous_output(cell).build())
        .input(owner_input)
        .output(CellOutput::new_builder().capacity(LOCKED).lock(env.owner.clone()).build())
        .output_data(Bytes::new().pack())
        .build();
    let tx = env.context.complete_tx(tx);
    env.context.verify_tx(&tx, MAX_CYCLES).expect("owner cancel");
}
