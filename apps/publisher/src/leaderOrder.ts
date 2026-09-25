//! Per-tick leader order (docs/oracle-design.md section 5). Seeded by the latest finalized update at
//! or before `tick − 2 × period` (the anchor), so the order is unpredictable until about two ticks
//! ahead, yet every synced publisher computes it identically.

import { bytesToHex, ckbHash, DOMAIN_LEADER_ORDER, hexToBytes, type Hex } from "lean-oracle-sdk/protocol";

export const NO_ANCHOR: Hex = `0x${"00".repeat(32)}`;

/** Publisher indexes ordered by `ckbHash(domain || tick || anchor || index)`, ascending. */
export function leaderOrder(tickMs: bigint, anchorHash: Hex, n: number): number[] {
  const tick = new Uint8Array(8);
  new DataView(tick.buffer).setBigUint64(0, tickMs, true);
  const anchor = hexToBytes(anchorHash);
  const keyed = Array.from({ length: n }, (_, i) => ({ i, key: bytesToHex(ckbHash(DOMAIN_LEADER_ORDER, tick, anchor, Uint8Array.of(i))) }));
  return keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || a.i - b.i).map((k) => k.i);
}

/** When rank `r` may propose: rank 0 from the tick, rank r ≥ 1 from `tick + r × deadline`. */
export function slotOpensAt(tickMs: bigint, rank: number, observationDeadlineMs: number): bigint {
  return tickMs + BigInt(rank * observationDeadlineMs);
}
