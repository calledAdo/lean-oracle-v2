//! Feed cell builders (docs/oracle-design.md section 7). Each returns an unsigned transaction without
//! fees; finish with `completeFeeAndChange(tx, signer)` and `signer.sendTransaction(tx)`.

import { ccc } from "@ckb-ccc/core";

import { findCommitteeCell, getFeedCell } from "../ckb/cells.js";
import { priceFeedTypeScript } from "../ckb/scripts.js";
import { computeTypeId } from "../ckb/typeId.js";
import { toBytes, type BytesLike } from "../internal/bytes.js";
import { codeRefFor, type LeanOracleDeployment } from "../presets/deployment.js";
import { applyVerifiedPrice, encodePriceFeedData, uninitializedPriceFeed, type PriceFeedData } from "../protocol/priceFeed.js";
import { decodePriceUpdate, encodePriceUpdate, selectFeeds, type PriceUpdate } from "../protocol/priceUpdate.js";
import { verifyPriceUpdate, type VerifiedPrice } from "../protocol/verify.js";
import type { Hex, Script } from "../types.js";
import { occupiedCapacity } from "./cellCapacity.js";
import { cellDep, concatBytes, plainInputOf, setInputType, u32le } from "./common.js";

/** Feed cell witness: `update_len u32 LE || update blob`, in `input_type`. */
export function encodeFeedWitness(blob: BytesLike): Uint8Array {
  const bytes = toBytes(blob);
  return concatBytes(u32le(bytes.length), bytes);
}

export interface CreateFeedCellParams {
  signer: ccc.Signer;
  deployment: LeanOracleDeployment;
  feedId: Hex;
  /** Committee type script the cell trusts (its live cell is added as a dep). */
  committee: Script;
  /** Lock of the new cell; defaults to the signer's own lock. */
  lock?: Script;
}

export async function createFeedCell(p: CreateFeedCellParams): Promise<{ tx: ccc.Transaction; typeScript: Script; typeHash: Hex }> {
  const committeeCell = await findCommitteeCell(p.signer.client, p.committee);
  if (!committeeCell) throw new Error("committee cell not found");
  const lock = p.lock ?? ((await p.signer.getRecommendedAddressObj()).script as unknown as Script);
  const firstInput = await plainInputOf(p.signer);
  const typeScript = priceFeedTypeScript(p.deployment, p.feedId, computeTypeId(firstInput, 0));
  const data = encodePriceFeedData(uninitializedPriceFeed(p.feedId, committeeCell.typeHash));
  const dataHex = ccc.hexFrom(data) as Hex;

  const tx = ccc.Transaction.from({});
  tx.addInput(firstInput);
  tx.addOutput({ lock, type: typeScript, capacity: occupiedCapacity(lock, typeScript, dataHex) }, dataHex);
  tx.addCellDeps(cellDep(p.deployment.contracts.priceFeedType.cellDep), cellDep(committeeCell.cellDep));
  return { tx, typeScript, typeHash: ccc.Script.from(typeScript).hash() as Hex };
}

export interface UpdateFeedCellParams {
  client: ccc.Client;
  deployment: LeanOracleDeployment;
  /** The feed cell's type script. */
  feedType: Script;
  /** A finalized update (blob or decoded) containing this feed. */
  update: BytesLike | PriceUpdate;
}

export interface UpdateFeedCellResult {
  tx: ccc.Transaction;
  verified: VerifiedPrice;
  before: PriceFeedData;
  after: PriceFeedData;
}

export interface UpdateFeedCellsParams {
  client: ccc.Client;
  deployment: LeanOracleDeployment;
  /** Feed cells of one committee to move forward together. */
  feedTypes: Script[];
  /** One finalized update (blob or decoded) containing every one of these feeds. */
  update: BytesLike | PriceUpdate;
}

export interface UpdateFeedCellsResult {
  tx: ccc.Transaction;
  feeds: { feedType: Script; verified: VerifiedPrice; before: PriceFeedData; after: PriceFeedData }[];
}

/**
 * Move several feed cells of one committee forward to the same update, in one transaction. The feed
 * cells are inputs 0..n-1; input 0 is the leader and its witness carries the only blob (every
 * requested feed with its proof), so the committee's signatures are checked once on chain. Each price
 * is verified against the live committee cell first, so a transaction the contract would reject is
 * never built. Every feed cell's lock must be satisfied by the caller's signer.
 */
