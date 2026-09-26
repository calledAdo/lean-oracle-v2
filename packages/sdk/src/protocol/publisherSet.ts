//! Committee (PublisherSet v2) cell data and governance transitions. Mirrors
//! contracts/common/src/publisher_set.rs.

import { DecodeError } from "../errors.js";
import { bytesToHex, compareBytes, hexToFixed, type BytesLike, toBytes } from "../internal/bytes.js";
import { Reader, Writer } from "../internal/codec.js";
import type { Hex } from "../types.js";
import {
  GOVERNANCE_LOCKED,
  GOVERNANCE_PAUSED,
  MAX_PUBLISHERS,
  OP_PAUSE,
  OP_REVOKE_PREVIOUS,
  OP_ROTATE,
  OP_ROTATE_REVOKE,
  OP_UNPAUSE,
  PUBLISHER_SET_MAGIC,
  PUBLISHER_SET_VERSION,
} from "./constants.js";
import { ckbHash, DOMAIN_SET_POP, DOMAIN_SET_STATE, DOMAIN_SET_UPDATE } from "./hash.js";

export interface PublisherSet {
  setIndex: number;
  /** Compressed secp256k1 keys (33 bytes), strictly ascending. */
  pubkeys: Hex[];
}

/** The set that signed before the current one; it verifies only ticks before `untilMs`. */
export interface PreviousSet {
  set: PublisherSet;
  /** First tick of the current set. */
  untilMs: bigint;
}

export interface PublisherSetData {
  networkId: Hex;
  governanceNonce: bigint;
  governanceFlags: number;
  /** Minimum age of the committee cell before a routine rotation (relative `since`, seconds). */
  minRotationIntervalS: bigint;
  current: PublisherSet;
  previous?: PreviousSet;
}

const MAGIC = new TextEncoder().encode(PUBLISHER_SET_MAGIC);

/** Signatures required: `floor(2n/3) + 1`. */
export function quorum(set: PublisherSet): number {
  return Math.floor((2 * set.pubkeys.length) / 3) + 1;
}

export function isValidPublisherSet(set: PublisherSet): boolean {
  const keys = set.pubkeys.map((key) => hexToFixed(key, 33, "pubkey"));
  return (
    keys.length > 0 &&
    keys.length <= MAX_PUBLISHERS &&
    keys.every((key, i) => (key[0] === 2 || key[0] === 3) && (i === 0 || compareBytes(keys[i - 1]!, key) < 0))
  );
}

export function isValidPublisherSetData(data: PublisherSetData): boolean {
  if (!isValidPublisherSet(data.current) || data.minRotationIntervalS <= 0n) return false;
  if ((data.governanceFlags & ~(GOVERNANCE_LOCKED | GOVERNANCE_PAUSED)) !== 0) return false;
  const p = data.previous;
  return !p || (isValidPublisherSet(p.set) && p.untilMs > 0n && p.set.setIndex + 1 === data.current.setIndex);
}

function writeSet(writer: Writer, set: PublisherSet): void {
  writer.u32(set.setIndex).u8(set.pubkeys.length);
  for (const key of set.pubkeys) writer.bytes(hexToFixed(key, 33, "pubkey"));
}

function readSet(reader: Reader): PublisherSet {
  const setIndex = reader.u32();
  const count = reader.u8();
  return { setIndex, pubkeys: Array.from({ length: count }, () => bytesToHex(reader.bytes(33))) };
}

export function encodePublisherSetData(data: PublisherSetData): Uint8Array {
  const writer = new Writer()
    .bytes(MAGIC)
    .u8(PUBLISHER_SET_VERSION)
    .bytes(hexToFixed(data.networkId, 32, "networkId"))
    .u64(data.governanceNonce)
    .u8(data.governanceFlags)
    .u8(0)
    .u64(data.minRotationIntervalS);
  writeSet(writer, data.current);
  if (data.previous) {
    writer.u8(1);
    writeSet(writer, data.previous.set);
    writer.u64(data.previous.untilMs);
  } else {
    writer.u8(0);
  }
  return writer.finish();
}

export function decodePublisherSetData(bytes: BytesLike): PublisherSetData {
  const reader = new Reader(toBytes(bytes), "PublisherSetData");
  if (new TextDecoder().decode(reader.bytes(4)) !== PUBLISHER_SET_MAGIC || reader.u8() !== PUBLISHER_SET_VERSION) {
    throw new DecodeError("PublisherSetData: bad magic or version");
  }
  const networkId = bytesToHex(reader.bytes(32));
  const governanceNonce = reader.u64();
  const governanceFlags = reader.u8();
  if (reader.u8() !== 0) throw new DecodeError("PublisherSetData: reserved byte must be zero");
  const minRotationIntervalS = reader.u64();
  const current = readSet(reader);
  const marker = reader.u8();
  let previous: PreviousSet | undefined;
  if (marker === 1) {
    const set = readSet(reader);
    previous = { set, untilMs: reader.u64() };
  } else if (marker !== 0) {
    throw new DecodeError("PublisherSetData: bad previous-set marker");
  }
  reader.end();
  const data: PublisherSetData = { networkId, governanceNonce, governanceFlags, minRotationIntervalS, current, ...(previous ? { previous } : {}) };
  if (!isValidPublisherSetData(data)) throw new DecodeError("PublisherSetData: invalid publisher set");
  return data;
}

