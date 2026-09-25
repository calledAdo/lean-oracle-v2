//! REST polling for venues whose websocket is unsuitable (MEXC streams protobuf). Polls the best
//! bid/ask and recent trades once a second; trades are de-duplicated by time and content.

import type { LookupFunction } from "node:net";

import { parseDecimal } from "../fixed.js";
import { httpsGetJson } from "../net/resolver.js";
import type { MarketDataSink } from "../marketData.js";

export interface RestVenueSpec {
  venue: string;
  intervalMs: number;
  bookTicker(market: string): string;
  trades(market: string): string;
  parseBook(body: unknown): { bid: string; ask: string; bidSize?: string; askSize?: string } | undefined;
  parseTrades(body: unknown): { price: string; qty: string; timeMs: number }[];
}

type Json = Record<string, any>;

export const mexc: RestVenueSpec = {
  venue: "mexc",
  intervalMs: 1000,
  bookTicker: (m) => `https://api.mexc.com/api/v3/ticker/bookTicker?symbol=${m}`,
  trades: (m) => `https://api.mexc.com/api/v3/trades?symbol=${m}&limit=100`,
  parseBook: (b: Json) => (b?.bidPrice && b?.askPrice ? { bid: b.bidPrice, ask: b.askPrice, bidSize: b.bidQty, askSize: b.askQty } : undefined),
  parseTrades: (b: unknown) =>
    (Array.isArray(b) ? b : []).filter((t: Json) => t?.price && t?.qty && t?.time).map((t: Json) => ({ price: t.price, qty: t.qty, timeMs: Number(t.time) })),
};

export const REST_VENUES: Record<string, RestVenueSpec> = { mexc };

const REFUSED_BACKOFF_MS = 30_000;

export class RestPoller {
  private timer: NodeJS.Timeout | undefined;
  private readonly lastTrade = new Map<string, { timeMs: number; seen: Set<string> }>();
  /** Markets the venue refused (HTTP 403/429) are left alone until this time, so polling never escalates a block. */
  private readonly backoffUntil = new Map<string, number>();

  constructor(
    private readonly spec: RestVenueSpec,
    private readonly markets: string[],
    private readonly sink: MarketDataSink,
    private readonly log: (event: string, detail?: Record<string, unknown>) => void = () => {},
    private readonly fetchFn?: typeof fetch,
    private readonly now: () => number = Date.now,
    private readonly lookup?: LookupFunction,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.poll(), this.spec.intervalMs);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async poll(): Promise<void> {
    await Promise.all(this.markets.map((m) => this.pollMarket(m)));
  }

  private async get(url: string): Promise<unknown> {
    const timeoutMs = Math.max(this.spec.intervalMs, 3000);
    if (!this.fetchFn) return httpsGetJson(url, this.lookup, timeoutMs);
    const response = await this.fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  private async pollMarket(market: string): Promise<void> {
    if ((this.backoffUntil.get(market) ?? 0) > this.now()) return;
    try {
      const [book, trades] = await Promise.all([this.get(this.spec.bookTicker(market)), this.get(this.spec.trades(market))]);
      const timeMs = this.now();
      this.sink.alive(this.spec.venue, timeMs);
      const best = this.spec.parseBook(book);
      if (best) {
        const sizes = best.bidSize && best.askSize ? { bidSize: parseDecimal(best.bidSize), askSize: parseDecimal(best.askSize) } : {};
        this.sink.quote(this.spec.venue, market, { bid: parseDecimal(best.bid), ask: parseDecimal(best.ask), timeMs, ...sizes });
      }
      this.ingestTrades(market, this.spec.parseTrades(trades), timeMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/HTTP (403|429)/.test(message)) this.backoffUntil.set(market, this.now() + REFUSED_BACKOFF_MS);
      this.log("venue.error", { venue: this.spec.venue, market, error: message });
    }
  }

  /** Only trades newer than the last poll; the first poll establishes the cursor without backfilling. */
  private ingestTrades(market: string, trades: { price: string; qty: string; timeMs: number }[], receivedMs: number): void {
    const cursor = this.lastTrade.get(market);
    const latest = trades.reduce((max, t) => Math.max(max, t.timeMs), cursor?.timeMs ?? 0);
    const seen = new Set<string>();
    for (const t of trades) {
      const key = `${t.timeMs}:${t.price}:${t.qty}`;
      if (t.timeMs === latest) seen.add(key);
      if (!cursor || t.timeMs < cursor.timeMs || (t.timeMs === cursor.timeMs && cursor.seen.has(key))) continue;
      this.sink.trade(this.spec.venue, market, { price: parseDecimal(t.price), qty: parseDecimal(t.qty), timeMs: receivedMs });
    }
    this.lastTrade.set(market, { timeMs: latest, seen: latest === cursor?.timeMs ? new Set([...cursor.seen, ...seen]) : seen });
  }
}
