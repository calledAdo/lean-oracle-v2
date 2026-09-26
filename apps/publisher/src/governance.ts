//! Committee governance, operator side. Every operation replaces the committee cell's data; the
//! publisher_set_type script accepts it only with
//!   - an authorization: a quorum of the CURRENT set signing
//!     publisherSetUpdateHash(current, next, operation, committeeTypeHash);
//!   - for rotations, a proof of possession: EVERY key of the NEXT set signing
//!     publisherSetPopHash(next, committeeTypeHash).
//! Both digests name the committee cell, so an approval cannot be replayed on another committee.
//! Each operator produces its signatures on its own machine with these helpers; the coordinator merges
//! them and sends the operation with apps/deploy (`govern:committee`).

import {
  OP_PAUSE,
  OP_REVOKE_PREVIOUS,
  OP_ROTATE,
  OP_ROTATE_REVOKE,
  OP_UNPAUSE,
  GOVERNANCE_PAUSED,
  needsProofOfPossession,
  publisherSetPopHash,
  publisherSetUpdateHash,
  quorum,
  recoverSigner,
  transitionError,
  verifyAll,
  verifyThreshold,
  type Hex,
  type IndexedSignature,
  type PublisherSetData,
} from "lean-oracle-sdk/protocol";
import { toSignatureBundle } from "lean-oracle-sdk/publisher";

import type { KeySigner } from "./keySigner.js";

const COMPRESSED_KEY = /^0x0[23][0-9a-f]{64}$/;
const HASH = /^0x[0-9a-f]{64}$/;

export const OPERATIONS = {
  rotate: OP_ROTATE,
  "rotate-revoke": OP_ROTATE_REVOKE,
  pause: OP_PAUSE,
  unpause: OP_UNPAUSE,
  "revoke-previous": OP_REVOKE_PREVIOUS,
} as const;
export type OperationName = keyof typeof OPERATIONS;

export function parseOperation(name: string | undefined): number {
  const op = OPERATIONS[(name ?? "") as OperationName];
  if (op === undefined) throw new Error(`--op must be one of ${Object.keys(OPERATIONS).join(", ")}`);
  return op;
}

export function operationName(op: number): string {
  return Object.entries(OPERATIONS).find(([, v]) => v === op)?.[0] ?? `op ${op}`;
}

export function parseCommitteeHash(value: string | undefined): Hex {
  const hash = value?.trim().toLowerCase();
  if (!hash || !HASH.test(hash)) throw new Error("the committee type hash (0x + 64 hex) is required: pass --committee or --operator");
  return hash as Hex;
}

export interface NextStateOptions {
  add?: string[];
  remove?: string[];
  /** Rotations that keep history: first tick of the new set (the previous set verifies ticks before it). */
  untilMs?: bigint;
}

/**
 * The state `operation` produces from `current`: nonce + 1, same network and interval; rotations move
 * to the next set index with keys added/removed (routine rotation keeps the outgoing set as `previous`
 * until `untilMs`), pause/unpause flip the flag, revoke-previous drops the previous set.
 */
export function nextState(current: PublisherSetData, operation: number, options: NextStateOptions = {}): PublisherSetData {
  const base = { ...current, governanceNonce: current.governanceNonce + 1n };
  let next: PublisherSetData;
  switch (operation) {
    case OP_ROTATE:
    case OP_ROTATE_REVOKE: {
      const keys = rotatedKeys(current, options.add ?? [], options.remove ?? []);
      const { previous: _dropped, ...rest } = base;
      next = { ...rest, current: { setIndex: current.current.setIndex + 1, pubkeys: keys } };
      if (operation === OP_ROTATE) {
        if (options.untilMs === undefined) throw new Error("a routine rotation needs the new set's first tick (--until-ms)");
        next.previous = { set: current.current, untilMs: options.untilMs };
      }
      break;
    }
    case OP_PAUSE:
      next = { ...base, governanceFlags: current.governanceFlags | GOVERNANCE_PAUSED };
      break;
    case OP_UNPAUSE:
      next = { ...base, governanceFlags: current.governanceFlags & ~GOVERNANCE_PAUSED };
      break;
    case OP_REVOKE_PREVIOUS: {
      const { previous: _dropped, ...rest } = base;
      next = rest;
      break;
    }
    default:
      throw new Error(`unknown operation ${operation}`);
  }
  const problem = transitionError(current, next, operation);
  if (problem) throw new Error(`cannot ${operationName(operation)}: ${problem}`);
  return next;
}

function rotatedKeys(current: PublisherSetData, add: string[], remove: string[]): Hex[] {
  const norm = (k: string) => {
    const key = k.trim().toLowerCase();
    if (!COMPRESSED_KEY.test(key)) throw new Error(`not a compressed secp256k1 public key: ${k}`);
    return key as Hex;
  };
  const keys = new Set(current.current.pubkeys.map((k) => k.toLowerCase() as Hex));
  for (const k of remove.map(norm)) {
    if (!keys.delete(k)) throw new Error(`cannot remove ${k}: not in the current set`);
  }
  for (const k of add.map(norm)) {
    if (keys.has(k)) throw new Error(`cannot add ${k}: already in the set`);
    keys.add(k);
  }
  if (keys.size === 0 || keys.size > 9) throw new Error("the next set needs 1 to 9 distinct keys");
  return [...keys].sort();
}

