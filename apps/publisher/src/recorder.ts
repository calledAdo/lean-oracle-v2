//! Market-data recorder (docs/designs/manipulation-resistant-pricing.md, section 1). Measurement only:
//! it never changes what the publisher prices or signs, and any failure turns recording off, never
//! pricing.
//!
//! It writes newline JSON, one gzip file per UTC hour (`rec-YYYYMMDDHH.ndjson.gz`) in `dir`:
//!   {"t":"quote","ms",venue,market,bid,ask,bidSize?,askSize?}   what MarketData received
//!   {"t":"trade","ms",venue,market,price,qty}                    (receipt time; REST trades carry poll time,
//!   {"t":"alive","ms",venue}                                      after the poller's de-duplication)
//!   {"t":"tick","ms",tickMs,entries:[{feedId,price,conf,sourceTimeMs}]}   this publisher's own observation
//!   {"t":"event","ms",event,...}                                  source errors and backoff
//!   {"t":"depth","ms",venue,market,bids,asks}                     order-book snapshot, [price, qty] levels
//! Decimal values are the 18-decimal fixed-point integers MarketData holds, as strings.
//!
//! Writes go through a bounded queue: when the file stream pushes back, events are dropped and counted
//! (`recorder.dropped`), so a slow disk never stalls the event loop. After each hourly rotation the
//! oldest files are deleted until the directory is under `maxBytes`, whether or not they were copied
//! off the machine.

import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { LookupFunction } from "node:net";
import { createGzip, type Gzip } from "node:zlib";

import type { ObservationEntry } from "lean-oracle-sdk/protocol";

import type { MarketDataSink, Quote, Trade } from "./marketData.js";
import { httpsGetJson } from "./net/resolver.js";

export const DEFAULT_RECORD_MAX_BYTES = 2 * 1024 ** 3;
export const DEPTH_EVERY_MS = 30_000;
export const DEPTH_REFUSED_BACKOFF_MS = 10 * 60_000;
const HIGH_WATER_BYTES = 4 * 1024 ** 2;
const FILE = /^rec-\d{10}\.ndjson\.gz$/;

type Log = (event: string, detail?: Record<string, unknown>) => void;
type Levels = [string, string][];

/** Order-book snapshot endpoints (REST, ±depth levels), keyed by venue. */
export const DEPTH_ENDPOINTS: Record<string, { url(market: string): string; parse(body: any): { bids: Levels; asks: Levels } | undefined }> = {
  binance: { url: (m) => `https://api.binance.com/api/v3/depth?symbol=${m}&limit=500`, parse: (b) => b?.bids && { bids: b.bids, asks: b.asks } },
  gate: { url: (m) => `https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${m}&limit=200`, parse: (b) => b?.bids && { bids: b.bids, asks: b.asks } },
  bitget: { url: (m) => `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${m}&type=step0&limit=150`, parse: (b) => b?.data?.bids && { bids: b.data.bids, asks: b.data.asks } },
  kucoin: { url: (m) => `https://api.kucoin.com/api/v1/market/orderbook/level2_100?symbol=${m}`, parse: (b) => b?.data?.bids && { bids: b.data.bids, asks: b.data.asks } },
  mexc: { url: (m) => `https://api.mexc.com/api/v3/depth?symbol=${m}&limit=500`, parse: (b) => b?.bids && { bids: b.bids, asks: b.asks } },
};

export interface RecorderOptions {
  dir: string;
  maxBytes?: number;
  /** Venue/market pairs to snapshot (e.g. the CKB markets). Empty: no depth snapshots. */
  depth?: { venue: string; market: string }[];
  depthEveryMs?: number;
  /** True while the venue's own price source is backing off; depth snapshots skip it then. */
  isBackingOff?: (venue: string) => boolean;
  lookup?: LookupFunction;
  getJson?: (url: string) => Promise<unknown>;
  now?: () => number;
  log?: Log;
}

/** A `MarketDataSink` that forwards every event to `inner` and records it. */
export class Recorder implements MarketDataSink {
  private readonly now: () => number;
  private readonly log: Log;
  private readonly maxBytes: number;
  private hour = "";
  private gzip: Gzip | undefined;
  private file: WriteStream | undefined;
  private blocked = false;
  private dropped = 0;
  private failed = false;
  private depthTimer: NodeJS.Timeout | undefined;
  private readonly depthBackoffUntil = new Map<string, number>();

