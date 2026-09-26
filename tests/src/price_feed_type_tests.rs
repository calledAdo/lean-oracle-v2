//! Runs the compiled `price_feed_type` binary through `ckb-testtool`.
//! Build first: `cargo build --release` (RISC-V default target).

use ckb_testtool::{
    ckb_error::Error,
    ckb_types::{
        bytes::Bytes,
        core::{ScriptHashType, TransactionBuilder, TransactionView},
        packed::{CellDep, CellInput, CellOutput, OutPoint, Script, WitnessArgs},
        prelude::*,
    },
    context::Context,
};
use lean_oracle_common::{
    errors::*,
    price_feed::PriceFeedData,
    price_update::{PriceMessage, PriceUpdateBlob},
    protocol_hash::type_id_seed,
    publisher_set::{PublisherSetData, GOVERNANCE_PAUSED},
};

use crate::fixtures::*;

const MAX_CYCLES: u64 = 200_000_000;
const CAPACITY: u64 = 1_000_00000000;
const T0: u64 = 1_700_000_000_000;

struct Env {
    context: Context,
    feed_code: OutPoint,
    always: OutPoint,
    lock: Script,
    set_dep: CellDep,
    set_type_hash: [u8; 32],
    committee: Committee,
}

impl Env {
    fn new(committee: Committee) -> Self {
        Self::with_set_data(committee, None)
    }

    fn with_set_data(committee: Committee, data: Option<PublisherSetData>) -> Self {
        let mut context = Context::default();
        let binary = std::fs::read("../target/riscv64imac-unknown-none-elf/release/price_feed_type")
            .expect("build contracts first: cargo build --release");
        let feed_code = context.deploy_cell(binary.into());
        let always = context.deploy_cell(Bytes::from(ckb_testtool::builtin::ALWAYS_SUCCESS.to_vec()));
        let lock = context.build_script(&always, Bytes::from_static(b"owner")).unwrap();
        // The feed contract only needs a cell dep whose type hash matches and whose data decodes.
        let set_type = context.build_script(&always, Bytes::from_static(b"committee")).unwrap();
        let set_type_hash: [u8; 32] = set_type.calc_script_hash().unpack();
        let set_cell = context.create_cell(
            CellOutput::new_builder().capacity(CAPACITY).lock(lock.clone()).type_(Some(set_type).pack()).build(),
            Bytes::from(data.unwrap_or_else(|| committee.data.clone()).to_bytes()),
        );
        let set_dep = CellDep::new_builder().out_point(set_cell).build();
        Self { context, feed_code, always, lock, set_dep, set_type_hash, committee }
    }

    fn feed_type(&mut self, feed: [u8; 32], type_id: [u8; 32]) -> Script {
        let mut args = feed.to_vec();
        args.extend_from_slice(&type_id);
        self.context
            .build_script_with_hash_type(&self.feed_code, ScriptHashType::Data2, Bytes::from(args))
            .unwrap()
    }

    fn funding_input(&mut self) -> CellInput {
        let cell = self.context.create_cell(
            CellOutput::new_builder().capacity(CAPACITY).lock(self.lock.clone()).build(),
            Bytes::new(),
        );
        CellInput::new_builder().previous_output(cell).build()
    }

    fn deps(&self) -> Vec<CellDep> {
        vec![
            CellDep::new_builder().out_point(self.feed_code.clone()).build(),
            CellDep::new_builder().out_point(self.always.clone()).build(),
        ]
    }

    fn uninitialized(&self) -> PriceFeedData {
        PriceFeedData { feed_id: btc(), publisher_set_type_hash: self.set_type_hash, ..Default::default() }
    }

    /// Create transaction for a fresh feed cell; `mutate` may corrupt it for negative tests.
    fn create_tx(&mut self, data: PriceFeedData, type_id_override: Option<[u8; 32]>, with_set_dep: bool) -> TransactionView {
        let input = self.funding_input();
        let type_id = type_id_override.unwrap_or_else(|| type_id_seed(input.as_slice(), 0));
        let feed_type = self.feed_type(data.feed_id, type_id);
        let mut deps = self.deps();
        if with_set_dep {
            deps.push(self.set_dep.clone());
        }
        let tx = TransactionBuilder::default()
            .cell_deps(deps)
            .input(input)
            .output(CellOutput::new_builder().capacity(CAPACITY / 2).lock(self.lock.clone()).type_(Some(feed_type).pack()).build())
            .output_data(Bytes::from(data.to_bytes()).pack())
            .build();
        self.context.complete_tx(tx)
    }

