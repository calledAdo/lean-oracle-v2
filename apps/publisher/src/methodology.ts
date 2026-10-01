//! Per-publisher price rules (docs/oracle-design.md section 4).
//!
//! Per venue: the median of bid/ask midpoints sampled every 100 ms over the window (or a trade VWAP),
//! skipping venues whose connection is dead, books that are crossed, too wide or too thin, and book
//! states older than `maxBookAgeMs`. Across venues: take a median, drop outliers beyond
//! `maxDeviationBps`, take the median again. `conf = max(median half-spread, median absolute
//! deviation)`. Every market trades exactly the feed's pair, so no currency conversion is done.

import { marketFeeds, type CommitteeConfig, type MarketConfig, type ObservationEntry, type PriceMethod } from "lean-oracle-sdk/protocol";

import { abs, median, ONE, toExpo } from "./fixed.js";
import type { MarketData, Quote, Trade } from "./marketData.js";
import { REST_VENUES } from "./sources/rest.js";

const SAMPLE_MS = 100;
const DEFAULT_MAX_BOOK_AGE_MS = 60_000;

interface VenuePrice {
  price: bigint;
  halfSpread: bigint;
  timeMs: number;
  /** |VWAP − mid| when the clamp is on, else 0 (widens conf). */
  gap: bigint;
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

/**
 * Trades inside `[bid − slack, ask + slack]` of some book state within ±`toleranceMs` of the trade.
 * A book state is the latest quote at or before a time, so the candidates for a trade at `t` are the
 * state in force at `t − toleranceMs` plus every quote in `[t − toleranceMs, t + toleranceMs]`.
 * One pass over the time-sorted `trades` and `quotes` (both as MarketData stores them).
 */
export function tradesInsideBook(trades: Trade[], quotes: Quote[], toleranceMs: number, slack: bigint): Trade[] {
  const kept: Trade[] = [];
  let lo = 0; // first quote with time > t − tolerance
  for (const t of trades) {
    while (lo < quotes.length && quotes[lo]!.timeMs <= t.timeMs - toleranceMs) lo++;
    const inside = (q: Quote) => t.price >= q.bid - slack && t.price <= q.ask + slack;
    let ok = lo > 0 && inside(quotes[lo - 1]!);
    for (let j = lo; !ok && j < quotes.length && quotes[j]!.timeMs <= t.timeMs + toleranceMs; j++) ok = inside(quotes[j]!);
    if (ok) kept.push(t);
  }
  return kept;
}

/**
 * The v2 `vwap` rule (committee-config fields; each absent field keeps v1 behavior): WS venues drop
 * trades outside their book, a window notional floor falls back to `mid`, and the VWAP is clamped into
 * the venue's median bid/ask. Undefined means "use the `mid` rule".
 */
function clampedVwap(data: MarketData, method: PriceMethod, market: MarketConfig, tickMs: number, trades: Trade[]): VenuePrice | undefined {
  const from = tickMs - method.windowMs;
  const book = data
    .quotesIn(market.venue, market.market, from - (method.tradeBookToleranceMs ?? 0) - (method.maxBookAgeMs ?? DEFAULT_MAX_BOOK_AGE_MS), tickMs)
    .filter((q) => q.ask >= q.bid);
  const inWindow = book.filter((q) => q.timeMs > from);
  const window = inWindow.length > 0 ? inWindow : book.slice(-1); // a quiet book: the state in force
  const halfSpread = window.length > 0 ? median(window.map((q) => (q.ask - q.bid) / 2n)) : undefined;

  let used = trades;
  if (method.tradeBookToleranceMs !== undefined && method.tradeBookSlackPct !== undefined && !REST_VENUES[market.venue]) {
    // Without a book there is nothing to check against: no trade is accepted.
    used = halfSpread === undefined ? [] : tradesInsideBook(trades, book, method.tradeBookToleranceMs, (halfSpread * BigInt(method.tradeBookSlackPct)) / 100n);
  }
  const volume = used.reduce((sum, t) => sum + t.qty, 0n);
  const notional = used.reduce((sum, t) => sum + t.price * t.qty, 0n);
  if (volume === 0n) return undefined;
  if (method.vwapMinWindowNotional !== undefined && notional / ONE < BigInt(method.vwapMinWindowNotional) * ONE) return undefined;
  let price = notional / volume;
  let gap = 0n;
  if (method.vwapClampToBook) {
    if (window.length === 0) return undefined;
    const bid = median(window.map((q) => q.bid));
    const ask = median(window.map((q) => q.ask));
    const mid = (bid + ask) / 2n;
    gap = abs(price - mid);
    price = price < bid ? bid : price > ask ? ask : price;
  }
  return { price, halfSpread: halfSpread ?? 0n, timeMs: used[used.length - 1]!.timeMs, gap };
}

const usesV2Vwap = (m: PriceMethod) => m.vwapClampToBook !== undefined || m.tradeBookToleranceMs !== undefined || m.vwapMinWindowNotional !== undefined;

/** One market's price at `tickMs`. */
function marketPrice(data: MarketData, method: PriceMethod, market: MarketConfig, tickMs: number): VenuePrice | undefined {
  if (method.method === "vwap") {
    const trades = data.tradesIn(market.venue, market.market, tickMs - method.windowMs, tickMs);
    const alive = data.lastAliveMs(market.venue);
    if (trades.length > 0 && alive !== undefined && tickMs - alive <= method.maxQuoteAgeMs) {
      if (usesV2Vwap(method)) {
        const v2 = clampedVwap(data, method, market, tickMs, trades);
        if (v2) return v2;
      } else {
        const volume = trades.reduce((sum, t) => sum + t.qty, 0n);
        const notional = trades.reduce((sum, t) => sum + t.price * t.qty, 0n);
        const q = usableQuote(data, method, market, tickMs, tickMs);
        return { price: notional / volume, halfSpread: q ? (q.ask - q.bid) / 2n : 0n, timeMs: trades[trades.length - 1]!.timeMs, gap: 0n };
      }
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
    gap: 0n,
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
  const gap = median(kept.map((v) => v.gap));
  const conf = [mad, halfSpread, gap].reduce((a, b) => (a > b ? a : b));
  return { price, conf, sourceTimeMs: Number(median(kept.map((v) => BigInt(v.timeMs)))) };
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
  for (const feed of marketFeeds(config.feeds)) {
    const result = aggregate(data, feed, tickMs);
    if (!result) continue;
    const price = toExpo(result.price, feed.expo);
    if (price <= 0n) continue;
    entries.push({ feedId: feed.feedId, price, conf: toExpo(result.conf, feed.expo), sourceTimeMs: BigInt(result.sourceTimeMs) });
  }
  return entries;
}
