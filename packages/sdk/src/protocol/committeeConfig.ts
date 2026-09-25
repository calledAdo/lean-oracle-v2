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
  /** At least 2; the config must list at least one more market than this. */
  minVenues: number;
  /** One market per venue, each trading exactly `<base>/<quote>`. */
  markets: MarketConfig[];
}

/** A native pair feed, e.g. `Crypto.BTC/USDT`. Consumers derive other pairs by combining feeds. */
export interface FeedConfig extends PriceMethod {
  symbol: string;
  /** Quote currency; must match the symbol's suffix. */
  quote: string;
  feedId: Hex;
  expo: number;
  toleranceBps: number;
  emaHalfLifeMs: number;
}

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
    for (const [field, value] of [["maxBookAgeMs", m.maxBookAgeMs], ["minTopNotional", m.minTopNotional], ["maxDeviationBps", m.maxDeviationBps]] as const) {
      if (value !== undefined) positive(`${name}.${field}`, value);
    }
    // No single exchange can set a price, and one exchange failing does not stop the feed.
    if (m.minVenues < 2) problems.push(`${name}: minVenues must be at least 2`);
    if (m.markets.length < m.minVenues + 1) problems.push(`${name}: needs at least minVenues + 1 markets`);
    const venues = m.markets.map((market) => market.venue);
    if (new Set(venues).size !== venues.length) problems.push(`${name}: a venue is listed more than once`);
  };
  config.feeds.forEach((feed, i) => {
    checkMethod(feed.symbol, feed);
    if (feed.symbol.split("/").at(-1) !== feed.quote) problems.push(`${feed.symbol}: quote ${feed.quote} does not match the symbol`);
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
