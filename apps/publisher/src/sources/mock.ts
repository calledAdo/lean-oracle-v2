//! Deterministic synthetic quotes for local committees and tests. Each publisher can apply its own
//! `skewBps` to model honest disagreement between data sources.

import type { CommitteeConfig } from "lean-oracle-sdk/protocol";

import type { MarketDataSink } from "../marketData.js";

export interface MockMarket {
  venue: string;
  market: string;
  /** Mid price in the market's quote currency, 18 decimals. */
  mid: bigint;
}

/**
 * Every market referenced by `config`, priced from `basePrices` (feed symbol → decimal mid, 18
 * decimals). Venue `i` of a feed is offset by `i - 1` bps so venues disagree slightly.
 */
export function mockMarketsFor(config: CommitteeConfig, basePrices: Record<string, bigint>): MockMarket[] {
  const seen = new Map<string, MockMarket>();
  for (const feed of config.feeds) {
    const base = basePrices[feed.symbol];
    if (base === undefined) continue;
    feed.markets.forEach((m, i) => {
      seen.set(`${m.venue}/${m.market}`, { venue: m.venue, market: m.market, mid: (base * BigInt(10_000 + i - 1)) / 10_000n });
    });
  }
  return [...seen.values()];
}

/** Push one quote per market at `timeMs` with a 2 bps spread, shifted by `skewBps` and a deterministic drift. */
export function emitMockQuotes(sink: MarketDataSink, markets: MockMarket[], timeMs: number, skewBps = 0): void {
  const drift = BigInt(Math.floor(timeMs / 1000) % 7) - 3n; // ±3 bps oscillation
  for (const m of markets) {
    const mid = (m.mid * (10_000n + BigInt(skewBps) + drift)) / 10_000n;
    const half = mid / 10_000n;
    sink.quote(m.venue, m.market, { bid: mid - half, ask: mid + half, timeMs });
    sink.alive(m.venue, timeMs);
  }
}
