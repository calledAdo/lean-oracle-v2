//! Leader and signer aggregation (docs/oracle-design.md section 5). Everything here is integer
//! arithmetic, so every honest publisher derives byte-identical messages from the same inputs.

import type { CommitteeConfig, Hex, Observation, PriceMessage } from "lean-oracle-sdk/protocol";

import { abs, median } from "./fixed.js";

/** Per-feed state from the latest finalized tick that included the feed. */
export interface FeedState {
  tickMs: bigint;
  emaPrice: bigint;
  emaConf: bigint;
}

/** EMA time constant τ = half-life / ln 2, in integer ms. */
export function emaTauMs(halfLifeMs: number): bigint {
  return (BigInt(halfLifeMs) * 1_000_000n) / 693_147n;
}

/** `ema + (x − ema) × Δt / (Δt + τ)`, truncating toward zero; the first value initializes it. */
export function nextEma(previous: bigint | undefined, value: bigint, dtMs: bigint, tauMs: bigint): bigint {
  if (previous === undefined) return value;
  return previous + ((value - previous) * dtMs) / (dtMs + tauMs);
}

/**
 * Messages for a tick from a set of already-verified observations: a feed is included when at
 * least `quorum` observations price it. `state(feedId)` gives the feed's latest finalized state.
 */
export function aggregateMessages(
  config: CommitteeConfig,
  observations: Observation[],
  quorum: number,
  tickMs: bigint,
  state: (feedId: Hex) => FeedState | undefined,
): PriceMessage[] {
  const messages: PriceMessage[] = [];
  for (const feed of config.feeds) {
    const entries = observations.flatMap((o) => o.entries.filter((e) => e.feedId === feed.feedId));
    if (entries.length < quorum) continue;
    const price = median(entries.map((e) => e.price));
    const conf = median(entries.map((e) => e.conf));
    const previous = state(feed.feedId);
    const dt = previous ? tickMs - previous.tickMs : 0n;
    const tau = emaTauMs(feed.emaHalfLifeMs);
    messages.push({
      feedId: feed.feedId,
      price,
      conf,
      expo: feed.expo,
      prevPublishTimeMs: previous?.tickMs ?? 0n,
      emaPrice: nextEma(previous?.emaPrice, price, dt, tau),
      emaConf: nextEma(previous?.emaConf, conf, dt, tau),
      sourceTimeMs: median(entries.map((e) => e.sourceTimeMs)),
      numPublishers: entries.length,
    });
  }
  return messages;
}

/** The aggregate is within `toleranceBps` of this publisher's own price. */
export function withinTolerance(aggregate: bigint, own: bigint, toleranceBps: number): boolean {
  return abs(aggregate - own) * 10_000n <= BigInt(toleranceBps) * abs(own);
}
