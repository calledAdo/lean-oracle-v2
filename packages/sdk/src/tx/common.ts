import { ccc } from "@ckb-ccc/core";

import { bytesToHex, concatBytes } from "../internal/bytes.js";
import type { CellDepInfo, Hex } from "../types.js";

export function cellDep(dep: CellDepInfo): ccc.CellDepLike {
  return { outPoint: { txHash: dep.outPoint.txHash, index: dep.outPoint.index }, depType: dep.depType };
}

/** A plain cell (no type, empty data) of `signer`, pinned as an input so a Type ID can be derived from it. */
export async function plainInputOf(signer: ccc.Signer): Promise<ccc.CellInput> {
  const { script } = await signer.getRecommendedAddressObj();
  for await (const cell of signer.client.findCellsByLock(script, null, true)) {
    if (!cell.cellOutput.type && cell.outputData === "0x") return ccc.CellInput.from({ previousOutput: cell.outPoint });
  }
  throw new Error("signer has no plain cell to fund the transaction");
}

/** Put `inputType` into the witness at `index`, keeping any lock witness already there. */
export function setInputType(tx: ccc.Transaction, index: number, inputType: Uint8Array): void {
  const witness = tx.getWitnessArgsAt(index) ?? ccc.WitnessArgs.from({});
  witness.inputType = bytesToHex(inputType);
  tx.setWitnessArgsAt(index, witness);
}

export function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

export { bytesToHex, concatBytes, type Hex };
