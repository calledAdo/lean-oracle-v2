//! Per-publisher price rules (docs/oracle-design.md section 4).
//!
//! Per venue: the median of bid/ask midpoints sampled every 100 ms over the window (or a trade VWAP),
//! skipping venues whose connection is dead, books that are crossed, too wide or too thin, and book
//! states older than `maxBookAgeMs`. Across venues: take a median, drop outliers beyond
//! `maxDeviationBps`, take the median again. `conf = max(median half-spread, median absolute
//! deviation)`. Every market trades exactly the feed's pair, so no currency conversion is done.

import type { CommitteeConfig, MarketConfig, ObservationEntry, PriceMethod } from "lean-oracle-sdk/protocol";

import { abs, median, ONE, toExpo } from "./fixed.js";
import type { MarketData, Quote } from "./marketData.js";

const SAMPLE_MS = 100;
const DEFAULT_MAX_BOOK_AGE_MS = 60_000;

interface VenuePrice {
  price: bigint;
  halfSpread: bigint;
  timeMs: number;
}

interface Aggregate {
  price: bigint;
  conf: bigint;
  sourceTimeMs: number;
}

function spreadBps(q: Quote): bigint {
  return ((q.ask - q.bid) * 20_000n) / (q.ask + q.bid);
}

/** Usable book state: the venue is alive, the book is recent enough, not crossed, not too wide, not dust. */
function usableQuote(data: MarketData, method: PriceMethod, market: MarketConfig, atMs: number, tickMs: number): Quote | undefined {
  const alive = data.lastAliveMs(market.venue);
  if (alive === undefined || tickMs - alive > method.maxQuoteAgeMs) return undefined;
  const q = data.latestQuote(market.venue, market.market, atMs);
  if (!q || atMs - q.timeMs > (method.maxBookAgeMs ?? DEFAULT_MAX_BOOK_AGE_MS) || spreadBps(q) > BigInt(method.maxSpreadBps)) return undefined;
  if (method.minTopNotional !== undefined && q.bidSize !== undefined && q.askSize !== undefined) {
    const min = BigInt(method.minTopNotional) * ONE;
    if ((q.bidSize * q.bid) / ONE < min || (q.askSize * q.ask) / ONE < min) return undefined;
  }
  return q;
}

/** One market's price at `tickMs`. */
function marketPrice(data: MarketData, method: PriceMethod, market: MarketConfig, tickMs: number): VenuePrice | undefined {
  if (method.method === "vwap") {
    const trades = data.tradesIn(market.venue, market.market, tickMs - method.windowMs, tickMs);
    const alive = data.lastAliveMs(market.venue);
    if (trades.length > 0 && alive !== undefined && tickMs - alive <= method.maxQuoteAgeMs) {
      const volume = trades.reduce((sum, t) => sum + t.qty, 0n);
      const notional = trades.reduce((sum, t) => sum + t.price * t.qty, 0n);
      const q = usableQuote(data, method, market, tickMs, tickMs);
      return { price: notional / volume, halfSpread: q ? (q.ask - q.bid) / 2n : 0n, timeMs: trades[trades.length - 1]!.timeMs };
    }
  }
  const samples: Quote[] = [];
  const window = method.method === "mid" ? Math.min(method.windowMs, method.maxQuoteAgeMs) : method.windowMs;
  for (let at = tickMs; at > tickMs - window; at -= SAMPLE_MS) {
    const q = usableQuote(data, method, market, at, tickMs);
    if (q) samples.push(q);
  }
  if (samples.length === 0) return undefined;
  const latest = samples[0]!;
  return {
    price: median(samples.map((q) => (q.bid + q.ask) / 2n)),
    halfSpread: median(samples.map((q) => (q.ask - q.bid) / 2n)),
    timeMs: latest.timeMs,
  };
}

function combine(method: PriceMethod, venues: VenuePrice[]): Aggregate | undefined {
  if (venues.length < method.minVenues) return undefined;
  let kept = venues;
  if (method.maxDeviationBps !== undefined) {
    const first = median(venues.map((v) => v.price));
    kept = venues.filter((v) => abs(v.price - first) * 10_000n <= BigInt(method.maxDeviationBps!) * first);
    if (kept.length < method.minVenues) return undefined;
  }
  const price = median(kept.map((v) => v.price));
  const mad = median(kept.map((v) => abs(v.price - price)));
  const halfSpread = median(kept.map((v) => v.halfSpread));
  return { price, conf: mad > halfSpread ? mad : halfSpread, sourceTimeMs: Number(median(kept.map((v) => BigInt(v.timeMs)))) };
}

function aggregate(data: MarketData, method: PriceMethod, tickMs: number): Aggregate | undefined {
  const venues: VenuePrice[] = [];
  for (const market of method.markets) {
    const price = marketPrice(data, method, market, tickMs);
    if (price && price.price > 0n) venues.push(price);
  }
  return combine(method, venues);
}

/** This publisher's observation entries for every feed it can price at `tickMs` (ascending feed id). */
export function observeFeeds(config: CommitteeConfig, data: MarketData, tickMs: number): ObservationEntry[] {
  const entries: ObservationEntry[] = [];
  for (const feed of config.feeds) {
    const result = aggregate(data, feed, tickMs);
    if (!result) continue;
    const price = toExpo(result.price, feed.expo);
    if (price <= 0n) continue;
    entries.push({ feedId: feed.feedId, price, conf: toExpo(result.conf, feed.expo), sourceTimeMs: BigInt(result.sourceTimeMs) });
  }
  return entries;
}