    /// A live feed cell holding `data`, as if created and updated earlier.
    fn live_feed(&mut self, data: &PriceFeedData) -> (OutPoint, Script) {
        let feed_type = self.feed_type(data.feed_id, [0x7d; 32]);
        let cell = self.context.create_cell(
            CellOutput::new_builder().capacity(CAPACITY / 2).lock(self.lock.clone()).type_(Some(feed_type.clone()).pack()).build(),
            Bytes::from(data.to_bytes()),
        );
        (cell, feed_type)
    }

    fn update_tx(&mut self, old: &PriceFeedData, new: &PriceFeedData, blob: &[u8], extra_deps: Vec<CellDep>) -> TransactionView {
        let (cell, feed_type) = self.live_feed(old);
        let mut witness = (blob.len() as u32).to_le_bytes().to_vec();
        witness.extend_from_slice(blob);
        let witness = WitnessArgs::new_builder().input_type(Some(Bytes::from(witness)).pack()).build();
        let mut deps = self.deps();
        deps.push(self.set_dep.clone());
        deps.extend(extra_deps);
        let tx = TransactionBuilder::default()
            .cell_deps(deps)
            .input(CellInput::new_builder().previous_output(cell).build())
            .output(CellOutput::new_builder().capacity(CAPACITY / 2).lock(self.lock.clone()).type_(Some(feed_type).pack()).build())
            .output_data(Bytes::from(new.to_bytes()).pack())
            .witness(witness.as_bytes().pack())
            .build();
        self.context.complete_tx(tx)
    }

    fn verify(&self, tx: &TransactionView) -> Result<u64, Error> {
        self.context.verify_tx(tx, MAX_CYCLES)
    }

    fn signed(&self, time: u64, messages: Vec<PriceMessage>, indexes: &[usize]) -> Vec<u8> {
        signed_update(&self.committee, self.set_type_hash, time, messages, indexes).to_bytes()
    }
}

/// The feed-cell data a correct update to `blob` must produce.
fn applied(base: &PriceFeedData, blob: &[u8]) -> PriceFeedData {
    let blob = PriceUpdateBlob::from_bytes(blob).unwrap();
    let entry = blob.entries.iter().find(|e| e.message_bytes[1..33] == base.feed_id).unwrap();
    let m = PriceMessage::from_bytes(&entry.message_bytes).unwrap();
    PriceFeedData {
        price: m.price,
        conf: m.conf,
        expo: m.expo,
        publish_time_ms: blob.header.publish_time_ms,
        prev_publish_time_ms: m.prev_publish_time_ms,
        ema_price: m.ema_price,
        ema_conf: m.ema_conf,
        source_time_ms: m.source_time_ms,
        num_publishers: m.num_publishers,
        set_index: blob.header.set_index,
        ..base.clone()
    }
}

fn assert_script_error(result: Result<u64, Error>, code: i8) {
    let error = result.expect_err("transaction should fail").to_string();
    assert!(error.contains(&format!("error code {code} ")), "expected error code {code}, got: {error}");
}

fn eth() -> [u8; 32] {
    lean_oracle_common::protocol_hash::feed_id(b"Crypto.ETH/USD")
}

#[test]
fn create_accepts_uninitialized_type_id_cell() {
    let mut env = Env::new(Committee::new(4, 0));
    let data = env.uninitialized();
    let tx = env.create_tx(data, None, true);
    env.verify(&tx).expect("create");
}

#[test]
fn create_rejects_nonzero_price_bad_type_id_and_missing_set() {
    let mut env = Env::new(Committee::new(4, 0));
    let mut priced = env.uninitialized();
    priced.price = 1;
    priced.publish_time_ms = 1;
    let tx = env.create_tx(priced, None, true);
    assert_script_error(env.verify(&tx), ERROR_FEED_CREATION_NONZERO);

    let data = env.uninitialized();
    let tx = env.create_tx(data.clone(), Some([0x01; 32]), true);
    assert_script_error(env.verify(&tx), ERROR_TYPE_ID_INVALID);

    let tx = env.create_tx(data, None, false);
    assert_script_error(env.verify(&tx), ERROR_FEED_SET_DEP);
}

