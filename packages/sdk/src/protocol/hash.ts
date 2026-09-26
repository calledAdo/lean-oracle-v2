//! blake2b-256 with CKB's personalization, domain tags, feed ids and Type ID seeds.

import { blake2b } from "@noble/hashes/blake2b";

import { bytesToHex, concatBytes, type BytesLike, toBytes } from "../internal/bytes.js";
import type { Hex } from "../types.js";

const encoder = new TextEncoder();
const CKB_PERSONALIZATION = encoder.encode("ckb-default-hash");

export const DOMAIN_SET_STATE = encoder.encode("LEAN/PUBLISHER_SET_STATE/V2");
export const DOMAIN_SET_UPDATE = encoder.encode("LEAN/PUBLISHER_SET_UPDATE/V2");
export const DOMAIN_SET_POP = encoder.encode("LEAN/PUBLISHER_SET_POP/V2");
export const DOMAIN_FEED = encoder.encode("LEAN/FEED/V1");
export const DOMAIN_PRICE_UPDATE = encoder.encode("LEAN/PRICE_UPDATE/V1");
export const DOMAIN_PRICE_LEAF = encoder.encode("LEAN/PRICE_LEAF/V1");
export const DOMAIN_PRICE_NODE = encoder.encode("LEAN/PRICE_NODE/V1");
export const DOMAIN_OBSERVATION = encoder.encode("LEAN/OBSERVATION/V1");
export const DOMAIN_COMMITTEE_CONFIG = encoder.encode("LEAN/COMMITTEE_CONFIG/V1");
export const DOMAIN_LEADER_ORDER = encoder.encode("LEAN/LEADER_ORDER/V1");
export const DOMAIN_PEER_HELLO = encoder.encode("LEAN/PEER_HELLO/V1");

/** CKB's default hash: blake2b-256 personalized with `ckb-default-hash`. */
export function ckbHash(...parts: Uint8Array[]): Uint8Array {
  return blake2b(concatBytes(...parts), { dkLen: 32, personalization: CKB_PERSONALIZATION });
}

/** Canonical feed id, e.g. `feedId("Crypto.BTC/USD")`. */
export function feedId(symbol: string): Hex {
  return bytesToHex(ckbHash(DOMAIN_FEED, encoder.encode(symbol)));
}

/** Type ID seed: `ckbHash(first_input || output_index as u64 LE)`. `firstInput` is the serialized CellInput. */
export function typeIdSeed(firstInput: BytesLike, outputIndex: number | bigint): Hex {
  const index = new Uint8Array(8);
  new DataView(index.buffer).setBigUint64(0, BigInt(outputIndex), true);
  return bytesToHex(ckbHash(toBytes(firstInput), index));
}