  constructor(private readonly inner: MarketDataSink, private readonly o: RecorderOptions) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
    this.maxBytes = o.maxBytes ?? DEFAULT_RECORD_MAX_BYTES;
    mkdirSync(o.dir, { recursive: true });
  }

  /** Whether recording is still on (false after a write error). */
  get active(): boolean {
    return !this.failed;
  }

  get droppedEvents(): number {
    return this.dropped;
  }

  quote(venue: string, market: string, quote: Quote): void {
    this.inner.quote(venue, market, quote);
    this.write({ t: "quote", ms: quote.timeMs, venue, market, bid: quote.bid, ask: quote.ask, bidSize: quote.bidSize, askSize: quote.askSize });
  }

  trade(venue: string, market: string, trade: Trade): void {
    this.inner.trade(venue, market, trade);
    this.write({ t: "trade", ms: trade.timeMs, venue, market, price: trade.price, qty: trade.qty });
  }

  alive(venue: string, timeMs: number): void {
    this.inner.alive(venue, timeMs);
    this.write({ t: "alive", ms: timeMs, venue });
  }

  /** This publisher's observation for a tick, for comparison with replays. */
  tick(tickMs: bigint, entries: ObservationEntry[]): void {
    this.write({ t: "tick", ms: this.now(), tickMs, entries: entries.map((e) => ({ feedId: e.feedId, price: e.price, conf: e.conf, sourceTimeMs: e.sourceTimeMs })) });
  }

  /** Source errors and backoff (they change liveness, so replays need them). */
  event(event: string, detail: Record<string, unknown>): void {
    this.write({ t: "event", ms: this.now(), event, ...detail });
  }

  startDepth(): void {
    if (!this.o.depth?.length) return;
    const every = this.o.depthEveryMs ?? DEPTH_EVERY_MS;
    this.depthTimer = setInterval(() => void this.snapshotAll(), every);
    this.depthTimer.unref();
    void this.snapshotAll();
  }

  async snapshotAll(): Promise<void> {
    await Promise.all((this.o.depth ?? []).map((d) => this.snapshot(d.venue, d.market)));
  }

  stop(): void {
    void this.close();
  }

  /** Stop depth snapshots and flush the current file. */
  async close(): Promise<void> {
    if (this.depthTimer) clearInterval(this.depthTimer);
    const file = this.file;
    this.gzip?.end();
    this.gzip = undefined;
    this.hour = "";
    if (file && !file.destroyed) await new Promise<void>((resolve) => file.once("close", () => resolve()));
  }

  private async snapshot(venue: string, market: string): Promise<void> {
    const endpoint = DEPTH_ENDPOINTS[venue];
    const key = `${venue}:${market}`;
    if (!endpoint || this.failed || this.o.isBackingOff?.(venue) || (this.depthBackoffUntil.get(key) ?? 0) > this.now()) return;
    try {
      const body = await (this.o.getJson ? this.o.getJson(endpoint.url(market)) : httpsGetJson(endpoint.url(market), this.o.lookup, 5000));
      const book = endpoint.parse(body);
      if (book) this.write({ t: "depth", ms: this.now(), venue, market, bids: book.bids, asks: book.asks });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/HTTP (403|429)/.test(message)) this.depthBackoffUntil.set(key, this.now() + DEPTH_REFUSED_BACKOFF_MS);
      this.log("recorder.depth_failed", { venue, market, error: message });
    }
  }

  private write(record: Record<string, unknown>): void {
    if (this.failed) return;
    try {
      const gzip = this.stream(Number(record.ms));
      if (!gzip) return;
      if (this.blocked) {
        this.dropped++;
        return;
      }
      const line = `${JSON.stringify(record, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n`;
      if (!gzip.write(line) || gzip.writableLength > HIGH_WATER_BYTES) {
        this.blocked = true;
        gzip.once("drain", () => {
          if (this.dropped > 0) this.log("recorder.dropped", { events: this.dropped });
          this.blocked = false;
        });
      }
    } catch (error) {
      this.fail(error);
    }
  }

  /** The gzip stream for the hour of `ms`, rotating (and enforcing the cap) on a new hour. */
  private stream(ms: number): Gzip | undefined {
    const hour = new Date(Number.isFinite(ms) ? ms : this.now()).toISOString().slice(0, 13).replace(/[-T]/g, "");
    if (hour === this.hour && this.gzip) return this.gzip;
    if (hour < this.hour) return this.gzip; // a late event from the previous hour stays in the current file
    this.gzip?.end();
    this.hour = hour;
    this.enforceCap();
    const file = createWriteStream(join(this.o.dir, `rec-${hour}.ndjson.gz`), { flags: "a" });
    const gzip = createGzip();
    gzip.pipe(file);
    file.on("error", (error) => this.fail(error));
    gzip.on("error", (error) => this.fail(error));
    this.file = file;
    this.gzip = gzip;
    this.blocked = false;
    return gzip;
  }

  /** Delete the oldest recordings until the directory is under the cap. */
  enforceCap(): void {
    const files = readdirSync(this.o.dir)
      .filter((f) => FILE.test(f))
      .sort()
      .map((f) => ({ path: join(this.o.dir, f), size: statSync(join(this.o.dir, f)).size }));
    let total = files.reduce((s, f) => s + f.size, 0);
    for (const f of files) {
      if (total <= this.maxBytes) break;
      unlinkSync(f.path);
      total -= f.size;
      this.log("recorder.deleted", { file: f.path, bytes: f.size });
    }
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    if (this.depthTimer) clearInterval(this.depthTimer);
    this.log("recorder.failed", { error: error instanceof Error ? error.message : String(error) });
    try {
      this.gzip?.destroy();
      this.file?.destroy();
    } catch {
      // Already broken; recording stays off.
    }
  }
}
