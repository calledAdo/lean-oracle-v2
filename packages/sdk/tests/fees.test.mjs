// Greedy fee completion: largest plain cells first, fee sized with signature placeholders,
// explicit shortfall.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ccc } from "@ckb-ccc/core";
import { completeFee, completeFeeAndChange, InsufficientCapacityError } from "lean-oracle-sdk/tx";

const lock = ccc.Script.from({ codeHash: `0x${"9b".repeat(32)}`, hashType: "type", args: `0x${"11".repeat(20)}` });
const CKB = 100_000_000n;
const FEE_RATE = 1000n;
const cell = (i, ckb) => ccc.Cell.from({ outPoint: { txHash: `0x${String(i).padStart(64, "0")}`, index: 0 }, cellOutput: { capacity: BigInt(ckb) * CKB, lock }, outputData: "0x" });

/** Stub signer: plain cells in indexer order; prepare adds a 65-byte secp256k1 lock placeholder. */
function signer(cells) {
  return {
    client: { getFeeRate: async () => FEE_RATE },
    getRecommendedAddressObj: async () => ({ script: lock }),
    async *findCells() {
      yield* cells;
    },
    async prepareTransaction(tx) {
      tx.setWitnessArgsAt(0, ccc.WitnessArgs.from({ lock: `0x${"00".repeat(65)}` }));
      return tx;
    },
  };
}
const draft = (outputCkb) => {
  const tx = ccc.Transaction.from({});
  tx.addOutput({ lock, capacity: BigInt(outputCkb) * CKB }, "0x");
  return tx;
};

test("adds the largest plain cell first and sizes the fee with signature placeholders", async () => {
  const s = signer([cell(1, 100), cell(2, 500), cell(3, 70)]);
  const result = await completeFee(draft(150), s, { feeRate: FEE_RATE });
  assert.equal(result.status, "ok");
  assert.equal(result.inputsAdded, 1);
  assert.equal(result.tx.inputs[0].previousOutput.txHash, `0x${"2".padStart(64, "0")}`);
  const prepared = await s.prepareTransaction(result.tx.clone());
  assert.equal(result.fee, prepared.estimateFee(FEE_RATE), "fee matches the signed size");
  assert.ok(result.fee > result.tx.estimateFee(FEE_RATE), "unprepared size would underestimate");
  assert.equal(result.tx.outputs[1].capacity, 350n * CKB - result.fee, "change returns the rest");
});

test("reports the exact shortfall, and completeFeeAndChange throws it", async () => {
  const result = await completeFee(draft(1000), signer([cell(1, 100), cell(2, 500)]), { feeRate: FEE_RATE });
  assert.equal(result.status, "insufficient");
  assert.equal(result.inputsAdded, 2);
  assert.equal(result.shortfall, 1000n * CKB + result.fee + 61n * CKB - 600n * CKB);
  await assert.rejects(completeFeeAndChange(draft(1000), signer([cell(1, 100)]), { feeRate: FEE_RATE }), InsufficientCapacityError);
});

test("leftoverToFee pays a leftover too small for change as fee", async () => {
  const exact = await completeFee(draft(100), signer([cell(1, 100), cell(2, 100)]), { feeRate: FEE_RATE });
  assert.equal(exact.inputsAdded, 2, "without the option a second cell is needed for change");
  const small = await completeFee(draft(99), signer([cell(1, 100)]), { feeRate: FEE_RATE, leftoverToFee: true });
  assert.deepEqual([small.status, small.changeAdded, small.fee], ["ok", false, 1n * CKB]);
});
