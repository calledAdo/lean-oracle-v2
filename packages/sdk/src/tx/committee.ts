//! Committee (PublisherSet) cell builders. Every governance operation is authorized by the current
//! quorum inside the type script; the cell keeps its lock and capacity (an always-success lock is safe).

import { ccc } from "@ckb-ccc/core";

import { findCommitteeCell } from "../ckb/cells.js";
import { publisherSetTypeScript } from "../ckb/scripts.js";
import { computeTypeId } from "../ckb/typeId.js";
import { codeRefFor, findCodeRef, type LeanOracleDeployment } from "../presets/deployment.js";
import { MAX_UNTIL_AHEAD_MS, SINCE_RELATIVE_TIMESTAMP, SINCE_VALUE_MASK } from "../protocol/constants.js";
import {
  encodePublisherSetData,
  isValidPublisherSetData,
  needsProofOfPossession,
  needsRotationInterval,
  transitionError,
  type PublisherSetData,
} from "../protocol/publisherSet.js";
import { encodeSignatureBundle, type SignatureBundle } from "../protocol/signatures.js";
import type { Hex, Script } from "../types.js";
import { occupiedCapacity } from "./cellCapacity.js";
import { cellDep, concatBytes, plainInputOf, setInputType } from "./common.js";

/** Default minimum age of the committee cell before a routine rotation: 24 hours. */
export const DEFAULT_MIN_ROTATION_INTERVAL_S = 86_400n;

/** `since` for a relative timestamp (bit 63 relative, bits 61-62 = timestamp metric), in seconds. */
export function relativeTimestampSince(seconds: bigint): bigint {
  if (seconds < 0n || seconds > SINCE_VALUE_MASK) throw new RangeError(`since value ${seconds} does not fit in 56 bits`);
  return SINCE_RELATIVE_TIMESTAMP | seconds;
}

export interface BootstrapCommitteeParams {
  signer: ccc.Signer;
  deployment: LeanOracleDeployment;
  /** Initial committee: `governanceNonce` 0, `setIndex` 0, no previous set. */
  data: PublisherSetData;
  /**
   * Lock of the committee cell. Default: the deployment's `alwaysSuccessLock`, so no key can block
   * governance (the committee type script keeps the cell and its capacity safe); without one, the
   * signer's own lock, whose key must then co-sign every governance transaction and could block it.
   */
  lock?: Script;
}

export async function bootstrapCommittee(p: BootstrapCommitteeParams): Promise<{ tx: ccc.Transaction; typeScript: Script; typeHash: Hex }> {
  if (p.data.governanceNonce !== 0n || p.data.current.setIndex !== 0 || p.data.previous || !isValidPublisherSetData(p.data)) {
    throw new Error("a new committee needs nonce 0, set index 0, no previous set, a positive rotation interval and a valid key set");
  }
  const open = p.deployment.contracts.alwaysSuccessLock;
  const lock = p.lock ?? (open ? { codeHash: open.codeHash, hashType: "data2" as const, args: "0x" as Hex } : ((await p.signer.getRecommendedAddressObj()).script as unknown as Script));
  const firstInput = await plainInputOf(p.signer);
  const typeScript = publisherSetTypeScript(p.deployment, computeTypeId(firstInput, 0));
  const dataHex = ccc.hexFrom(encodePublisherSetData(p.data)) as Hex;
  const tx = ccc.Transaction.from({});
  tx.addInput(firstInput);
  tx.addOutput({ lock, type: typeScript, capacity: occupiedCapacity(lock, typeScript, dataHex) }, dataHex);
  tx.addCellDeps(cellDep(p.deployment.contracts.publisherSetType.cellDep));
  return { tx, typeScript, typeHash: ccc.Script.from(typeScript).hash() as Hex };
}

export interface GovernCommitteeParams {
  client: ccc.Client;
  deployment: LeanOracleDeployment;
  committee: Script;
  /** OP_ROTATE, OP_ROTATE_REVOKE, OP_PAUSE, OP_UNPAUSE or OP_REVOKE_PREVIOUS. The committee cell is input 0. */
  operation: number;
  next: PublisherSetData;
  /** Current-set quorum over `publisherSetUpdateHash(current, next, operation, committeeTypeHash)`. */
  authorization: SignatureBundle;
  /** Rotations only: every next-set key over `publisherSetPopHash(next, committeeTypeHash)`, in index order. */
  proofOfPossession?: SignatureBundle;
}

/**
 * One governance operation on the committee cell. Checks the transition locally first (same rules as
 * the contract). A routine rotation spends the cell with a relative `since` of the committee's
 * `minRotationIntervalS`, so it is only accepted once the cell is that old, and carries the chain tip's
 * header as a header dep: the contract allows `previous.untilMs` at most `MAX_UNTIL_AHEAD_MS` past it.
 */
export async function governCommittee(p: GovernCommitteeParams): Promise<ccc.Transaction> {
  const live = await findCommitteeCell(p.client, p.committee);
  if (!live) throw new Error("committee cell not found");
  const problem = transitionError(live.data, p.next, p.operation);
  if (problem) throw new Error(`invalid committee transition: ${problem}`);
  const needsPop = needsProofOfPossession(p.operation);
  if (needsPop !== (p.proofOfPossession !== undefined)) {
    throw new Error(needsPop ? "a rotation needs a proof of possession from every new key" : "only rotations carry a proof of possession");
  }

  const dataHex = ccc.hexFrom(encodePublisherSetData(p.next));
  const tx = ccc.Transaction.from({});
  const since = needsRotationInterval(p.operation) ? relativeTimestampSince(live.data.minRotationIntervalS) : 0n;
  tx.addInput(ccc.CellInput.from({ previousOutput: live.cell.outPoint, since }));
  const output = ccc.CellOutput.from(live.cell.cellOutput);
  const needed = occupiedCapacity(output.lock as unknown as Script, output.type as unknown as Script, dataHex as Hex);
  if (output.capacity < needed) output.capacity = needed;
  tx.addOutput(output, dataHex);
  if (needsRotationInterval(p.operation) && p.next.previous) {
    const tip = await p.client.getTipHeader();
    if (p.next.previous.untilMs > tip.timestamp + MAX_UNTIL_AHEAD_MS) {
      throw new Error(`previous.untilMs ${p.next.previous.untilMs} is more than ${MAX_UNTIL_AHEAD_MS} ms past the chain tip (${tip.timestamp})`);
    }
    tx.headerDeps.push(tip.hash);
  }
  // The committee keeps the contract version it was created under.
  tx.addCellDeps(cellDep(codeRefFor(p.deployment, "publisherSetType", live.cell.cellOutput.type!.codeHash as Hex).cellDep));
  // An always-success committee lock runs too, so its code is a dep; any other lock is the signer's to unlock.
  const openLock = findCodeRef(p.deployment, "alwaysSuccessLock", live.cell.cellOutput.lock.codeHash as Hex);
  if (openLock) tx.addCellDeps(cellDep(openLock.cellDep));
  const pop = p.proofOfPossession ? encodeSignatureBundle(p.proofOfPossession) : new Uint8Array();
  setInputType(tx, 0, concatBytes(Uint8Array.of(p.operation), encodeSignatureBundle(p.authorization), pop));
  return tx;
}
