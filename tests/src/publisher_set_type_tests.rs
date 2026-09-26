//! Runs the compiled `publisher_set_type` binary through `ckb-testtool`: creation, every governance
//! operation, the rotation interval, committee binding and the cell guards that make an
//! always-success lock safe.

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
    protocol_hash::type_id_seed,
    publisher_set::{
        PreviousSet, PublisherSetData, GOVERNANCE_PAUSED, OP_PAUSE, OP_REVOKE_PREVIOUS, OP_ROTATE, OP_ROTATE_REVOKE, OP_UNPAUSE,
    },
    signatures::SignatureBundle,
};

use crate::fixtures::Committee;

const MAX_CYCLES: u64 = 500_000_000;
const CAPACITY: u64 = 1_000_00000000;
const DAY: u64 = 86_400;
/// Relative (bit 63) timestamp (bits 61-62 = 0b10) `since`, in seconds.
const fn relative_seconds(seconds: u64) -> u64 {
    0xC000_0000_0000_0000 | seconds
}
/// Absolute timestamp `since` (bits 61-62 = 0b10, bit 63 clear).
const fn absolute_seconds(seconds: u64) -> u64 {
    0x4000_0000_0000_0000 | seconds
}

struct Env {
    context: Context,
    code: OutPoint,
    always: OutPoint,
    lock: Script,
    committee_type: Script,
    committee_hash: [u8; 32],
}

impl Env {
    fn new() -> Self {
        let mut context = Context::default();
        let binary = std::fs::read("../target/riscv64imac-unknown-none-elf/release/publisher_set_type")
            .expect("build contracts first: cargo build --release");
        let code = context.deploy_cell(binary.into());
        let always = context.deploy_cell(Bytes::from(ckb_testtool::builtin::ALWAYS_SUCCESS.to_vec()));
        let lock = context.build_script(&always, Bytes::new()).unwrap();
        let committee_type = context.build_script_with_hash_type(&code, ScriptHashType::Data2, Bytes::from(vec![0x7e; 32])).unwrap();
        let committee_hash = committee_type.calc_script_hash().unpack();
        Self { context, code, always, lock, committee_type, committee_hash }
    }

    fn deps(&self) -> Vec<CellDep> {
        vec![
            CellDep::new_builder().out_point(self.code.clone()).build(),
            CellDep::new_builder().out_point(self.always.clone()).build(),
        ]
    }

    fn create_tx(&mut self, data: &PublisherSetData, type_id_override: Option<[u8; 32]>) -> TransactionView {
        let funding = self.context.create_cell(CellOutput::new_builder().capacity(CAPACITY).lock(self.lock.clone()).build(), Bytes::new());
        let input = CellInput::new_builder().previous_output(funding).build();
        let type_id = type_id_override.unwrap_or_else(|| type_id_seed(input.as_slice(), 0));
        let committee_type = self.context.build_script_with_hash_type(&self.code, ScriptHashType::Data2, Bytes::from(type_id.to_vec())).unwrap();
        let tx = TransactionBuilder::default()
            .cell_deps(self.deps())
            .input(input)
            .output(CellOutput::new_builder().capacity(CAPACITY / 2).lock(self.lock.clone()).type_(Some(committee_type).pack()).build())
            .output_data(Bytes::from(data.to_bytes()).pack())
            .build();
        self.context.complete_tx(tx)
    }

    /// Spend a live committee cell holding `old` into `outputs`, with `since` and `witness`.
    fn op_tx(&mut self, old: &PublisherSetData, outputs: Vec<(CellOutput, PublisherSetData)>, since: u64, witness: Vec<u8>) -> TransactionView {
        let cell = self.context.create_cell(
            CellOutput::new_builder().capacity(CAPACITY).lock(self.lock.clone()).type_(Some(self.committee_type.clone()).pack()).build(),
            Bytes::from(old.to_bytes()),
        );
        let witness = WitnessArgs::new_builder().input_type(Some(Bytes::from(witness)).pack()).build();
        let mut tx = TransactionBuilder::default()
            .cell_deps(self.deps())
            .input(CellInput::new_builder().previous_output(cell).since(since).build())
            .witness(witness.as_bytes().pack());
        for (output, data) in outputs {
            tx = tx.output(output).output_data(Bytes::from(data.to_bytes()).pack());
        }
        self.context.complete_tx(tx.build())
    }

