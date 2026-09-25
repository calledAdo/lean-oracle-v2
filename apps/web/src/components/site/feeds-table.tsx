"use client";

import { useEffect, useState } from "react";
import { FEEDS } from "lean-oracle-sdk/presets";

import { decimalsFor, formatPrice, pair, useLivePrices } from "@/lib/prices";

const COMMITTEE_LABEL: Record<string, string> = { majors: "Majors, every 1 s", ckb: "CKB, every 2 s" };

export function FeedsTable() {
  const prices = useLivePrices(2000);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            <th className="px-5 py-3 font-medium">Pair</th>
            <th className="px-5 py-3 text-right font-medium">Price</th>
            <th className="px-5 py-3 text-right font-medium">Confidence</th>
            <th className="px-5 py-3 font-medium">Committee</th>
            <th className="px-5 py-3 text-right font-medium">Signed</th>
          </tr>
        </thead>
        <tbody>
          {FEEDS.map((f) => {
            const live = prices.get(f.symbol);
            const age = live ? Math.max(0, Math.round((now - live.publishTimeMs) / 1000)) : undefined;
            return (
              <tr key={f.symbol} className="border-b border-border last:border-0">
                <td className="px-5 py-3 font-medium">{pair(f.symbol)}</td>
                <td className="px-5 py-3 text-right font-mono tabular-nums">{live ? formatPrice(live.price) : "…"}</td>
                <td className="px-5 py-3 text-right font-mono tabular-nums text-muted-foreground">{live ? `± ${formatPrice(live.conf, decimalsFor(live.price))}` : ""}</td>
                <td className="px-5 py-3 text-muted-foreground">{COMMITTEE_LABEL[f.committee] ?? f.committee}</td>
                <td className="px-5 py-3 text-right text-muted-foreground tabular-nums">{age === undefined ? "" : age <= 1 ? "just now" : `${age} s ago`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
