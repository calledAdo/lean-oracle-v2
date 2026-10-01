//! Keeps one connection per venue for the union of markets across every held config version, and
//! restarts a venue's connection when its market set changes.

import { marketFeeds, type CommitteeConfig } from "lean-oracle-sdk/protocol";

import type { LookupFunction } from "node:net";

import type { MarketDataSink } from "../marketData.js";
import { REST_VENUES, RestPoller } from "./rest.js";
import { marketsByVenue, VenueConnection } from "./runner.js";
import { venueNetwork, VENUES } from "./venues.js";

interface Running {
  key: string;
  stop(): void;
  isBackingOff?(): boolean;
}

export class SourceManager {
  private readonly running = new Map<string, Running>();

  constructor(
    private readonly sink: MarketDataSink,
    private readonly log: (event: string, detail?: Record<string, unknown>) => void,
    private readonly lookup?: LookupFunction,
  ) {
    venueNetwork.lookup = lookup;
  }

  sync(configs: readonly CommitteeConfig[]): void {
    const wanted = marketsByVenue(configs.flatMap((c) => marketFeeds(c.feeds)));
    for (const [venue, current] of this.running) {
      if (!wanted.has(venue)) {
        current.stop();
        this.running.delete(venue);
      }
    }
    for (const [venue, markets] of wanted) {
      const key = [...markets].sort().join(",");
      if (this.running.get(venue)?.key === key) continue;
      this.running.get(venue)?.stop();
      const source = this.create(venue, markets);
      if (!source) {
        this.log("source.unsupported_venue", { venue, markets });
        continue;
      }
      source.start();
      this.running.set(venue, { key, stop: () => source.stop(), ...(source.isBackingOff ? { isBackingOff: () => source.isBackingOff!() } : {}) });
      this.log("source.started", { venue, markets });
    }
  }

  /** True while the venue's source is backing off after a refusal (REST venues). */
  isBackingOff(venue: string): boolean {
    return this.running.get(venue)?.isBackingOff?.() ?? false;
  }

  stop(): void {
    for (const r of this.running.values()) r.stop();
    this.running.clear();
  }

  private create(venue: string, markets: string[]): { start(): void; stop(): void; isBackingOff?(): boolean } | undefined {
    if (VENUES[venue]) return new VenueConnection(VENUES[venue]!, markets, this.sink, this.log, Date.now, this.lookup);
    if (REST_VENUES[venue]) return new RestPoller(REST_VENUES[venue]!, markets, this.sink, this.log, undefined, Date.now, this.lookup);
    return undefined;
  }
}