    fn output(&self, capacity: u64) -> CellOutput {
        CellOutput::new_builder().capacity(capacity).lock(self.lock.clone()).type_(Some(self.committee_type.clone()).pack()).build()
    }

    fn verify(&self, tx: &TransactionView) -> Result<u64, Error> {
        self.context.verify_tx(tx, MAX_CYCLES)
    }
}

fn witness(operation: u8, authorization: &SignatureBundle, pop: Option<&SignatureBundle>) -> Vec<u8> {
    let mut out = vec![operation];
    out.extend_from_slice(&authorization.to_bytes());
    if let Some(pop) = pop {
        out.extend_from_slice(&pop.to_bytes());
    }
    out
}

fn assert_code(result: Result<u64, Error>, code: i8) {
    let error = result.expect_err("transaction should fail").to_string();
    assert!(error.contains(&format!("error code {code} ")), "expected error code {code}, got: {error}");
}

/// Committee `old` (set 0, 4 keys) and its routine rotation to `next` (set 1, 4 new keys).
fn rotation() -> (Committee, Committee, PublisherSetData) {
    let old = Committee::new(4, 0);
    let next_keys = Committee::new(4, 1);
    let next = PublisherSetData {
        governance_nonce: 1,
        current: next_keys.data.current.clone(),
        previous: Some(PreviousSet { set: old.data.current.clone(), until_ms: 1_700_000_000_000 }),
        ..old.data.clone()
    };
    (old, next_keys, next)
}

fn all(n: usize) -> Vec<usize> {
    (0..n).collect()
}

#[test]
fn create_accepts_genesis_and_rejects_anything_else() {
    let mut env = Env::new();
    let genesis = Committee::new(4, 0).data;
    let tx = env.create_tx(&genesis, None);
    env.verify(&tx).expect("genesis");

    let tx = env.create_tx(&PublisherSetData { governance_nonce: 1, ..genesis.clone() }, None);
    assert_code(env.verify(&tx), ERROR_PUBLISHER_SET_CONTINUITY);
    let (_, _, rotated) = rotation();
    let tx = env.create_tx(&rotated, None);
    assert_code(env.verify(&tx), ERROR_PUBLISHER_SET_CONTINUITY);
    let tx = env.create_tx(&genesis, Some([9; 32]));
    assert_code(env.verify(&tx), ERROR_TYPE_ID_INVALID);
}

#[test]
fn routine_rotation_needs_quorum_pop_and_the_interval() {
    let mut env = Env::new();
    let (old, next_keys, next) = rotation();
    let h = env.committee_hash;
    let auth = old.sign(&old.data.update_hash(&h, &next, OP_ROTATE), &old.quorum_indexes());
    let pop = next_keys.sign(&next.pop_hash(&h), &all(4));
    let good = witness(OP_ROTATE, &auth, Some(&pop));

    let tx = env.op_tx(&old.data, vec![(env.output(CAPACITY), next.clone())], relative_seconds(DAY), good.clone());
    let cycles = env.verify(&tx).expect("routine rotation");
    println!("publisher_set_type rotate 4 -> 4 keys: {cycles} cycles");

    // The interval: missing, too short, or absolute (backdatable) since.
    for since in [0, relative_seconds(DAY - 1), absolute_seconds(u32::MAX as u64), 0x8000_0000_0000_0000 | DAY] {
        let tx = env.op_tx(&old.data, vec![(env.output(CAPACITY), next.clone())], since, good.clone());
        assert_code(env.verify(&tx), ERROR_PUBLISHER_SET_INTERVAL);
    }
    // Below quorum (quorum of 4 is 3).
    let short = old.sign(&old.data.update_hash(&h, &next, OP_ROTATE), &[0, 1]);
    let tx = env.op_tx(&old.data, vec![(env.output(CAPACITY), next.clone())], relative_seconds(DAY), witness(OP_ROTATE, &short, Some(&pop)));
    assert_code(env.verify(&tx), ERROR_PUBLISHER_SET_AUTH);
    // Signed by the new keys instead of the current ones.
    let wrong = next_keys.sign(&old.data.update_hash(&h, &next, OP_ROTATE), &[0, 1, 2]);
    let tx = env.op_tx(&old.data, vec![(env.output(CAPACITY), next.clone())], relative_seconds(DAY), witness(OP_ROTATE, &wrong, Some(&pop)));
    assert_code(env.verify(&tx), ERROR_PUBLISHER_SET_AUTH);
    // Proof of possession missing a key.
    let partial = next_keys.sign(&next.pop_hash(&h), &[0, 1, 2]);
    let tx = env.op_tx(&old.data, vec![(env.output(CAPACITY), next.clone())], relative_seconds(DAY), witness(OP_ROTATE, &auth, Some(&partial)));
    assert_code(env.verify(&tx), ERROR_PUBLISHER_SET_POP);
    // Proof of possession absent.
    let tx = env.op_tx(&old.data, vec![(env.output(CAPACITY), next.clone())], relative_seconds(DAY), witness(OP_ROTATE, &auth, None));
    assert_code(env.verify(&tx), ERROR_ENCODING);
}

