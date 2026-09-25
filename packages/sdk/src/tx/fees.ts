//! Fee and capacity completion: the last step before signing. Builders return drafts without fee
//! inputs or change; `completeFee` adds them from the signer's plain cells.
//!
//! Greedy selection: the signer's plain cells (no type script, empty data) are added largest first
//! until the inputs cover the fee plus a change cell, which keeps the transaction small. The fee is
//! computed on a copy prepared by the signer (witness placeholders for signatures included), so it
//! is never underestimated. Only plain cells are used, so completion can never consume a code
//! cell, a feed cell, a committee cell or any other stateful cell that shares the signer's lock.

import { ccc } from "@ckb-ccc/core";

import { LeanOracleError } from "../errors.js";
import type { Hex, Script } from "../types.js";
import { occupiedCapacity } from "./cellCapacity.js";

const PLAIN_FUEL_FILTER: ccc.ClientIndexerSearchKeyFilterLike = {
  scriptLenRange: [0, 1],
  outputDataLenRange: [0, 1],
};

/** @public */
export interface CompleteFeeOptions {
  /**
   * Fee rate in shannons per 1000 bytes. When omitted, the chain's fee-rate statistics are used.
   * Pass an explicit value on devnet (offckb returns null statistics), e.g. `1000n`.
   */
  feeRate?: bigint;
  /** Lock of the change output (default: the signer's recommended lock). */
  changeLock?: Script;
  /**
   * When the leftover is too small for a change cell, pay it all as fee instead of adding another
   * input. Default false.
   */
  leftoverToFee?: boolean;
}

export type CompleteFeeResult =
  | { status: "ok"; tx: ccc.Transaction; fee: bigint; inputsAdded: number; changeAdded: boolean }
  | { status: "insufficient"; tx: ccc.Transaction; fee: bigint; inputsAdded: number; shortfall: bigint };

/** Thrown by `completeFeeAndChange` when the signer's plain cells cannot cover the transaction. */
export class InsufficientCapacityError extends LeanOracleError {
  constructor(readonly shortfall: bigint, readonly fee: bigint) {
    super(`insufficient capacity: ${ccc.fixedPointToString(shortfall)} CKB more needed (fee ${ccc.fixedPointToString(fee)} CKB)`, "INSUFFICIENT_CAPACITY");
  }
}

/**
 * Add fee inputs and a change output to `tx` (mutated in place). On `insufficient`, `tx` holds every
 * plain cell tried and `shortfall` is the extra capacity needed.
 */
export async function completeFee(tx: ccc.Transaction, signer: ccc.Signer, options: CompleteFeeOptions = {}): Promise<CompleteFeeResult> {
  const client = signer.client;
  const feeRate = options.feeRate ?? (await client.getFeeRate());
  const changeLock = options.changeLock ?? ((await signer.getRecommendedAddressObj()).script as unknown as Script);
  const minChange = occupiedCapacity(changeLock, undefined, "0x" as Hex);

  const used = new Set(tx.inputs.map((i) => `${i.previousOutput.txHash}:${i.previousOutput.index}`));
  const fuel: ccc.Cell[] = [];
  for await (const cell of signer.findCells(PLAIN_FUEL_FILTER, true)) {
    if (!used.has(`${cell.outPoint.txHash}:${cell.outPoint.index}`)) fuel.push(cell);
  }
  fuel.sort((a, b) => (a.cellOutput.capacity > b.cellOutput.capacity ? -1 : a.cellOutput.capacity < b.cellOutput.capacity ? 1 : 0));

  let net = (await tx.getInputsCapacity(client)) - tx.getOutputsCapacity();
  const feeOf = async (draft: ccc.Transaction) => (await signer.prepareTransaction(draft.clone())).estimateFee(feeRate);
  const withChange = (draft: ccc.Transaction) => {
    const copy = draft.clone();
    copy.addOutput({ lock: changeLock, capacity: minChange }, "0x");
    return copy;
  };

  let inputsAdded = 0;
  for (;;) {
    const feeWithChange = await feeOf(withChange(tx));
    if (net >= feeWithChange + minChange) {
      tx.addOutput({ lock: changeLock, capacity: net - feeWithChange }, "0x");
      return { status: "ok", tx, fee: feeWithChange, inputsAdded, changeAdded: true };
    }
    const feeAlone = await feeOf(tx);
    if (options.leftoverToFee && net >= feeAlone) return { status: "ok", tx, fee: net, inputsAdded, changeAdded: false };

    const next = fuel[inputsAdded];
    if (!next) return { status: "insufficient", tx, fee: feeWithChange, inputsAdded, shortfall: feeWithChange + minChange - net };
    tx.addInput({ previousOutput: next.outPoint, cellOutput: next.cellOutput, outputData: next.outputData });
    net += next.cellOutput.capacity;
    inputsAdded++;
  }
}

/** `completeFee`, throwing `InsufficientCapacityError` on a shortfall. Returns the ready-to-sign `tx`. */
export async function completeFeeAndChange(tx: ccc.Transaction, signer: ccc.Signer, options?: CompleteFeeOptions): Promise<ccc.Transaction> {
  const result = await completeFee(tx, signer, options);
  if (result.status === "insufficient") throw new InsufficientCapacityError(result.shortfall, result.fee);
  return result.tx;
}
