"use client";

// Hero visual: every exchange Lean Oracle reads sits on a ring; each cycle a pulse travels from
// every exchange into the center, the committee signs (amber ring), and the latest signed
// BTC/USDT price from the testnet mirror shows under the mark. Static under reduced motion.

import { motion, useReducedMotion } from "motion/react";

import { Mark } from "@/components/ui/brand";
import { formatPrice, useLivePrices } from "@/lib/prices";

const SIZE = 600;
const C = SIZE / 2;
const RING = 236;
const NODE = 62;
const CYCLE = 3.2;

const EXCHANGES = ["Binance", "Coinbase", "Kraken", "OKX", "Bybit", "Bitstamp", "Gate", "Bitget", "KuCoin", "MEXC"].map((name, i, all) => {
  const angle = -Math.PI / 2 + (i / all.length) * Math.PI * 2;
  const at = (r: number) => ({ x: C + r * Math.cos(angle), y: C + r * Math.sin(angle) });
  const from = at(RING - 34);
  const to = at(NODE + 10);
  return { name, pos: at(RING), path: `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} L ${to.x.toFixed(1)} ${to.y.toFixed(1)}`, delay: (i % 5) * 0.09 + (i >= 5 ? 0.045 : 0) };
});

const pct = (v: number) => `${(v / SIZE) * 100}%`;

export function Convergence() {
  const reduced = useReducedMotion();
  const btc = useLivePrices(2000).get("Crypto.BTC/USDT");

  return (
    <figure className="mx-auto w-full max-w-[560px]">
    <div className="relative aspect-square w-full">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="absolute inset-0 h-full w-full" fill="none" aria-hidden="true">
        <circle cx={C} cy={C} r={RING} stroke="var(--color-border)" strokeDasharray="2 6" />
        <circle cx={C} cy={C} r={NODE + 44} stroke="var(--color-border)" opacity="0.6" />
        {EXCHANGES.map((e) => (
          <g key={e.name}>
            <path d={e.path} stroke="var(--color-border)" strokeWidth={1.25} />
            {!reduced && (
              <motion.path
                d={e.path}
                stroke="var(--signal)"
                strokeWidth={2.5}
                strokeLinecap="round"
                pathLength={1}
                strokeDasharray="0.18 1.2"
                initial={{ strokeDashoffset: 0.2 }}
                animate={{ strokeDashoffset: [0.2, -1.05] }}
                transition={{ duration: 1.25, delay: e.delay, repeat: Infinity, repeatDelay: CYCLE - 1.25, ease: "easeIn" }}
              />
            )}
          </g>
        ))}
      </svg>

      {EXCHANGES.map((e) => (
        <div
          key={e.name}
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-card px-[clamp(8px,1.6vw,14px)] py-[clamp(3px,0.7vw,6px)] text-[clamp(10px,1.5vw,13px)] font-medium whitespace-nowrap shadow-sm shadow-black/30"
          style={{ left: pct(e.pos.x), top: pct(e.pos.y) }}
        >
          {e.name}
        </div>
      ))}

      <div className="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center">
        <div className="relative flex size-[clamp(68px,17vw,112px)] items-center justify-center rounded-3xl border border-border bg-card text-foreground shadow-xl shadow-black/40">
          <Mark className="size-1/2" />
          {!reduced && (
            <motion.div
              className="absolute inset-0 rounded-3xl border-2 border-[var(--signal)]"
              initial={{ opacity: 0, scale: 1 }}
              animate={{ opacity: [0, 0.9, 0], scale: [1, 1.14, 1.28] }}
              transition={{ duration: 0.7, delay: 1.35, repeat: Infinity, repeatDelay: CYCLE - 0.7 }}
            />
          )}
        </div>
      </div>

    </div>
    <figcaption className="mt-2 flex items-center justify-center gap-2 text-sm text-muted-foreground">
      <span className="size-1.5 rounded-full bg-[var(--proof)]" />
      Latest signed BTC/USDT
      <span className="font-mono text-foreground tabular-nums">{btc ? formatPrice(btc.price) : "…"}</span>
    </figcaption>
    </figure>
  );
}