#[test]
fn update_applies_quorum_signed_price_then_moves_only_forward() {
    let mut env = Env::new(Committee::new(4, 0));
    let quorum = env.committee.quorum_indexes();
    let base = env.uninitialized();

    let first = env.signed(T0, vec![message(btc(), 6_700_000_000_000), message(eth(), 312_000_000_000)], &quorum);
    let after_first = applied(&base, &first);
    let tx = env.update_tx(&base, &after_first, &first, vec![]);
    let cycles = env.verify(&tx).expect("first update");
    println!("price_feed_type update, quorum 3 of 4: {cycles} cycles");

    let later = env.signed(T0 + 1000, vec![message(btc(), 6_701_000_000_000), message(eth(), 312_100_000_000)], &quorum);
    let after_later = applied(&base, &later);
    let tx = env.update_tx(&after_first, &after_later, &later, vec![]);
    env.verify(&tx).expect("forward update");

    // Same tick again, and an older tick, are both rejected.
    let tx = env.update_tx(&after_later, &after_later, &later, vec![]);
    assert_script_error(env.verify(&tx), ERROR_FEED_NOT_FORWARD);
    let tx = env.update_tx(&after_later, &after_first, &first, vec![]);
    assert_script_error(env.verify(&tx), ERROR_FEED_NOT_FORWARD);
}

#[test]
fn historical_update_initializes_a_fresh_cell() {
    let mut env = Env::new(Committee::new(4, 0));
    let quorum = env.committee.quorum_indexes();
    let base = env.uninitialized();
    let old_tick = env.signed(T0 - 3_600_000, vec![message(btc(), 6_500_000_000_000)], &quorum);
    let tx = env.update_tx(&base, &applied(&base, &old_tick), &old_tick, vec![]);
    env.verify(&tx).expect("historical tick on a fresh cell is a forward update");
}

#[test]
fn update_rejects_tampered_output_under_quorum_and_config_change() {
    let mut env = Env::new(Committee::new(4, 0));
    let quorum = env.committee.quorum_indexes();
    let base = env.uninitialized();
    let blob = env.signed(T0, vec![message(btc(), 6_700_000_000_000)], &quorum);
    let good = applied(&base, &blob);

    let mut tampered = good.clone();
    tampered.price += 1;
    let tx = env.update_tx(&base, &tampered, &blob, vec![]);
    assert_script_error(env.verify(&tx), ERROR_UPDATE_MISMATCH);

    let under = env.signed(T0, vec![message(btc(), 6_700_000_000_000)], &quorum[..2]);
    let tx = env.update_tx(&base, &applied(&base, &under), &under, vec![]);
    assert_script_error(env.verify(&tx), ERROR_UPDATE_SIGNATURE);

    let mut moved = good.clone();
    moved.publisher_set_type_hash = [0x99; 32];
    let tx = env.update_tx(&base, &moved, &blob, vec![]);
    assert_script_error(env.verify(&tx), ERROR_CONFIG_MUTATED);

    let other_feed = env.signed(T0, vec![message(eth(), 312_000_000_000)], &quorum);
    let mut claimed = applied(&PriceFeedData { feed_id: eth(), ..base.clone() }, &other_feed);
    claimed.feed_id = btc();
    let tx = env.update_tx(&base, &claimed, &other_feed, vec![]);
    assert_script_error(env.verify(&tx), ERROR_UPDATE_FEED_NOT_FOUND);
}

#[test]
fn update_rejects_rotated_or_paused_committee() {
    let old_committee = Committee::new(4, 0);
    let old_blob_committee = Committee::new(4, 0);
    let mut env = Env::with_set_data(old_committee, Some(Committee::new(4, 1).data));
    let base = env.uninitialized();
    let blob = signed_update(&old_blob_committee, env.set_type_hash, T0, vec![message(btc(), 1)], &[0, 1, 2]).to_bytes();
    let tx = env.update_tx(&base, &applied(&base, &blob), &blob, vec![]);
    assert_script_error(env.verify(&tx), ERROR_UPDATE_SET);

    let mut paused = Committee::new(4, 0).data;
    paused.governance_flags = GOVERNANCE_PAUSED;
    let mut env = Env::with_set_data(Committee::new(4, 0), Some(paused));
    let base = env.uninitialized();
    let blob = env.signed(T0, vec![message(btc(), 1)], &[0, 1, 2]);
    let tx = env.update_tx(&base, &applied(&base, &blob), &blob, vec![]);
    assert_script_error(env.verify(&tx), ERROR_UPDATE_SET);
}

#[test]
fn burn_is_left_to_the_lock() {
    let mut env = Env::new(Committee::new(4, 0));
    let data = env.uninitialized();
    let (cell, _) = env.live_feed(&data);
    let deps = env.deps();
    let tx = TransactionBuilder::default()
        .cell_deps(deps)
        .input(CellInput::new_builder().previous_output(cell).build())
        .output(CellOutput::new_builder().capacity(CAPACITY / 2).lock(env.lock.clone()).build())
        .output_data(Bytes::new().pack())
        .build();
    let tx = env.context.complete_tx(tx);
    env.verify(&tx).expect("burn");
}

