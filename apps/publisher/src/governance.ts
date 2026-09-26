//! Committee key rotation, operator side. A rotation replaces the committee cell's key set; the
//! publisher_set_type script accepts it only with
//!   - an authorization: a quorum of the CURRENT set signing publisherSetUpdateHash(current, next, OP_ROTATE);
//!   - a proof of possession: EVERY key of the NEXT set signing publisherSetPopHash(next).
//! Each operator produces its signatures on its own machine with these helpers; the coordinator merges
//! them and sends the rotation with apps/deploy (`rotate:committee`).

import {
  OP_ROTATE,
  isValidPublisherSetData,
  publisherSetPopHash,
  publisherSetUpdateHash,
  quorum,
  recoverSigner,
  verifyAll,
  verifyThreshold,
  type Hex,
  type IndexedSignature,
  type PublisherSetData,
} from "lean-oracle-sdk/protocol";
import { toSignatureBundle } from "lean-oracle-sdk/publisher";

import type { KeySigner } from "./keySigner.js";

const COMPRESSED_KEY = /^0x0[23][0-9a-f]{64}$/;

/**
 * The next set: `current` with keys added and removed, sorted, set index and governance nonce + 1,
 * same network and flags (the continuity rules the script checks).
 */
export function nextSet(current: PublisherSetData, add: string[] = [], remove: string[] = []): PublisherSetData {
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
  const next: PublisherSetData = {
    networkId: current.networkId,
    governanceNonce: current.governanceNonce + 1n,
    governanceFlags: current.governanceFlags,
    current: { setIndex: current.current.setIndex + 1, pubkeys: [...keys].sort() },
  };
  if (!isValidPublisherSetData(next)) throw new Error("the next set is invalid: it needs 1 to 9 distinct keys");
  return next;
}

/** A readable summary of a set, for review before signing. */
export function describeSet(data: PublisherSetData, self?: Hex) {
  return {
    setIndex: data.current.setIndex,
    governanceNonce: data.governanceNonce.toString(),
    paused: (data.governanceFlags & 0x02) !== 0,
    publishers: data.current.pubkeys.length,
    quorum: quorum(data.current),
    pubkeys: data.current.pubkeys.map((k, index) => ({ index, pubkey: k, ...(self && k === self ? { you: true } : {}) })),
  };
}

/** What changes from `current` to `next`, for review before signing. */
export function diffSets(current: PublisherSetData, next: PublisherSetData) {
  const before = new Set(current.current.pubkeys);
  const after = new Set(next.current.pubkeys);
  return {
    added: next.current.pubkeys.filter((k) => !before.has(k)),
    removed: current.current.pubkeys.filter((k) => !after.has(k)),
    setIndex: `${current.current.setIndex} → ${next.current.setIndex}`,
    quorum: `${quorum(current.current)} of ${current.current.pubkeys.length} → ${quorum(next.current)} of ${next.current.pubkeys.length}`,
  };
}

/** Check that `next` is a valid successor of `current` (same rules as the script, minus signatures). */
export function checkSuccessor(current: PublisherSetData, next: PublisherSetData): void {
  if (!isValidPublisherSetData(next)) throw new Error("the next set is invalid");
  if (next.networkId.toLowerCase() !== current.networkId.toLowerCase()) throw new Error("the next set is for another network");
  if (next.governanceNonce !== current.governanceNonce + 1n) throw new Error("the next set's governance nonce must be the current one + 1");
  if (next.current.setIndex !== current.current.setIndex + 1) throw new Error("the next set's index must be the current one + 1");
}

/** This operator's authorization of `current → next`, as a member of the current set. */
export async function signRotation(current: PublisherSetData, next: PublisherSetData, signer: KeySigner): Promise<IndexedSignature> {
  checkSuccessor(current, next);
  const publisherIndex = current.current.pubkeys.indexOf(signer.publicKey);
  if (publisherIndex < 0) throw new Error("this key is not in the current set, so it cannot authorize a rotation");
  return { publisherIndex, signature: await signer.sign(publisherSetUpdateHash(current, next, OP_ROTATE)) };
}

/** This operator's proof of possession, as a member of the next set. */
export async function signProofOfPossession(next: PublisherSetData, signer: KeySigner): Promise<IndexedSignature> {
  const publisherIndex = next.current.pubkeys.indexOf(signer.publicKey);
  if (publisherIndex < 0) throw new Error("this key is not in the next set");
  return { publisherIndex, signature: await signer.sign(publisherSetPopHash(next)) };
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

/** Where a rotation stands: which signatures are still missing before it can be sent. */
export function rotationStatus(current: PublisherSetData, next: PublisherSetData, authorization: IndexedSignature[], pop: IndexedSignature[]) {
  checkSuccessor(current, next);
  const authDigest = publisherSetUpdateHash(current, next, OP_ROTATE);
  const popDigest = publisherSetPopHash(next);
  const validAuth = authorization.filter((s) => recoverSigner(authDigest, s.signature)?.toLowerCase() === current.current.pubkeys[s.publisherIndex]?.toLowerCase());
  const authorized = verifyThreshold(toSignatureBundle(authorization), authDigest, current.current);
  const proven = pop.length === next.current.pubkeys.length && verifyAll(toSignatureBundle(pop), popDigest, next.current);
  const popIndexes = new Set(pop.map((s) => s.publisherIndex));
  return {
    ready: authorized && proven,
    authorization: { have: authorization.length, need: quorum(current.current), valid: authorized, signers: validAuth.length },
    proofOfPossession: {
      have: pop.length,
      need: next.current.pubkeys.length,
      valid: proven,
      missing: next.current.pubkeys.filter((_, i) => !popIndexes.has(i)),
    },
  };
}
