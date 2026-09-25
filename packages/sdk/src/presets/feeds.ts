import { feedId } from "../protocol/hash.js";
import type { Hex } from "../types.js";

export interface FeedInfo {
  symbol: string;
  feedId: Hex;
  expo: number;
  committee: string;
}

const feed = (symbol: string, expo: number, committee: string): FeedInfo => ({ symbol, feedId: feedId(symbol), expo, committee });

/**
 * Launch feed registry (docs/oracle-design.md section 3). Every feed is a native pair priced only from
 * markets trading that pair; derive other pairs by combining feeds (e.g. BTC/USD ÷ USDT/USD).
 */
export const FEEDS: readonly FeedInfo[] = [
  ...["BTC", "ETH", "SOL"].flatMap((base) => ["USD", "USDT", "USDC"].map((quote) => feed(`Crypto.${base}/${quote}`, -8, "majors"))),
  feed("Crypto.USDT/USD", -8, "majors"),
  feed("Crypto.CKB/USDT", -10, "ckb"),
  feed("Crypto.CKB/USDC", -10, "ckb"),
];

export function feedBySymbol(symbol: string): FeedInfo | undefined {
  return FEEDS.find((f) => f.symbol === symbol);
}