#[test]
fn update_cycles_for_max_committee() {
    let mut env = Env::new(Committee::new(9, 0));
    let quorum = env.committee.quorum_indexes();
    assert_eq!(quorum.len(), 7);
    let base = env.uninitialized();
    let blob = env.signed(T0, vec![message(btc(), 6_700_000_000_000)], &quorum);
    let tx = env.update_tx(&base, &applied(&base, &blob), &blob, vec![]);
    let cycles = env.verify(&tx).expect("quorum 7 of 9");
    println!("price_feed_type update, quorum 7 of 9: {cycles} cycles");
}

/// One cell in a multi-feed transaction: `new = None` burns it; `blob` goes in its witness.
struct Move {
    old: PriceFeedData,
    new: Option<PriceFeedData>,
    blob: Option<Vec<u8>>,
}

impl Env {
    fn multi_tx(&mut self, moves: Vec<Move>) -> TransactionView {
        let mut deps = self.deps();
        deps.push(self.set_dep.clone());
        let mut tx = TransactionBuilder::default().cell_deps(deps);
        for m in moves {
            let (cell, feed_type) = self.live_feed(&m.old);
            let witness = match &m.blob {
                Some(blob) => {
                    let mut bytes = (blob.len() as u32).to_le_bytes().to_vec();
                    bytes.extend_from_slice(blob);
                    WitnessArgs::new_builder().input_type(Some(Bytes::from(bytes)).pack()).build()
                }
                None => WitnessArgs::default(),
            };
            tx = tx.input(CellInput::new_builder().previous_output(cell).build()).witness(witness.as_bytes().pack());
            if let Some(new) = &m.new {
                tx = tx
                    .output(CellOutput::new_builder().capacity(CAPACITY / 2).lock(self.lock.clone()).type_(Some(feed_type).pack()).build())
                    .output_data(Bytes::from(new.to_bytes()).pack());
            }
        }
        self.context.complete_tx(tx.build())
    }
}

fn sol() -> [u8; 32] {
    lean_oracle_common::protocol_hash::feed_id(b"Crypto.SOL/USD")
}

#[test]
fn single_feed_update_stays_within_the_cycle_budget() {
    // Regression contract (D11): single-feed update at 3-of-4 costs at most 24.1M + 5%.
    let mut env = Env::new(Committee::new(4, 0));
    let quorum = env.committee.quorum_indexes();
    let base = env.uninitialized();
    let blob = env.signed(T0, vec![message(btc(), 6_700_000_000_000), message(eth(), 312_000_000_000)], &quorum);
    let tx = env.update_tx(&base, &applied(&base, &blob), &blob, vec![]);
    let cycles = env.verify(&tx).expect("single feed");
    assert!(cycles <= 25_300_000, "single-feed update costs {cycles} cycles, budget 25.3M");
}

#[test]
fn several_feeds_share_one_signature_check() {
    let mut env = Env::new(Committee::new(4, 0));
    let quorum = env.committee.quorum_indexes();
    let feeds = [btc(), eth(), sol()];
    let blob = env.signed(T0, feeds.iter().map(|f| message(*f, 1_000_000_000)).collect(), &quorum);
    let uninitialized = env.uninitialized();
    let base = |f: [u8; 32]| PriceFeedData { feed_id: f, ..uninitialized.clone() };
    let mut cost = Vec::new();
    for n in 1..=3 {
        let moves = feeds[..n]
            .iter()
            .enumerate()
            .map(|(i, f)| Move { old: base(*f), new: Some(applied(&base(*f), &blob)), blob: (i == 0).then(|| blob.clone()) })
            .collect();
        let tx = env.multi_tx(moves);
        cost.push(env.verify(&tx).expect("multi-feed update"));
    }
    println!("price_feed_type 1/2/3 feeds in one tx, quorum 3 of 4: {cost:?} cycles");
    // Each extra feed costs a Merkle proof, not another signature check (~8M per signature).
    assert!(cost[2] - cost[0] < 8_000_000, "3 feeds cost {} more than 1", cost[2] - cost[0]);
}

#[test]
fn followers_must_be_in_the_leaders_update() {
    let mut env = Env::new(Committee::new(4, 0));
    let quorum = env.committee.quorum_indexes();
    let btc_blob = env.signed(T0, vec![message(btc(), 1_000_000_000)], &quorum);
    let eth_blob = env.signed(T0 + 1000, vec![message(eth(), 2_000_000_000)], &quorum);
    let btc_base = PriceFeedData { feed_id: btc(), ..env.uninitialized() };
    let eth_base = PriceFeedData { feed_id: eth(), ..env.uninitialized() };
    // Each cell carries its own, different update: the follower's feed is not in the leader's blob.
    let tx = env.multi_tx(vec![
        Move { old: btc_base.clone(), new: Some(applied(&btc_base, &btc_blob)), blob: Some(btc_blob.clone()) },
        Move { old: eth_base.clone(), new: Some(applied(&eth_base, &eth_blob)), blob: Some(eth_blob) },
    ]);
    assert_script_error(env.verify(&tx), ERROR_UPDATE_FEED_NOT_FOUND);
}