#[test]
fn authorization_for_another_committee_does_not_replay() {
    let mut env = Env::new();
    let (old, next_keys, next) = rotation();
    // Signed for a twin committee with identical state but a different cell.
    let twin = [0x55; 32];
    let auth = old.sign(&old.data.update_hash(&twin, &next, OP_ROTATE), &old.quorum_indexes());
    let pop = next_keys.sign(&next.pop_hash(&twin), &all(4));
    let tx = env.op_tx(&old.data, vec![(env.output(CAPACITY), next.clone())], relative_seconds(DAY), witness(OP_ROTATE, &auth, Some(&pop)));
    assert_code(env.verify(&tx), ERROR_PUBLISHER_SET_AUTH);

    let paused = PublisherSetData { governance_nonce: 1, governance_flags: GOVERNANCE_PAUSED, ..old.data.clone() };
    let auth = old.sign(&old.data.update_hash(&twin, &paused, OP_PAUSE), &old.quorum_indexes());
    let tx = env.op_tx(&old.data, vec![(env.output(CAPACITY), paused)], 0, witness(OP_PAUSE, &auth, None));
    assert_code(env.verify(&tx), ERROR_PUBLISHER_SET_AUTH);
}

#[test]
fn emergency_rotation_revokes_history_and_skips_the_interval() {
    let mut env = Env::new();
    let (old, next_keys, next) = rotation();
    let h = env.committee_hash;
    let revoke = PublisherSetData { previous: None, ..next.clone() };
    let auth = old.sign(&old.data.update_hash(&h, &revoke, OP_ROTATE_REVOKE), &old.quorum_indexes());
    let pop = next_keys.sign(&revoke.pop_hash(&h), &all(4));
    let tx = env.op_tx(&old.data, vec![(env.output(CAPACITY), revoke.clone())], 0, witness(OP_ROTATE_REVOKE, &auth, Some(&pop)));
    env.verify(&tx).expect("revoking rotation without waiting");

    // Keeping the previous set under the revoke operation is refused.
    let auth = old.sign(&old.data.update_hash(&h, &next, OP_ROTATE_REVOKE), &old.quorum_indexes());
    let pop = next_keys.sign(&next.pop_hash(&h), &all(4));
    let tx = env.op_tx(&old.data, vec![(env.output(CAPACITY), next)], 0, witness(OP_ROTATE_REVOKE, &auth, Some(&pop)));
    assert_code(env.verify(&tx), ERROR_PUBLISHER_SET_OPERATION);
}

