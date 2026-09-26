//! Shadow mode: run the full recorder and methodology without being in the committee and without
//! signing anything, and compare this operator's prices with the committee's signed updates from a
//! mirror. A prospective publisher runs it for a few days before joining, to show that its exchange
//! connections and prices agree with the committee's.

import { createServer, type Server } from "node:http";

import type { Hex, ObservationEntry } from "lean-oracle-sdk/protocol";

import type { ConfigSchedule } from "./configSchedule.js";
import type { MarketData } from "./marketData.js";
import { observeFeeds } from "./methodology.js";

type Log = (event: string, detail?: Record<string, unknown>) => void;

export interface FeedStats {
  symbol: string;
  /** Ticks where both this operator and the committee had a price. */
  compared: number;
  /** Of those, how many were within the feed's publisher tolerance. */
  withinTolerance: number;
  /** Ticks where the committee had a price and this operator had none. */
  missedByUs: number;
  /** Ticks where this operator had a price and the committee had none. */
  missedByCommittee: number;
  maxDeviationBps: number;
  lastDeviationBps: number | null;
}

/** Deviation of `own` from `reference` in basis points (absolute, rounded up). */
export function deviationBps(own: bigint, reference: bigint): number {
  if (reference <= 0n) return Number.POSITIVE_INFINITY;
  const diff = own > reference ? own - reference : reference - own;
  return Number((diff * 10_000n + reference - 1n) / reference);
}

export interface ShadowOptions {
  schedule: ConfigSchedule;
  marketData: MarketData;
  publisherSetTypeHash: Hex;
  /** Mirror base URL that serves the committee's signed updates. */
  referenceUrl: string;
  api: { host: string; port: number };
  log: Log;
  fetch?: typeof fetch;
  /** How long after a tick to fetch the committee's update (default 3 s). */
  compareDelayMs?: number;
  summaryEveryMs?: number;
}

export class ShadowRunner {
  private readonly stats = new Map<Hex, FeedStats>();
  private readonly timers: NodeJS.Timeout[] = [];
  private server: Server | undefined;
  private stopped = false;
  private readonly fetchFn: typeof fetch;
  private readonly startedAt = Date.now();

  constructor(private readonly o: ShadowOptions) {
    this.fetchFn = o.fetch ?? fetch;
  }

  start(): void {
    this.scheduleNext();
    const summary = setInterval(() => this.o.log("shadow.summary", { feeds: this.report() }), this.o.summaryEveryMs ?? 60_000);
    this.timers.push(summary);
    this.server = createServer((req, res) => {
      if (req.url === "/health" || req.url === "/v1/shadow") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ mode: "shadow", since: new Date(this.startedAt).toISOString(), feeds: this.report() }));
      } else {
        res.writeHead(404).end();
      }
    });
    this.server.listen(this.o.api.port, this.o.api.host);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t), clearTimeout(t);
    this.server?.close();
  }

  report(): FeedStats[] {
    return [...this.stats.values()];
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const active = this.o.schedule.at(BigInt(Date.now())) ?? this.o.schedule.all()[0];
    if (!active) return;
    const period = active.config.tickPeriodMs;
    const next = Math.floor(Date.now() / period) * period + period;
    this.timers.push(setTimeout(() => {
      this.tick(BigInt(next));
      this.scheduleNext();
    }, next - Date.now()));
  }

  /** Observe at the tick exactly as a committee member would, then compare once the update exists. */
  tick(tickMs: bigint): void {
    const active = this.o.schedule.at(tickMs);
    if (!active) return;
    const own = observeFeeds(active.config, this.o.marketData, Number(tickMs));
    const feeds = active.config.feeds.map((f) => ({ feedId: f.feedId.toLowerCase() as Hex, symbol: f.symbol, toleranceBps: f.toleranceBps }));
    this.timers.push(setTimeout(() => void this.compare(tickMs, own, feeds), this.o.compareDelayMs ?? 3000));
  }

  async compare(tickMs: bigint, own: ObservationEntry[], feeds: { feedId: Hex; symbol: string; toleranceBps: number }[]): Promise<void> {
    let reference: Map<Hex, bigint>;
    try {
      reference = await this.fetchReference(tickMs, feeds.map((f) => f.feedId));
    } catch (error) {
      this.o.log("shadow.reference_failed", { tickMs: tickMs.toString(), error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const ours = new Map(own.map((e) => [e.feedId.toLowerCase() as Hex, e.price]));
    for (const f of feeds) {
      const s = this.stats.get(f.feedId) ?? { symbol: f.symbol, compared: 0, withinTolerance: 0, missedByUs: 0, missedByCommittee: 0, maxDeviationBps: 0, lastDeviationBps: null };
      this.stats.set(f.feedId, s);
      const mine = ours.get(f.feedId);
      const theirs = reference.get(f.feedId);
      if (mine === undefined && theirs === undefined) continue;
      if (mine === undefined) {
        s.missedByUs++;
        continue;
      }
      if (theirs === undefined) {
        s.missedByCommittee++;
        continue;
      }
      const dev = deviationBps(mine, theirs);
      s.compared++;
      s.lastDeviationBps = dev;
      s.maxDeviationBps = Math.max(s.maxDeviationBps, dev);
      if (dev <= f.toleranceBps) s.withinTolerance++;
      else this.o.log("shadow.outside_tolerance", { symbol: f.symbol, tickMs: tickMs.toString(), deviationBps: dev, toleranceBps: f.toleranceBps });
    }
  }

  /** The committee's prices at exactly `tickMs`, from the mirror (only exact-tick matches count). */
  private async fetchReference(tickMs: bigint, feedIds: Hex[]): Promise<Map<Hex, bigint>> {
    const url = `${this.o.referenceUrl.replace(/\/$/, "")}/v1/updates/at?t=${tickMs}&ids=${feedIds.join(",")}&committee=${this.o.publisherSetTypeHash}`;
    const res = await this.fetchFn(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`mirror returned ${res.status}`);
    const body = (await res.json()) as { updates: { publishTimeMs: string; prices: { feedId: string; price: string }[] }[] };
    const out = new Map<Hex, bigint>();
    for (const u of body.updates) {
      if (BigInt(u.publishTimeMs) !== tickMs) continue;
      for (const p of u.prices) out.set(p.feedId.toLowerCase() as Hex, BigInt(p.price));
    }
    return out;
  }
}
