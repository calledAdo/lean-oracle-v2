//! Committee config: the quorum-approved, versioned rules publishers follow (docs/oracle-design.md
//! section 3.1). Hashed as `ckbHash("LEAN/COMMITTEE_CONFIG/V1" || canonical JSON)`.
//! Canonical JSON: object keys sorted, no whitespace, integers only (64-bit values as decimal strings).

import { bytesToHex, compareBytes, hexToBytes } from "../internal/bytes.js";
import type { Hex } from "../types.js";
import { ckbHash, DOMAIN_COMMITTEE_CONFIG, feedId } from "./hash.js";
import type { PublisherSet } from "./publisherSet.js";
import { verifyThreshold, type SignatureBundle } from "./signatures.js";

/** One exchange market. It must trade exactly the feed's pair: no currency conversion is done. */
export interface MarketConfig {
  venue: string;
  market: string;
}

export interface PriceMethod {
  /**
   * `mid`: median of bid/ask midpoints sampled every 100 ms over `windowMs`.
   * `vwap`: VWAP of trades over `windowMs`, else the median midpoint over the window.
   */
  method: "mid" | "vwap";
  windowMs: number;
  /** A venue counts only if its connection delivered something within this age (liveness, not price change). */
  maxQuoteAgeMs: number;
  /** Oldest book state still used on a live connection (default 60 s). */
  maxBookAgeMs?: number;
  maxSpreadBps: number;
  /** Ignore a top of book thinner than this notional, in the feed's quote currency, on either side (when sizes are reported). */
  minTopNotional?: number;
  /** After a first median, drop venues further than this from it, then take the median again. */
  maxDeviationBps?: number;
  /**
   * `vwap` only. Clamp each venue's VWAP into its median bid/ask over the window, and widen conf by the
   * median |VWAP − mid| gap, so trades can move a venue at most to its own book's edge. A venue with no
   * usable book in the window falls back to `mid`. Absent: off (v1 behavior).
   */
  vwapClampToBook?: boolean;
  /**
   * `vwap` only, websocket venues only (REST venues stamp trades with poll time). A trade counts only if
   * its price is within `[bid − slack, ask + slack]` of a book state within ±`tradeBookToleranceMs` of it,
   * where slack = the venue's median half-spread over the window × `tradeBookSlackPct` / 100. Both fields
   * together; absent: off (v1 behavior).
   */
  tradeBookToleranceMs?: number;
  tradeBookSlackPct?: number;
  /** `vwap` only: below this accepted trade notional in the window (quote currency), use `mid`. Absent: off. */
  vwapMinWindowNotional?: number;
  /** At least 2; the config must list at least one more market than this. */
  minVenues: number;
  /** One market per venue, each trading exactly `<base>/<quote>`. */
  markets: MarketConfig[];
}

interface FeedBase {
  symbol: string;
  /** Quote currency; must match the symbol's suffix (a TWAP feed's: its source's). */
  quote: string;
  feedId: Hex;
  expo: number;
  toleranceBps: number;
  emaHalfLifeMs: number;
}

/** A native pair feed priced from exchanges, e.g. `Crypto.BTC/USDT`. Consumers derive other pairs by combining feeds. */
export interface MarketFeedConfig extends FeedBase, PriceMethod {
  twap?: undefined;
}

/**
 * A time-weighted average of another feed's finalized prices (docs/designs/twap60.md), e.g.
 * `Crypto.BTC/USDT.TWAP60`. Signed only at boundary ticks (`tickMs % everyMs == 0`), from the source's
 * finalized ticks in `(t − windowMs − 2·tickPeriodMs, t − 2·tickPeriodMs]`; at least `minTicks` of them.
 */
export interface TwapSpec {
  source: string;
  windowMs: number;
  everyMs: number;
  minTicks: number;
}

export interface TwapFeedConfig extends FeedBase {
  twap: TwapSpec;
}

export type FeedConfig = MarketFeedConfig | TwapFeedConfig;

export const isTwapFeed = (feed: FeedConfig): feed is TwapFeedConfig => feed.twap !== undefined;

/** The feeds priced from exchanges (everything but TWAP feeds). */
export const marketFeeds = (feeds: readonly FeedConfig[]): MarketFeedConfig[] => feeds.filter((f): f is MarketFeedConfig => !isTwapFeed(f));

export interface CommitteeConfig {
  version: number;
  committee: string;
  publisherSetTypeHash: Hex;
  /** First tick (Unix ms, decimal string) at which this config applies. */
  activationTickMs: string;
  tickPeriodMs: number;
  observationDeadlineMs: number;
  maxSigningLagMs: number;
  feeds: FeedConfig[];
}

export interface SignedCommitteeConfig {
  config: CommitteeConfig;
  signatures: SignatureBundle;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`canonicalJson: non-integer number ${value}`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
}

export function committeeConfigHash(config: CommitteeConfig): Hex {
  return bytesToHex(ckbHash(DOMAIN_COMMITTEE_CONFIG, new TextEncoder().encode(canonicalJson(config))));
}