export async function updateFeedCells(p: UpdateFeedCellsParams): Promise<UpdateFeedCellsResult> {
  if (p.feedTypes.length === 0) throw new Error("no feed cells given");
  const decoded = typeof p.update === "string" || p.update instanceof Uint8Array ? decodePriceUpdate(p.update) : p.update;
  const cells = await Promise.all(
    p.feedTypes.map(async (feedType) => {
      const feed = await getFeedCell(p.client, feedType);
      if (!feed) throw new Error("feed cell not found");
      return { feedType, feed };
    }),
  );
  const committeeHash = cells[0]!.feed.data.publisherSetTypeHash.toLowerCase();
  if (cells.some((c) => c.feed.data.publisherSetTypeHash.toLowerCase() !== committeeHash)) {
    throw new Error("all feed cells in one transaction must trust the same committee");
  }
  const ids = cells.map((c) => c.feed.data.feedId.toLowerCase());
  if (new Set(ids).size !== ids.length) throw new Error("each feed may appear once per transaction");
  const committeeCell = await findCommitteeCellByHash(p.client, p.deployment, cells[0]!.feed.data.publisherSetTypeHash);

  const tx = ccc.Transaction.from({});
  const codeDeps = new Map<string, ReturnType<typeof cellDep>>();
  const feeds = cells.map(({ feedType, feed }) => {
    const verified = verifyPriceUpdate(decoded, feed.data.feedId, feed.data.publisherSetTypeHash, committeeCell.data);
    if (verified.header.publishTimeMs <= feed.data.publishTimeMs) {
      throw new Error(`update at ${verified.header.publishTimeMs} is not newer than feed ${feed.data.feedId} (${feed.data.publishTimeMs})`);
    }
    const after = applyVerifiedPrice(feed.data, verified);
    tx.addInput(ccc.CellInput.from({ previousOutput: feed.cell.outPoint }));
    tx.addOutput(feed.cell.cellOutput, ccc.hexFrom(encodePriceFeedData(after)));
    // Each feed cell keeps the contract version it was created under.
    const code = codeRefFor(p.deployment, "priceFeedType", feed.cell.cellOutput.type!.codeHash as Hex);
    codeDeps.set(code.codeHash, cellDep(code.cellDep));
    return { feedType, verified, before: feed.data, after };
  });
  tx.addCellDeps(...codeDeps.values(), cellDep(committeeCell.cellDep));
  setInputType(tx, 0, encodeFeedWitness(encodePriceUpdate(selectFeeds(decoded, cells.map((c) => c.feed.data.feedId)))));
  return { tx, feeds };
}

/**
 * Move a feed cell forward to `update`. Verifies the update against the live committee cell first,
 * so a transaction that the contract would reject is never built. The feed cell is input 0; its
 * lock must be satisfied by the caller's signer.
 */
export async function updateFeedCell(p: UpdateFeedCellParams): Promise<UpdateFeedCellResult> {
  const { tx, feeds } = await updateFeedCells({ client: p.client, deployment: p.deployment, feedTypes: [p.feedType], update: p.update });
  const { verified, before, after } = feeds[0]!;
  return { tx, verified, before, after };
}

/** Consume a feed cell and return its capacity (the lock decides who may). */
export async function burnFeedCell(client: ccc.Client, deployment: LeanOracleDeployment, feedType: Script): Promise<ccc.Transaction> {
  const feed = await getFeedCell(client, feedType);
  if (!feed) throw new Error("feed cell not found");
  const tx = ccc.Transaction.from({});
  tx.addInput(ccc.CellInput.from({ previousOutput: feed.cell.outPoint }));
  tx.addCellDeps(cellDep(codeRefFor(deployment, "priceFeedType", feed.cell.cellOutput.type!.codeHash as Hex).cellDep));
  return tx;
}

async function findCommitteeCellByHash(client: ccc.Client, deployment: LeanOracleDeployment, typeHash: Hex) {
  const committee = Object.values(deployment.committees).find((c) => c.typeHash.toLowerCase() === typeHash.toLowerCase());
  if (!committee) throw new Error(`committee ${typeHash} is not in this deployment`);
  const cell = await findCommitteeCell(client, committee.typeScript);
  if (!cell) throw new Error("committee cell not found");
  return cell;
}