export function publisherSetStateHash(data: PublisherSetData): Hex {
  return bytesToHex(ckbHash(DOMAIN_SET_STATE, encodePublisherSetData(data)));
}

/**
 * Digest the current quorum signs for `current → next` under `operation`, bound to one committee cell
 * (`committeeTypeHash`), so it cannot be replayed on another committee with identical state.
 */
export function publisherSetUpdateHash(current: PublisherSetData, next: PublisherSetData, operation: number, committeeTypeHash: Hex): Hex {
  return bytesToHex(
    ckbHash(
      DOMAIN_SET_UPDATE,
      hexToFixed(committeeTypeHash, 32, "committeeTypeHash"),
      Uint8Array.of(operation),
      toBytes(publisherSetStateHash(current)),
      toBytes(publisherSetStateHash(next)),
    ),
  );
}

/** Digest every key of `next` signs to prove possession, bound to one committee cell. */
export function publisherSetPopHash(next: PublisherSetData, committeeTypeHash: Hex): Hex {
  return bytesToHex(ckbHash(DOMAIN_SET_POP, hexToFixed(committeeTypeHash, 32, "committeeTypeHash"), toBytes(publisherSetStateHash(next))));
}

export function isPaused(data: PublisherSetData): boolean {
  return (data.governanceFlags & GOVERNANCE_PAUSED) !== 0;
}

/**
 * The set that may have signed an update with `setIndex` at tick `publishTimeMs`: the current set, or
 * the previous set for ticks before its `untilMs`.
 */
export function setFor(data: PublisherSetData, setIndex: number, publishTimeMs: bigint): PublisherSet | undefined {
  if (setIndex === data.current.setIndex) return data.current;
  const p = data.previous;
  return p && p.set.setIndex === setIndex && publishTimeMs < p.untilMs ? p.set : undefined;
}

/** Whether prices signed by `setIndex` are still trusted: the current set or a non-revoked previous set. */
export function trustsSet(data: PublisherSetData, setIndex: number): boolean {
  return setIndex === data.current.setIndex || data.previous?.set.setIndex === setIndex;
}

/** Operations that change keys need proof of possession from every new key. */
export function needsProofOfPossession(operation: number): boolean {
  return operation === OP_ROTATE || operation === OP_ROTATE_REVOKE;
}

/** Only a routine rotation waits `minRotationIntervalS`. */
export function needsRotationInterval(operation: number): boolean {
  return operation === OP_ROTATE;
}

const sameSet = (a: PublisherSet, b: PublisherSet) => a.setIndex === b.setIndex && a.pubkeys.join() === b.pubkeys.join();
const samePrevious = (a?: PreviousSet, b?: PreviousSet) => (!a && !b) || (!!a && !!b && a.untilMs === b.untilMs && sameSet(a.set, b.set));

/**
 * Why `next` is not what `operation` produces from `current` (undefined when it is). Same rules as the
 * contract's `check_transition`; signatures, PoP and the interval are checked separately.
 */
export function transitionError(current: PublisherSetData, next: PublisherSetData, operation: number): string | undefined {
  if (
    next.networkId.toLowerCase() !== current.networkId.toLowerCase() ||
    next.governanceNonce !== current.governanceNonce + 1n ||
    next.minRotationIntervalS !== current.minRotationIntervalS ||
    ((current.governanceFlags & GOVERNANCE_LOCKED) !== 0 && (next.governanceFlags & GOVERNANCE_LOCKED) === 0)
  ) {
    return "continuity: nonce must advance by one; network, interval and the LOCKED flag must not change";
  }
  const sameFlags = next.governanceFlags === current.governanceFlags;
  const sameSets = sameSet(next.current, current.current) && samePrevious(next.previous, current.previous);
  const nextIndex = next.current.setIndex === current.current.setIndex + 1;
  switch (operation) {
    case OP_ROTATE:
      return sameFlags && nextIndex && next.previous && sameSet(next.previous.set, current.current) && (!current.previous || next.previous.untilMs > current.previous.untilMs)
        ? undefined
        : "rotate: next set index +1, the current set becomes previous with a later switch tick, flags unchanged";
    case OP_ROTATE_REVOKE:
      return sameFlags && nextIndex && !next.previous ? undefined : "rotate-revoke: next set index +1, no previous set, flags unchanged";
    case OP_PAUSE:
      return !isPaused(current) && next.governanceFlags === (current.governanceFlags | GOVERNANCE_PAUSED) && sameSets ? undefined : "pause: only sets the paused flag";
    case OP_UNPAUSE:
      return isPaused(current) && next.governanceFlags === (current.governanceFlags & ~GOVERNANCE_PAUSED) && sameSets ? undefined : "unpause: only clears the paused flag";
    case OP_REVOKE_PREVIOUS:
      return sameFlags && current.previous && !next.previous && sameSet(next.current, current.current) ? undefined : "revoke-previous: drops the previous set only";
    default:
      return `unknown operation ${operation}`;
  }
}