/** A readable summary of a committee state, for review before signing. */
export function describeSet(data: PublisherSetData, self?: Hex) {
  return {
    setIndex: data.current.setIndex,
    governanceNonce: data.governanceNonce.toString(),
    paused: (data.governanceFlags & GOVERNANCE_PAUSED) !== 0,
    minRotationIntervalS: data.minRotationIntervalS.toString(),
    publishers: data.current.pubkeys.length,
    quorum: quorum(data.current),
    pubkeys: data.current.pubkeys.map((k, index) => ({ index, pubkey: k, ...(self && k === self ? { you: true } : {}) })),
    previous: data.previous ? { setIndex: data.previous.set.setIndex, untilMs: data.previous.untilMs.toString(), publishers: data.previous.set.pubkeys.length } : null,
  };
}

/** What `operation` changes from `current` to `next`, for review before signing. */
export function diffSets(current: PublisherSetData, next: PublisherSetData, operation: number) {
  const before = new Set(current.current.pubkeys);
  const after = new Set(next.current.pubkeys);
  return {
    operation: operationName(operation),
    added: next.current.pubkeys.filter((k) => !before.has(k)),
    removed: current.current.pubkeys.filter((k) => !after.has(k)),
    setIndex: `${current.current.setIndex} → ${next.current.setIndex}`,
    quorum: `${quorum(current.current)} of ${current.current.pubkeys.length} → ${quorum(next.current)} of ${next.current.pubkeys.length}`,
    paused: `${(current.governanceFlags & GOVERNANCE_PAUSED) !== 0} → ${(next.governanceFlags & GOVERNANCE_PAUSED) !== 0}`,
    previous: next.previous ? `set ${next.previous.set.setIndex} verifies ticks before ${next.previous.untilMs}` : "none (history of earlier sets revoked)",
  };
}

/** This operator's authorization of `current → next` under `operation`, as a member of the current set. */
export async function signGovernance(current: PublisherSetData, next: PublisherSetData, operation: number, committee: Hex, signer: KeySigner): Promise<IndexedSignature> {
  const problem = transitionError(current, next, operation);
  if (problem) throw new Error(`refusing to sign ${operationName(operation)}: ${problem}`);
  const publisherIndex = current.current.pubkeys.indexOf(signer.publicKey);
  if (publisherIndex < 0) throw new Error("this key is not in the current set, so it cannot authorize governance");
  return { publisherIndex, signature: await signer.sign(publisherSetUpdateHash(current, next, operation, committee)) };
}

/** This operator's proof of possession, as a member of the next set (rotations only). */
export async function signProofOfPossession(next: PublisherSetData, committee: Hex, signer: KeySigner): Promise<IndexedSignature> {
  const publisherIndex = next.current.pubkeys.indexOf(signer.publicKey);
  if (publisherIndex < 0) throw new Error("this key is not in the next set");
  return { publisherIndex, signature: await signer.sign(publisherSetPopHash(next, committee)) };
}

/** Merge signature lists (or single signatures) from several operators: sorted, duplicates dropped. */
export function mergeSignatures(parts: (IndexedSignature | IndexedSignature[])[]): IndexedSignature[] {
  const byIndex = new Map<number, IndexedSignature>();
  for (const s of parts.flat()) {
    const seen = byIndex.get(s.publisherIndex);
    if (seen && seen.signature.toLowerCase() !== s.signature.toLowerCase()) {
      // Signing is deterministic, so two different signatures for one index means a mix-up.
      throw new Error(`conflicting signatures for publisher ${s.publisherIndex}`);
    }
    byIndex.set(s.publisherIndex, { publisherIndex: s.publisherIndex, signature: s.signature });
  }
  return toSignatureBundle([...byIndex.values()]);
}

/** Where an operation stands: which signatures are still missing before it can be sent. */
export function governanceStatus(
  current: PublisherSetData,
  next: PublisherSetData,
  operation: number,
  committee: Hex,
  authorization: IndexedSignature[],
  pop: IndexedSignature[],
) {
  const problem = transitionError(current, next, operation);
  if (problem) throw new Error(`invalid ${operationName(operation)}: ${problem}`);
  const authDigest = publisherSetUpdateHash(current, next, operation, committee);
  const validAuth = authorization.filter((s) => recoverSigner(authDigest, s.signature)?.toLowerCase() === current.current.pubkeys[s.publisherIndex]?.toLowerCase());
  const authorized = verifyThreshold(toSignatureBundle(authorization), authDigest, current.current);
  const needsPop = needsProofOfPossession(operation);
  const proven = !needsPop || (pop.length === next.current.pubkeys.length && verifyAll(toSignatureBundle(pop), publisherSetPopHash(next, committee), next.current));
  const popIndexes = new Set(pop.map((s) => s.publisherIndex));
  return {
    operation: operationName(operation),
    ready: authorized && proven,
    authorization: { have: authorization.length, need: quorum(current.current), valid: authorized, signers: validAuth.length },
    proofOfPossession: needsPop
      ? { have: pop.length, need: next.current.pubkeys.length, valid: proven, missing: next.current.pubkeys.filter((_, i) => !popIndexes.has(i)) }
      : "not needed",
  };
}
