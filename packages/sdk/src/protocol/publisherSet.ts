//! Committee (PublisherSet) cell data. Mirrors contracts/common/src/publisher_set.rs.

import { DecodeError } from "../errors.js";
import { bytesToHex, compareBytes, hexToFixed, type BytesLike, toBytes } from "../internal/bytes.js";
import { Reader, Writer } from "../internal/codec.js";
import type { Hex } from "../types.js";
import { GOVERNANCE_LOCKED, MAX_PUBLISHERS, PUBLISHER_SET_MAGIC, PUBLISHER_SET_VERSION } from "./constants.js";
import { ckbHash, DOMAIN_SET_POP, DOMAIN_SET_STATE, DOMAIN_SET_UPDATE } from "./hash.js";

export interface PublisherSet {
  setIndex: number;
  /** Compressed secp256k1 keys (33 bytes), strictly ascending. */
  pubkeys: Hex[];
}

export interface PublisherSetData {
  networkId: Hex;
  governanceNonce: bigint;
  governanceFlags: number;
  current: PublisherSet;
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
  if (!isValidPublisherSet(data.current)) return false;
  return !((data.governanceFlags & GOVERNANCE_LOCKED) !== 0 && quorum(data.current) * 2 <= data.current.pubkeys.length);
}

export function encodePublisherSetData(data: PublisherSetData): Uint8Array {
  const writer = new Writer()
    .bytes(MAGIC)
    .u8(PUBLISHER_SET_VERSION)
    .bytes(hexToFixed(data.networkId, 32, "networkId"))
    .u64(data.governanceNonce)
    .u8(data.governanceFlags)
    .u8(0)
    .u32(data.current.setIndex)
    .u8(data.current.pubkeys.length);
  for (const key of data.current.pubkeys) writer.bytes(hexToFixed(key, 33, "pubkey"));
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
  const setIndex = reader.u32();
  const count = reader.u8();
  const pubkeys = Array.from({ length: count }, () => bytesToHex(reader.bytes(33)));
  reader.end();
  const data = { networkId, governanceNonce, governanceFlags, current: { setIndex, pubkeys } };
  if (!isValidPublisherSetData(data)) throw new DecodeError("PublisherSetData: invalid publisher set");
  return data;
}

export function publisherSetStateHash(data: PublisherSetData): Hex {
  return bytesToHex(ckbHash(DOMAIN_SET_STATE, encodePublisherSetData(data)));
}

/** Digest the current set's quorum signs to authorize `current → next`. */
export function publisherSetUpdateHash(current: PublisherSetData, next: PublisherSetData, operation: number): Hex {
  return bytesToHex(
    ckbHash(DOMAIN_SET_UPDATE, Uint8Array.of(operation), toBytes(publisherSetStateHash(current)), toBytes(publisherSetStateHash(next))),
  );
}

/** Digest every key of `next` signs to prove possession. */
export function publisherSetPopHash(next: PublisherSetData): Hex {
  return bytesToHex(ckbHash(DOMAIN_SET_POP, toBytes(publisherSetStateHash(next))));
}

/** Current-set-only: the active set if `setIndex` is current. */
export function activeSet(data: PublisherSetData, setIndex: number): PublisherSet | undefined {
  return setIndex === data.current.setIndex ? data.current : undefined;
}
