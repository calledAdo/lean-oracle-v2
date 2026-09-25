//! `pullAndUpdate`: fetch a feed's update from a mirror and build the feed cell update.

import type { ccc } from "@ckb-ccc/core";

import { getFeedCell } from "../ckb/cells.js";
import type { MirrorClient } from "../mirror/client.js";
import type { LeanOracleDeployment } from "../presets/deployment.js";
import type { Script } from "../types.js";
import { updateFeedCell, type UpdateFeedCellResult } from "./feed.js";

export interface PullAndUpdateParams {
  client: ccc.Client;
  deployment: LeanOracleDeployment;
  /** The feed cell's type script. */
  feedType: Script;
  mirror: MirrorClient;
  /**
   * Settle at a time instead of the latest price: the first update at or after `atMs`. With
   * `exact`, only an update published exactly at `atMs` is accepted (e.g. pool settlement ticks).
   */
  atMs?: bigint | number;
  exact?: boolean;
}

/** Unsigned transaction moving the feed cell to the mirror's latest (or `atMs`) update of the cell's committee. */
export async function pullAndUpdate(p: PullAndUpdateParams): Promise<UpdateFeedCellResult> {
  const feed = await getFeedCell(p.client, p.feedType);
  if (!feed) throw new Error("feed cell not found");
  const query = { committee: feed.data.publisherSetTypeHash };
  const [update] = p.atMs === undefined ? await p.mirror.latest([feed.data.feedId], query) : await p.mirror.at(p.atMs, [feed.data.feedId], query);
  if (!update) throw new Error("the mirror has no update for this feed");
  if (p.exact && p.atMs !== undefined && update.publishTimeMs !== BigInt(p.atMs)) {
    throw new Error(`no update exactly at ${p.atMs} (next is ${update.publishTimeMs})`);
  }
  return updateFeedCell({ client: p.client, deployment: p.deployment, feedType: p.feedType, update: update.blob });
}
