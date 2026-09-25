//! A publisher's signed per-tick observation (off-chain; docs/oracle-design.md section 5).
//!
//! `magic "TPOB" | version u8 | publisher_set_type_hash [32] | set_index u32 | tick_ms u64 |
//!  config_hash [32] | publisher_index u8 | entry_count u8 | entries`, entries strictly ascending by
//! feed id: `feed_id [32] | price i64 | conf u64 | source_time_ms u64`.
//! Signed as `ckbHash("LEAN/OBSERVATION/V1" || bytes)`.

import { DecodeError } from "../errors.js";
import { bytesToHex, compareBytes, equalBytes, hexToBytes, hexToFixed, type BytesLike, toBytes } from "../internal/bytes.js";
import { Reader, Writer } from "../internal/codec.js";
import type { Hex } from "../types.js";
import { OBSERVATION_ENTRY_LEN, OBSERVATION_HEADER_LEN, OBSERVATION_MAGIC, OBSERVATION_VERSION, SIGNATURE_LEN } from "./constants.js";
import { ckbHash, DOMAIN_OBSERVATION } from "./hash.js";
import type { PublisherSet } from "./publisherSet.js";
import { recoverSigner } from "./signatures.js";

export interface ObservationEntry {
  feedId: Hex;
  price: bigint;
  conf: bigint;
  sourceTimeMs: bigint;
}

export interface Observation {
  publisherSetTypeHash: Hex;
  setIndex: number;
  tickMs: bigint;
  configHash: Hex;
  publisherIndex: number;
  entries: ObservationEntry[];
}

export interface SignedObservation {
  observation: Observation;
  signature: Hex;
}

const MAGIC = new TextEncoder().encode(OBSERVATION_MAGIC);

function assertSortedUnique(entries: ObservationEntry[]): void {
  entries.forEach((entry, i) => {
    if (i > 0 && compareBytes(hexToBytes(entries[i - 1]!.feedId), hexToBytes(entry.feedId)) >= 0) {
      throw new RangeError("Observation: entries must be strictly ascending by feed id");
    }
  });
}

export function encodeObservation(observation: Observation): Uint8Array {
  assertSortedUnique(observation.entries);
  const writer = new Writer()
    .bytes(MAGIC)
    .u8(OBSERVATION_VERSION)
    .bytes(hexToFixed(observation.publisherSetTypeHash, 32, "publisherSetTypeHash"))
    .u32(observation.setIndex)
    .u64(observation.tickMs)
    .bytes(hexToFixed(observation.configHash, 32, "configHash"))
    .u8(observation.publisherIndex)
    .u8(observation.entries.length);
  for (const entry of observation.entries) {
    writer.bytes(hexToFixed(entry.feedId, 32, "feedId")).i64(entry.price).u64(entry.conf).u64(entry.sourceTimeMs);
  }
  return writer.finish();
}

export function decodeObservation(bytes: BytesLike): Observation {
  const data = toBytes(bytes);
  const reader = new Reader(data, "Observation");
  if (new TextDecoder().decode(reader.bytes(4)) !== OBSERVATION_MAGIC || reader.u8() !== OBSERVATION_VERSION) {
    throw new DecodeError("Observation: bad magic or version");
  }
  const publisherSetTypeHash = bytesToHex(reader.bytes(32));
  const setIndex = reader.u32();
  const tickMs = reader.u64();
  const configHash = bytesToHex(reader.bytes(32));
  const publisherIndex = reader.u8();
  const count = reader.u8();
  if (data.length !== OBSERVATION_HEADER_LEN + count * OBSERVATION_ENTRY_LEN) throw new DecodeError("Observation: bad length");
  const entries = Array.from({ length: count }, () => ({
    feedId: bytesToHex(reader.bytes(32)),
    price: reader.i64(),
    conf: reader.u64(),
    sourceTimeMs: reader.u64(),
  }));
  reader.end();
  try {
    assertSortedUnique(entries);
  } catch (error) {
    throw new DecodeError((error as Error).message);
  }
  return { publisherSetTypeHash, setIndex, tickMs, configHash, publisherIndex, entries };
}

export function observationSigningHash(observation: Observation): Hex {
  return bytesToHex(ckbHash(DOMAIN_OBSERVATION, encodeObservation(observation)));
}

/** Wire form: observation bytes followed by the 65-byte signature. */
export function encodeSignedObservation(signed: SignedObservation): Uint8Array {
  const body = encodeObservation(signed.observation);
  const out = new Uint8Array(body.length + SIGNATURE_LEN);
  out.set(body);
  out.set(hexToFixed(signed.signature, SIGNATURE_LEN, "signature"), body.length);
  return out;
}

export function decodeSignedObservation(bytes: BytesLike): SignedObservation {
  const data = toBytes(bytes);
  if (data.length < SIGNATURE_LEN) throw new DecodeError("SignedObservation: truncated");
  return {
    observation: decodeObservation(data.slice(0, data.length - SIGNATURE_LEN)),
    signature: bytesToHex(data.slice(data.length - SIGNATURE_LEN)),
  };
}

/** The signature recovers to the key at `publisherIndex` in `set`, and `set` is the observation's set. */
export function verifyObservation(signed: SignedObservation, set: PublisherSet): boolean {
  const { observation } = signed;
  const expected = set.pubkeys[observation.publisherIndex];
  if (expected === undefined || observation.setIndex !== set.setIndex) return false;
  const recovered = recoverSigner(observationSigningHash(observation), signed.signature);
  return recovered !== undefined && equalBytes(toBytes(recovered), toBytes(expected));
}
