//! Committee (PublisherSet) cell builders. Rotation is authorized by the current quorum inside the
//! type script; the cell's lock only guards against destruction and must stay unchanged.

import { ccc } from "@ckb-ccc/core";

import { findCommitteeCell } from "../ckb/cells.js";
import { publisherSetTypeScript } from "../ckb/scripts.js";
import { computeTypeId } from "../ckb/typeId.js";
import { codeRefFor, type LeanOracleDeployment } from "../presets/deployment.js";
import { OP_ROTATE } from "../protocol/constants.js";
import { encodePublisherSetData, isValidPublisherSetData, type PublisherSetData } from "../protocol/publisherSet.js";
import { encodeSignatureBundle, type SignatureBundle } from "../protocol/signatures.js";
import type { Hex, Script } from "../types.js";
import { occupiedCapacity } from "./cellCapacity.js";
import { cellDep, concatBytes, plainInputOf, setInputType } from "./common.js";

export interface BootstrapCommitteeParams {
  signer: ccc.Signer;
  deployment: LeanOracleDeployment;
  /** Initial committee: `governanceNonce` 0 and `setIndex` 0. */
  data: PublisherSetData;
  lock?: Script;
}

export async function bootstrapCommittee(p: BootstrapCommitteeParams): Promise<{ tx: ccc.Transaction; typeScript: Script; typeHash: Hex }> {
  if (p.data.governanceNonce !== 0n || p.data.current.setIndex !== 0 || !isValidPublisherSetData(p.data)) {
    throw new Error("a new committee needs nonce 0, set index 0 and a valid key set");
  }
  const lock = p.lock ?? ((await p.signer.getRecommendedAddressObj()).script as unknown as Script);
  const firstInput = await plainInputOf(p.signer);
  const typeScript = publisherSetTypeScript(p.deployment, computeTypeId(firstInput, 0));
  const dataHex = ccc.hexFrom(encodePublisherSetData(p.data)) as Hex;
  const tx = ccc.Transaction.from({});
  tx.addInput(firstInput);
  tx.addOutput({ lock, type: typeScript, capacity: occupiedCapacity(lock, typeScript, dataHex) }, dataHex);
  tx.addCellDeps(cellDep(p.deployment.contracts.publisherSetType.cellDep));
  return { tx, typeScript, typeHash: ccc.Script.from(typeScript).hash() as Hex };
}

export interface RotateCommitteeParams {
  client: ccc.Client;
  deployment: LeanOracleDeployment;
  committee: Script;
  next: PublisherSetData;
  /** Current-set quorum over `publisherSetUpdateHash(current, next, OP_ROTATE)`. */
  authorization: SignatureBundle;
  /** Every next-set key over `publisherSetPopHash(next)`, in index order. */
  proofOfPossession: SignatureBundle;
}

export async function rotateCommittee(p: RotateCommitteeParams): Promise<ccc.Transaction> {
  const current = await findCommitteeCell(p.client, p.committee);
  if (!current) throw new Error("committee cell not found");
  const dataHex = ccc.hexFrom(encodePublisherSetData(p.next));
  const tx = ccc.Transaction.from({});
  tx.addInput(ccc.CellInput.from({ previousOutput: current.cell.outPoint }));
  const output = ccc.CellOutput.from(current.cell.cellOutput);
  const needed = occupiedCapacity(output.lock as unknown as Script, output.type as unknown as Script, dataHex as Hex);
  if (output.capacity < needed) output.capacity = needed;
  tx.addOutput(output, dataHex);
  // The committee keeps the contract version it was created under.
  tx.addCellDeps(cellDep(codeRefFor(p.deployment, "publisherSetType", current.cell.cellOutput.type!.codeHash as Hex).cellDep));
  setInputType(tx, 0, concatBytes(Uint8Array.of(OP_ROTATE), encodeSignatureBundle(p.authorization), encodeSignatureBundle(p.proofOfPossession)));
  return tx;
}