/** Structural problems with a config; an empty list means valid. */
export function validateCommitteeConfig(config: CommitteeConfig): string[] {
  const problems: string[] = [];
  const positive = (name: string, value: number) => {
    if (!Number.isSafeInteger(value) || value <= 0) problems.push(`${name} must be a positive integer`);
  };
  positive("version", config.version);
  positive("tickPeriodMs", config.tickPeriodMs);
  positive("observationDeadlineMs", config.observationDeadlineMs);
  positive("maxSigningLagMs", config.maxSigningLagMs);
  if (config.observationDeadlineMs >= config.tickPeriodMs) problems.push("observationDeadlineMs must be below tickPeriodMs");
  if (!/^\d+$/.test(config.activationTickMs) || BigInt(config.activationTickMs) % BigInt(config.tickPeriodMs) !== 0n) {
    problems.push("activationTickMs must be a tick boundary");
  }
  const checkMethod = (name: string, m: PriceMethod) => {
    positive(`${name}.windowMs`, m.windowMs);
    positive(`${name}.maxQuoteAgeMs`, m.maxQuoteAgeMs);
    positive(`${name}.maxSpreadBps`, m.maxSpreadBps);
    positive(`${name}.minVenues`, m.minVenues);
    for (const [field, value] of [
      ["maxBookAgeMs", m.maxBookAgeMs],
      ["minTopNotional", m.minTopNotional],
      ["maxDeviationBps", m.maxDeviationBps],
      ["tradeBookToleranceMs", m.tradeBookToleranceMs],
      ["tradeBookSlackPct", m.tradeBookSlackPct],
      ["vwapMinWindowNotional", m.vwapMinWindowNotional],
    ] as const) {
      if (value !== undefined) positive(`${name}.${field}`, value);
    }
    if ((m.tradeBookToleranceMs === undefined) !== (m.tradeBookSlackPct === undefined)) {
      problems.push(`${name}: tradeBookToleranceMs and tradeBookSlackPct go together`);
    }
    if (m.vwapClampToBook !== undefined && typeof m.vwapClampToBook !== "boolean") problems.push(`${name}: vwapClampToBook must be true or false`);
    // No single exchange can set a price, and one exchange failing does not stop the feed.
    if (m.minVenues < 2) problems.push(`${name}: minVenues must be at least 2`);
    if (m.markets.length < m.minVenues + 1) problems.push(`${name}: needs at least minVenues + 1 markets`);
    const venues = m.markets.map((market) => market.venue);
    if (new Set(venues).size !== venues.length) problems.push(`${name}: a venue is listed more than once`);
  };
  const checkTwap = (feed: TwapFeedConfig) => {
    const t = feed.twap;
    const name = feed.symbol;
    for (const field of ["windowMs", "everyMs", "minTicks"] as const) positive(`${name}.twap.${field}`, t[field]);
    for (const field of ["method", "markets", "minVenues", "windowMs", "maxQuoteAgeMs", "maxSpreadBps"]) {
      if (field in feed) problems.push(`${name}: a TWAP feed has no ${field} (it is priced from its source)`);
    }
    const source = config.feeds.find((f) => f.symbol === t.source);
    if (!source) problems.push(`${name}: source ${t.source} is not a feed of this config`);
    else if (isTwapFeed(source)) problems.push(`${name}: source ${t.source} is itself a TWAP`);
    else {
      if (feed.quote !== source.quote) problems.push(`${name}: quote must equal its source's (${source.quote})`);
      if (feed.expo !== source.expo) problems.push(`${name}: expo must equal its source's (${source.expo})`);
    }
    if (t.windowMs % 1000 !== 0 || feed.symbol !== `${t.source}.TWAP${t.windowMs / 1000}`) {
      problems.push(`${name}: symbol must be ${t.source}.TWAP<windowMs / 1000> (whole seconds)`);
    }
    if (t.windowMs % config.tickPeriodMs !== 0) problems.push(`${name}: twap.windowMs must be a multiple of tickPeriodMs`);
    if (t.everyMs % config.tickPeriodMs !== 0) problems.push(`${name}: twap.everyMs must be a multiple of tickPeriodMs`);
    if (t.minTicks > t.windowMs / config.tickPeriodMs) problems.push(`${name}: twap.minTicks exceeds the ticks in its window`);
  };
  config.feeds.forEach((feed, i) => {
    if (isTwapFeed(feed)) checkTwap(feed);
    else {
      checkMethod(feed.symbol, feed);
      if (feed.symbol.split("/").at(-1) !== feed.quote) problems.push(`${feed.symbol}: quote ${feed.quote} does not match the symbol`);
    }
    if (feedId(feed.symbol) !== feed.feedId) problems.push(`${feed.symbol}: feedId does not match symbol`);
    if (!Number.isInteger(feed.expo) || feed.expo < -18 || feed.expo > 18) problems.push(`${feed.symbol}: expo out of range`);
    positive(`${feed.symbol}.toleranceBps`, feed.toleranceBps);
    positive(`${feed.symbol}.emaHalfLifeMs`, feed.emaHalfLifeMs);
    const prev = config.feeds[i - 1];
    if (prev && compareBytes(hexToBytes(prev.feedId), hexToBytes(feed.feedId)) >= 0) {
      problems.push("feeds must be strictly ascending by feedId");
    }
  });
  if (config.feeds.length === 0 || config.feeds.length > 255) problems.push("1..=255 feeds required");
  return problems;
}

/** Approved by a quorum of `set` and structurally valid. */
export function verifyCommitteeConfig(signed: SignedCommitteeConfig, set: PublisherSet): boolean {
  return validateCommitteeConfig(signed.config).length === 0 && verifyThreshold(signed.signatures, committeeConfigHash(signed.config), set);
}
