//! Product-level façade (same pattern as lean-oracle-sdk 0.x): one object that knows its network,
//! reads committee and feed cells, reads prices from mirrors (verified against the live committee
//! cell) and builds ready-to-sign transactions. Lower-level pieces stay available under `/ckb`,
//! `/tx`, `/mirror` and `/protocol`.

import { ccc } from "@ckb-ccc/core";

import { findCommitteeCell, findFeedCells, getFeedCell, type LiveCell } from "../ckb/cells.js";
import { MirrorClient } from "../mirror/client.js";
import { toFeedId, type MirrorPrice, type MirrorUpdate } from "../mirror/format.js";
import { requireDeployment, type LeanOracleNetworkPreset } from "../presets/networks.js";
import type { CommitteeRef, LeanOracleDeployment } from "../presets/deployment.js";
import type { PriceFeedData } from "../protocol/priceFeed.js";
import type { PriceUpdate } from "../protocol/priceUpdate.js";
import type { PublisherSetData } from "../protocol/publisherSet.js";
import { burnFeedCell, createFeedCell, updateFeedCell, type UpdateFeedCellResult } from "../tx/feed.js";
import { completeFee, type CompleteFeeOptions, type CompleteFeeResult } from "../tx/fees.js";
import { pullAndUpdate } from "../tx/pull.js";
import type { Hex, Script } from "../types.js";

/** @public */
export interface LeanOracleClientOptions {
  network: LeanOracleNetworkPreset;
  /** Preconfigured CCC client (shared instance, private RPC, test fake). Default: public client for the network. */
  cccClient?: ccc.Client;
  /** Mirror URLs (default: the preset's) or a ready `MirrorClient`. */
  mirror?: string[] | MirrorClient;
  mirrorApiKey?: string;
  /** How long committee cell data is cached for verifying mirror updates (default 30 s). */
  committeeCacheMs?: number;
}

/** @public */
export class LeanOracleClient {
  readonly network: LeanOracleNetworkPreset;
  readonly deployment: LeanOracleDeployment;
  readonly cccClient: ccc.Client;
  readonly mirror: MirrorClient | undefined;
  private readonly committeeData = new Map<Hex, { data: PublisherSetData; atMs: number }>();

  constructor(private readonly options: LeanOracleClientOptions) {
    this.network = options.network;
    this.deployment = requireDeployment(options.network);
    this.cccClient =
      options.cccClient ??
      (options.network.name === "mainnet" ? new ccc.ClientPublicMainnet({ url: options.network.ckbRpcUrl }) : new ccc.ClientPublicTestnet({ url: options.network.ckbRpcUrl }));
    const urls = Array.isArray(options.mirror) ? options.mirror : options.network.mirrorUrls;
    this.mirror =
      options.mirror instanceof MirrorClient
        ? options.mirror
        : urls.length > 0
          ? new MirrorClient({ urls, apiKey: options.mirrorApiKey, committees: () => Object.fromEntries([...this.committeeData].map(([hash, v]) => [hash, v.data])) })
          : undefined;
  }

  /** A committee of this deployment by name (e.g. `majors`). */
  committee(name: string): CommitteeRef {
    const committee = this.deployment.committees[name];
    if (!committee) throw new Error(`unknown committee ${name}; known: ${Object.keys(this.deployment.committees).join(", ")}`);
    return committee;
  }

  /** The live committee cell (resolved fresh: rotation moves it). */
  async getCommittee(name: string): Promise<LiveCell<PublisherSetData>> {
    const cell = await findCommitteeCell(this.cccClient, this.committee(name).typeScript);
    if (!cell) throw new Error(`committee ${name} has no live cell`);
    this.committeeData.set(cell.typeHash.toLowerCase() as Hex, { data: cell.data, atMs: Date.now() });
    return cell;
  }

  /** A feed cell by its type script. */
  getFeedCell(feedType: Script): Promise<LiveCell<PriceFeedData> | undefined> {
    return getFeedCell(this.cccClient, feedType);
  }

  /** Every live feed cell for a feed (ID or symbol) anchored to a committee. Anyone can create them: prefer your own. */
  findFeedCells(feed: string, committee: string): Promise<LiveCell<PriceFeedData>[]> {
    return findFeedCells(this.cccClient, this.deployment, toFeedId(feed), this.committee(committee).typeHash);
  }

  /** Latest prices from the mirror, verified against the live committee cell. */
  async latestPrices(feeds: string[], committee: string): Promise<MirrorPrice[]> {
    const updates = await this.requireMirror().latest(feeds, { committee: await this.verifiable(committee) });
    return updates.flatMap((u) => u.prices);
  }

  /** For each feed, the first price at or after `timeMs`, verified. */
  async pricesAt(timeMs: bigint | number, feeds: string[], committee: string): Promise<MirrorUpdate[]> {
    return this.requireMirror().at(timeMs, feeds, { committee: await this.verifiable(committee) });
  }

  /** Draft creating a feed cell you own (any lock; default the signer's). */
  createFeedCell(params: { signer: ccc.Signer; feed: string; committee: string; lock?: Script }) {
    return createFeedCell({ signer: params.signer, deployment: this.deployment, feedId: toFeedId(params.feed), committee: this.committee(params.committee).typeScript, lock: params.lock });
  }

  /** Draft moving a feed cell forward to an update you already have. */
  updateFeedCell(feedType: Script, update: Hex | Uint8Array | PriceUpdate): Promise<UpdateFeedCellResult> {
    return updateFeedCell({ client: this.cccClient, deployment: this.deployment, feedType, update });
  }

  /** Draft moving a feed cell to the mirror's latest (or `atMs`) update. */
  async pullAndUpdate(feedType: Script, options: { atMs?: bigint | number; exact?: boolean } = {}): Promise<UpdateFeedCellResult> {
    const feed = await this.getFeedCell(feedType);
    if (!feed) throw new Error("feed cell not found");
    const name = Object.entries(this.deployment.committees).find(([, c]) => c.typeHash.toLowerCase() === feed.data.publisherSetTypeHash.toLowerCase())?.[0];
    if (name) await this.verifiable(name);
    return pullAndUpdate({ client: this.cccClient, deployment: this.deployment, feedType, mirror: this.requireMirror(), ...options });
  }

  /** Draft burning a feed cell (its lock decides who may). */
  burnFeedCell(feedType: Script): Promise<ccc.Transaction> {
    return burnFeedCell(this.cccClient, this.deployment, feedType);
  }

  /** Add fee inputs (largest plain cells first) and change. */
  completeFee(tx: ccc.Transaction, signer: ccc.Signer, options?: CompleteFeeOptions): Promise<CompleteFeeResult> {
    return completeFee(tx, signer, options);
  }

  private requireMirror(): MirrorClient {
    if (!this.mirror) throw new Error(`no mirror configured for ${this.network.name}; pass mirror URLs`);
    return this.mirror;
  }

  /** Make sure the committee's data is fresh for verification; returns its type hash. */
  private async verifiable(name: string): Promise<Hex> {
    const typeHash = this.committee(name).typeHash.toLowerCase() as Hex;
    const cached = this.committeeData.get(typeHash);
    if (!cached || Date.now() - cached.atMs > (this.options.committeeCacheMs ?? 30_000)) await this.getCommittee(name);
    return typeHash;
  }
}