#[test]
fn a_burned_cell_is_never_the_leader() {
    let mut env = Env::new(Committee::new(4, 0));
    let quorum = env.committee.quorum_indexes();
    let blob = env.signed(T0, vec![message(btc(), 1_000_000_000), message(eth(), 2_000_000_000)], &quorum);
    // Under-quorum blob parked on a cell that is being burned (its script does not verify anything).
    let forged = env.signed(T0, vec![message(btc(), 1_000_000_000), message(eth(), 9_000_000_000)], &quorum[..1]);
    let btc_base = PriceFeedData { feed_id: btc(), ..env.uninitialized() };
    let eth_base = PriceFeedData { feed_id: eth(), ..env.uninitialized() };
    let tx = env.multi_tx(vec![
        Move { old: btc_base.clone(), new: None, blob: Some(forged.clone()) },
        Move { old: eth_base.clone(), new: Some(applied(&eth_base, &forged)), blob: None },
    ]);
    // The eth cell leads itself and has no blob of its own.
    assert_script_error(env.verify(&tx), ERROR_FEED_WITNESS_MALFORMED);
    let tx = env.multi_tx(vec![
        Move { old: btc_base, new: None, blob: Some(forged) },
        Move { old: eth_base.clone(), new: Some(applied(&eth_base, &blob)), blob: Some(blob) },
    ]);
    env.verify(&tx).expect("the updating cell leads and verifies its own blob");
}

#[test]
fn a_cell_of_another_committee_is_not_a_leader() {
    let mut env = Env::new(Committee::new(4, 0));
    let quorum = env.committee.quorum_indexes();
    let blob = env.signed(T0, vec![message(btc(), 1_000_000_000), message(eth(), 2_000_000_000)], &quorum);
    let foreign = PriceFeedData { feed_id: btc(), publisher_set_type_hash: [0x99; 32], ..Default::default() };
    let eth_base = PriceFeedData { feed_id: eth(), ..env.uninitialized() };
    // The foreign cell updates too (it will fail on its own), but it cannot lead the eth cell.
    let tx = env.multi_tx(vec![
        Move { old: foreign.clone(), new: Some(foreign), blob: Some(blob.clone()) },
        Move { old: eth_base.clone(), new: Some(applied(&eth_base, &blob)), blob: None },
    ]);
    let error = env.verify(&tx).expect_err("foreign cell fails").to_string();
    assert!(!error.contains(&format!("error code {ERROR_UPDATE_SIGNATURE} ")), "eth must not borrow a foreign leader: {error}");
}

#[test]
fn previous_set_verifies_ticks_before_the_switch_until_revoked() {
    let old = Committee::new(4, 0);
    let new = Committee::new(4, 1);
    let switch = T0 + 10_000;
    let rotated = PublisherSetData {
        governance_nonce: 1,
        current: new.data.current.clone(),
        previous: Some(lean_oracle_common::publisher_set::PreviousSet { set: old.data.current.clone(), until_ms: switch }),
        ..old.data.clone()
    };
    let mut env = Env::with_set_data(Committee::new(4, 0), Some(rotated.clone()));
    let base = env.uninitialized();
    let before = signed_update(&old, env.set_type_hash, switch - 1_000, vec![message(btc(), 1)], &[0, 1, 2]).to_bytes();
    let tx = env.update_tx(&base, &applied(&base, &before), &before, vec![]);
    env.verify(&tx).expect("previous set, tick before the switch");

    let after = signed_update(&old, env.set_type_hash, switch, vec![message(btc(), 1)], &[0, 1, 2]).to_bytes();
    let tx = env.update_tx(&base, &applied(&base, &after), &after, vec![]);
    assert_script_error(env.verify(&tx), ERROR_UPDATE_SET);

    let revoked = PublisherSetData { governance_nonce: 2, previous: None, ..rotated };
    let mut env = Env::with_set_data(Committee::new(4, 0), Some(revoked));
    let base = env.uninitialized();
    let tx = env.update_tx(&base, &applied(&base, &before), &before, vec![]);
    assert_script_error(env.verify(&tx), ERROR_UPDATE_SET);
}
