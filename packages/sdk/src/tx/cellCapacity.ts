//! Minimum (occupied) capacity for a cell, in shannons. A CKB cell must hold at
//! least 1 CKB per byte of (capacity field + lock + type + data); these builders
//! create non-fee cells at exactly that floor and let fee completion add change.

import { ccc } from "@ckb-ccc/core";

import type { Hex, Script } from "../types.js";

/** Occupied capacity (shannons) for a cell with this lock/type and data hex. */
export function occupiedCapacity(
  lock: Script,
  type: Script | undefined,
  dataHex: Hex,
): bigint {
  const out = ccc.CellOutput.from({ lock, type, capacity: 0n });
  const dataLen = (dataHex.length - 2) / 2;
  return ccc.fixedPointFrom(out.occupiedSize + dataLen);
}
