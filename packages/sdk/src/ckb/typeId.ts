//! Type ID from a transaction's first input: `ckbHash(serialized CellInput || output_index u64 LE)`.

import { ccc } from "@ckb-ccc/core";

import { typeIdSeed } from "../protocol/hash.js";
import type { Hex } from "../types.js";

export function computeTypeId(firstInput: ccc.CellInputLike, outputIndex: number | bigint): Hex {
  return typeIdSeed(ccc.hexFrom(ccc.CellInput.from(firstInput).toBytes()) as Hex, outputIndex);
}
