"use client";

// A slow scrolling strip of every feed's latest price. Pauses on hover; static when the visitor
// prefers reduced motion.

import { FEEDS } from "lean-oracle-sdk/presets";

import { formatPrice, pair, useLivePrices } from "@/lib/prices";

export function Ticker() {
  const prices = useLivePrices(2000);
  const items = FEEDS.map((f) => ({ symbol: f.symbol, live: prices.get(f.symbol) }));
  const row = (hidden: boolean) => (
    <ul className="flex shrink-0 items-center gap-10 pr-10" aria-hidden={hidden}>
      {items.map(({ symbol, live }) => (
        <li key={symbol} className="flex items-baseline gap-2.5 whitespace-nowrap">
          <span className="text-sm text-muted-foreground">{pair(symbol)}</span>
          <span className="font-mono text-sm tabular-nums">{live ? formatPrice(live.price) : "…"}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="group relative overflow-hidden border-y border-border py-4 [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
      <div className="flex w-max animate-[ticker_60s_linear_infinite] group-hover:[animation-play-state:paused] motion-reduce:animate-none">
        {row(false)}
        {row(true)}
      </div>
    </div>
  );
}
