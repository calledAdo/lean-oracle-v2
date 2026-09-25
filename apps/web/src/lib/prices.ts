"use client";

// Live prices from the public testnet mirror, keyed by feed symbol. One request per committee per
// poll; every feed in the SDK registry (lean-oracle-sdk/presets) is included.

import { useEffect, useState } from "react";
import { FEEDS } from "lean-oracle-sdk/presets";

export const MIRROR = "https://64-227-40-35.sslip.io";

export interface LivePrice {
  symbol: string;
  committee: string;
  price: number;
  conf: number;
  publishTimeMs: number;
}

const committees = [...new Set(FEEDS.map((f) => f.committee))];

/** Symbol without the `Crypto.` prefix, e.g. `BTC/USDT`. */
export const pair = (symbol: string) => symbol.replace(/^Crypto\./, "");

/** Decimal places for a price of this size (also used for its confidence, so both line up). */
export const decimalsFor = (price: number) => (price >= 1000 ? 2 : price >= 1 ? 4 : 6);

export function formatPrice(value: number, digits = decimalsFor(value)): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function useLivePrices(intervalMs = 2000): Map<string, LivePrice> {
  const [prices, setPrices] = useState<Map<string, LivePrice>>(new Map());
  useEffect(() => {
    let stop = false;
    const bySymbolId = new Map(FEEDS.map((f) => [f.feedId.toLowerCase(), f]));
    const poll = async () => {
      const next = new Map<string, LivePrice>();
      await Promise.all(
        committees.map(async (committee) => {
          const ids = FEEDS.filter((f) => f.committee === committee).map((f) => f.symbol).join(",");
          try {
            const res = await fetch(`${MIRROR}/v1/updates/latest?ids=${encodeURIComponent(ids)}`);
            const { updates } = (await res.json()) as { updates: { publishTimeMs: string; prices: { feedId: string; price: string; conf: string; expo: number }[] }[] };
            for (const u of updates) {
              for (const p of u.prices) {
                const feed = bySymbolId.get(p.feedId.toLowerCase());
                if (!feed) continue;
                const scale = 10 ** p.expo;
                next.set(feed.symbol, { symbol: feed.symbol, committee, price: Number(p.price) * scale, conf: Number(p.conf) * scale, publishTimeMs: Number(u.publishTimeMs) });
              }
            }
          } catch {
            // Keep showing the previous prices for this committee.
          }
        }),
      );
      if (!stop) setPrices((prev) => new Map([...prev, ...next]));
    };
    poll();
    const timer = setInterval(poll, intervalMs);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [intervalMs]);
  return prices;
}
