//! TWAP feeds (docs/designs/twap60.md): a time-weighted average of a source feed's finalized prices,
//! observed only at boundary ticks. Pure functions of finalized history, so every synced publisher
//! computes the same value; the committee then takes the median of the observations like any feed.

import { isTwapFeed, type CommitteeConfig, type Hex, type ObservationEntry, type TwapFeedConfig } from "lean-oracle-sdk/protocol";

import { abs, median } from "./fixed.js";

/** One finalized tick of a source feed. */
export interface TwapPoint {
  tickMs: bigint;
  price: bigint;
  conf: bigint;
}

/**
 * The window a boundary `t` averages: ticks in `(from, to]` with `to = t − 2·tickPeriodMs` (ticks `t` and
 * `t − 1` are not finalized when `t` is observed; the same lag as the leader-order anchor) and
 * `from = to − windowMs`. 60 ticks for TWAP60 at 1 s.
 */
export function twapWindow(tickMs: bigint, windowMs: number, tickPeriodMs: number): { from: bigint; to: bigint } {
  const to = tickMs - 2n * BigInt(tickPeriodMs);
  return { from: to - BigInt(windowMs), to };
}

/** The TWAP feeds due at `tickMs` (its boundary for their `everyMs`). */
export function dueTwapFeeds(config: CommitteeConfig, tickMs: bigint): TwapFeedConfig[] {
  return config.feeds.filter(isTwapFeed).filter((f) => tickMs % BigInt(f.twap.everyMs) === 0n);
}

/**
 * The TWAP entry for `feed` at boundary `tickMs`, or undefined when this publisher must sit it out:
 * fewer than `minTicks` source ticks in the window, or not synced through the window end
 * (`latestFinalizedMs` before it), so its average could differ from the committee's.
 *   price = floor(mean of the window's prices), equal weight per finalized tick, gaps skipped
 *   conf  = max(floor(mean of the window's confs), median absolute deviation of the prices)
 *   sourceTimeMs = the newest tick in the window
 */
export function computeTwap(
  feed: TwapFeedConfig,
  points: readonly TwapPoint[],
  tickMs: bigint,
  tickPeriodMs: number,
  latestFinalizedMs: bigint | undefined,
): ObservationEntry | undefined {
  const { from, to } = twapWindow(tickMs, feed.twap.windowMs, tickPeriodMs);
  if (latestFinalizedMs === undefined || latestFinalizedMs < to) return undefined;
  const window = points.filter((p) => p.tickMs > from && p.tickMs <= to);
  if (window.length < feed.twap.minTicks || window.length === 0) return undefined;
  const count = BigInt(window.length);
  const price = window.reduce((s, p) => s + p.price, 0n) / count;
  if (price <= 0n) return undefined;
  const meanConf = window.reduce((s, p) => s + p.conf, 0n) / count;
  const mid = median(window.map((p) => p.price));
  const mad = median(window.map((p) => abs(p.price - mid)));
  const newest = window.reduce((m, p) => (p.tickMs > m ? p.tickMs : m), 0n);
  return { feedId: feed.feedId, price, conf: meanConf > mad ? meanConf : mad, sourceTimeMs: newest };
}

/** Merge observation entries in ascending feed ID (observations must be sorted). */
export function mergeEntries(a: readonly ObservationEntry[], b: readonly ObservationEntry[]): ObservationEntry[] {
  return [...a, ...b].sort((x, y) => (x.feedId.toLowerCase() < y.feedId.toLowerCase() ? -1 : 1));
}

/** Source points per feed ID from decoded finalized updates. */
export function pointsByFeed(updates: readonly { tickMs: bigint; entries: readonly { feedId: Hex; price: bigint; conf: bigint }[] }[]): Map<string, TwapPoint[]> {
  const out = new Map<string, TwapPoint[]>();
  for (const u of updates) {
    for (const e of u.entries) {
      const id = e.feedId.toLowerCase();
      const list = out.get(id) ?? [];
      out.set(id, list);
      list.push({ tickMs: u.tickMs, price: e.price, conf: e.conf });
    }
  }
  return out;
}
