//! Chain reads: committee cells and feed cells.

import { ccc } from "@ckb-ccc/core";

import { decodePriceFeedData, type PriceFeedData } from "../protocol/priceFeed.js";
import { decodePublisherSetData, type PublisherSetData } from "../protocol/publisherSet.js";
import type { LeanOracleDeployment } from "../presets/deployment.js";
import type { CellDepInfo, Hex, Script } from "../types.js";

export interface LiveCell<T> {
  data: T;
  cell: ccc.Cell;
  outPoint: { txHash: Hex; index: number };
  cellDep: CellDepInfo;
  typeHash: Hex;
}

function live<T>(cell: ccc.Cell, data: T): LiveCell<T> {
  const outPoint = { txHash: cell.outPoint.txHash as Hex, index: Number(cell.outPoint.index) };
  return { data, cell, outPoint, cellDep: { outPoint, depType: "code" }, typeHash: cell.cellOutput.type!.hash() as Hex };
}

async function only(client: ccc.Client, script: Script): Promise<ccc.Cell | undefined> {
  let found: ccc.Cell | undefined;
  for await (const cell of client.findCells({ script, scriptType: "type", scriptSearchMode: "exact", withData: true })) {
    if (found) throw new Error("more than one live cell has this Type ID type script");
    found = cell;
  }
  return found;
}

/** The live committee cell for a committee type script (resolved fresh: rotation moves it). */
export async function findCommitteeCell(client: ccc.Client, typeScript: Script): Promise<LiveCell<PublisherSetData> | undefined> {
  const cell = await only(client, typeScript);
  return cell && live(cell, decodePublisherSetData(cell.outputData as Hex));
}

/** A feed cell by its (Type ID-unique) type script. */
export async function getFeedCell(client: ccc.Client, typeScript: Script): Promise<LiveCell<PriceFeedData> | undefined> {
  const cell = await only(client, typeScript);
  return cell && live(cell, decodePriceFeedData(cell.outputData as Hex));
}

/**
 * Every live feed cell for `feedId` anchored to `committeeTypeHash` (type-args prefix search).
 * Anyone can create feed cells; this filters to the given committee.
 */
export async function findFeedCells(
  client: ccc.Client,
  deployment: LeanOracleDeployment,
  feedId: Hex,
  committeeTypeHash: Hex,
): Promise<LiveCell<PriceFeedData>[]> {
  const out: LiveCell<PriceFeedData>[] = [];
  // Feed cells created under any deployed contract version.
  for (const { codeHash, hashType } of Object.values(deployment.contractVersions?.priceFeedType ?? { 0: deployment.contracts.priceFeedType })) {
    for await (const cell of client.findCells({ script: { codeHash, hashType, args: feedId }, scriptType: "type", scriptSearchMode: "prefix", withData: true })) {
      try {
        const data = decodePriceFeedData(cell.outputData as Hex);
        if (data.publisherSetTypeHash.toLowerCase() === committeeTypeHash.toLowerCase()) out.push(live(cell, data));
      } catch {
        // Not a well-formed feed cell.
      }
    }
  }
  return out;
}