#[test]
fn pause_unpause_and_revoke_previous_need_only_the_quorum() {
    let mut env = Env::new();
    let (_, next_keys, rotated) = rotation();
    let h = env.committee_hash;
    let current = Committee { keys: next_keys.keys, data: rotated.clone() };

    let paused = PublisherSetData { governance_nonce: 2, governance_flags: GOVERNANCE_PAUSED, ..rotated.clone() };
    let auth = current.sign(&rotated.update_hash(&h, &paused, OP_PAUSE), &current.quorum_indexes());
    let tx = env.op_tx(&rotated, vec![(env.output(CAPACITY), paused.clone())], 0, witness(OP_PAUSE, &auth, None));
    env.verify(&tx).expect("pause");
    // Extra bytes after the authorization are refused (no PoP for pause).
    let tx = env.op_tx(&rotated, vec![(env.output(CAPACITY), paused.clone())], 0, witness(OP_PAUSE, &auth, Some(&auth)));
    assert_code(env.verify(&tx), ERROR_ENCODING);

    let resumed = PublisherSetData { governance_nonce: 3, governance_flags: 0, ..paused.clone() };
    let auth = current.sign(&paused.update_hash(&h, &resumed, OP_UNPAUSE), &current.quorum_indexes());
    let tx = env.op_tx(&paused, vec![(env.output(CAPACITY), resumed)], 0, witness(OP_UNPAUSE, &auth, None));
    env.verify(&tx).expect("unpause");

    let revoked = PublisherSetData { governance_nonce: 2, previous: None, ..rotated.clone() };
    let auth = current.sign(&rotated.update_hash(&h, &revoked, OP_REVOKE_PREVIOUS), &current.quorum_indexes());
    let tx = env.op_tx(&rotated, vec![(env.output(CAPACITY), revoked)], 0, witness(OP_REVOKE_PREVIOUS, &auth, None));
    env.verify(&tx).expect("revoke previous at any time");
}

#[test]
fn guards_keep_the_cell_its_lock_and_its_capacity() {
    let mut env = Env::new();
    let old = Committee::new(4, 0);
    let h = env.committee_hash;
    let paused = PublisherSetData { governance_nonce: 1, governance_flags: GOVERNANCE_PAUSED, ..old.data.clone() };
    let auth = old.sign(&old.data.update_hash(&h, &paused, OP_PAUSE), &old.quorum_indexes());
    let w = witness(OP_PAUSE, &auth, None);

    // Capacity drained.
    let tx = env.op_tx(&old.data, vec![(env.output(CAPACITY - 1), paused.clone())], 0, w.clone());
    assert_code(env.verify(&tx), ERROR_PUBLISHER_SET_CELL);
    // Lock swapped.
    let other_lock = env.context.build_script(&env.always, Bytes::from_static(b"thief")).unwrap();
    let moved = CellOutput::new_builder().capacity(CAPACITY).lock(other_lock).type_(Some(env.committee_type.clone()).pack()).build();
    let tx = env.op_tx(&old.data, vec![(moved, paused.clone())], 0, w.clone());
    assert_code(env.verify(&tx), ERROR_CONFIG_MUTATED);
    // Burned, or split into two cells.
    let tx = env.op_tx(&old.data, vec![], 0, w.clone());
    assert_code(env.verify(&tx), ERROR_INVALID_SCRIPT_GROUP);
    let tx = env.op_tx(&old.data, vec![(env.output(CAPACITY / 2), paused.clone()), (env.output(CAPACITY / 2), paused.clone())], 0, w.clone());
    assert_code(env.verify(&tx), ERROR_INVALID_SCRIPT_GROUP);
    // Nonce skipped.
    let skipped = PublisherSetData { governance_nonce: 5, ..paused.clone() };
    let tx = env.op_tx(&old.data, vec![(env.output(CAPACITY), skipped)], 0, w);
    assert_code(env.verify(&tx), ERROR_PUBLISHER_SET_CONTINUITY);
}

#[test]
fn rotation_cycles_for_max_committee() {
    let mut env = Env::new();
    let old = Committee::new(9, 0);
    let next_keys = Committee::new(9, 1);
    let next = PublisherSetData {
        governance_nonce: 1,
        current: next_keys.data.current.clone(),
        previous: Some(PreviousSet { set: old.data.current.clone(), until_ms: 1 }),
        ..old.data.clone()
    };
    let h = env.committee_hash;
    let auth = old.sign(&old.data.update_hash(&h, &next, OP_ROTATE), &old.quorum_indexes());
    let pop = next_keys.sign(&next.pop_hash(&h), &all(9));
    let tx = env.op_tx(&old.data, vec![(env.output(CAPACITY), next)], relative_seconds(DAY), witness(OP_ROTATE, &auth, Some(&pop)));
    let cycles = env.verify(&tx).expect("9-key rotation");
    println!("publisher_set_type rotate 9 -> 9 keys: {cycles} cycles");
}
