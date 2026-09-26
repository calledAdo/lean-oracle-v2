"use client";

import Link from "next/link";
import { FEEDS } from "lean-oracle-sdk/presets";
import { formatPrice, pair, useLivePrices } from "@/lib/prices";
import { CopyValue } from "./copy";

// Venues by quote currency, per committee (docs/oracle-design.md section 3).
const VENUES: Record<string, Record<string, string>> = {
  majors: {
    USD: "Coinbase, Kraken, Bitstamp",
    USDT: "Binance, OKX, Bybit, Gate, Bitget, KuCoin, MEXC",
    USDC: "Binance, OKX, Bybit, Kraken, Bitget, KuCoin, MEXC, Gate",
  },
  ckb: { USDT: "Binance, Gate, Bitget, KuCoin, MEXC", USDC: "Binance, Gate, MEXC" },
};

/** Every launch feed with its ID, exponent, venues and the live testnet price. */
export function FeedTable() {
  const prices = useLivePrices(2000);
  return (
    <div className="not-prose my-6 overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="bg-card text-[13px] text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-medium">Feed</th>
            <th className="px-4 py-3 text-right font-medium">Testnet price</th>
            <th className="px-4 py-3 font-medium">Committee</th>
            <th className="px-4 py-3 font-medium">Exponent</th>
            <th className="px-4 py-3 font-medium">Feed ID</th>
          </tr>
        </thead>
        <tbody>
          {FEEDS.map((f) => {
            const live = prices.get(f.symbol);
            const quote = f.symbol.split("/")[1];
            return (
              <tr key={f.symbol} className="border-t border-border align-top">
                <td className="px-4 py-3">
                  <Link href={`/docs/feeds/${pair(f.symbol).replace("/", "-").toLowerCase()}`} className="font-medium underline-offset-4 hover:underline">{pair(f.symbol)}</Link>
                  <div className="mt-0.5 max-w-[220px] text-xs text-muted-foreground">{VENUES[f.committee]?.[quote] ?? "–"}</div>
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums">{live ? formatPrice(live.price) : "–"}</td>
                <td className="px-4 py-3">{f.committee}</td>
                <td className="px-4 py-3 font-mono">{f.expo}</td>
                <td className="px-3 py-2.5"><CopyValue value={f.feedId} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
