"use client";

// The hero diagram: prices flow from exchanges into Lean Oracle, get signed, and land on CKB.
// One 3-second cycle, choreographed on a shared clock so the story reads in order:
//   0.0–1.2 s  pulses travel from each exchange into Lean Oracle
//   1.2–1.6 s  Lean Oracle signs (ring)
//   1.5–2.4 s  one signed pulse travels to CKB, which shows the latest real price
// Based on the 21st.dev integration-card pattern (animated dashes along SVG paths).

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

const MIRROR = "https://64-227-40-35.sslip.io";
const CYCLE = 3;

// Layout in a 760 × 420 viewBox. Lean Oracle sits at the center, CKB on the right.
const ORACLE = { x: 420, y: 210 };
const CKB = { x: 650, y: 210 };

const EXCHANGES = [
  { name: "Binance", y: 50 },
  { name: "Coinbase", y: 114 },
  { name: "Kraken", y: 178 },
  { name: "OKX", y: 242 },
  { name: "Bybit", y: 306 },
  { name: "Bitstamp", y: 370 },
].map((e, i) => ({
  ...e,
  x: 88,
  // Horizontal out of the tile, then a smooth bend into the oracle's left edge.
  path: `M 146 ${e.y} C 260 ${e.y}, 290 ${ORACLE.y}, ${ORACLE.x - 52} ${ORACLE.y}`,
  delay: i * 0.07,
}));

const OUT_PATH = `M ${ORACLE.x + 52} ${ORACLE.y} H ${CKB.x - 52}`;

function Pulse({ d, color, delay, duration, animate }: { d: string; color: string; delay: number; duration: number; animate: boolean }) {
  return (
    <>
      <path d={d} stroke="var(--color-border)" strokeWidth={1.25} fill="none" />
      {animate && (
        <motion.path
          d={d}
          stroke={color}
          strokeWidth={3}
          strokeLinecap="round"
          fill="none"
          pathLength={1}
          strokeDasharray="0.14 1.2"
          initial={{ strokeDashoffset: 0.16 }}
          animate={{ strokeDashoffset: [0.16, -1.05] }}
          transition={{ duration, delay, repeat: Infinity, repeatDelay: CYCLE - duration, ease: "easeInOut" }}
        />
      )}
    </>
  );
}

function useLatestPrice(): { price: string; time: string } | undefined {
  const [latest, setLatest] = useState<{ price: string; time: string }>();
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`${MIRROR}/v1/updates/latest?ids=Crypto.BTC/USDT`);
        const { updates } = await res.json();
        const p = updates[0]?.prices[0];
        if (!stop && p) {
          const value = Number(p.price) * 10 ** p.expo;
          setLatest({
            price: value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
            time: new Date(Number(updates[0].publishTimeMs)).toISOString().slice(11, 19),
          });
        }
      } catch {
        // Keep the last value; the diagram still tells the story.
      }
    };
    tick();
    const timer = setInterval(tick, CYCLE * 1000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);
  return latest;
}

export function PriceFlow() {
  const reduced = useReducedMotion();
  const animate = !reduced;
  const latest = useLatestPrice();

  return (
    <div className="relative w-full" style={{ aspectRatio: "760 / 420" }}>
      <svg viewBox="0 0 760 420" className="absolute inset-0 h-full w-full" fill="none" aria-hidden="true">
        {EXCHANGES.map((e) => (
          <Pulse key={e.name} d={e.path} color="var(--signal)" delay={e.delay} duration={1.1} animate={animate} />
        ))}
        <Pulse d={OUT_PATH} color="var(--proof)" delay={1.5} duration={0.9} animate={animate} />
      </svg>

      {/* Exchanges */}
      {EXCHANGES.map((e) => (
        <div
          key={e.name}
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-card px-[clamp(5px,1.4vw,12px)] py-[clamp(1px,0.7vw,6px)] text-[clamp(9px,1.6vw,14px)] leading-tight font-medium text-foreground shadow-xs"
          style={{ left: `${(e.x / 760) * 100}%`, top: `${(e.y / 420) * 100}%` }}
        >
          {e.name}
        </div>
      ))}

      {/* Lean Oracle: the committee signs */}
      <div
        className="absolute -translate-x-1/2 -translate-y-1/2"
        style={{ left: `${(ORACLE.x / 760) * 100}%`, top: `${(ORACLE.y / 420) * 100}%` }}
      >
        <div className="relative flex flex-col items-center">
          <div className="relative flex size-[clamp(52px,12vw,104px)] items-center justify-center rounded-2xl border border-border bg-card text-foreground shadow-lg shadow-black/30">
            <Mark className="size-1/2" />
            {animate && (
              <motion.div
                className="absolute inset-0 rounded-2xl border-2"
                style={{ borderColor: "var(--signal)" }}
                initial={{ opacity: 0, scale: 1 }}
                animate={{ opacity: [0, 0.9, 0], scale: [1, 1.18, 1.3] }}
                transition={{ duration: 0.6, delay: 1.1, repeat: Infinity, repeatDelay: CYCLE - 0.6 }}
              />
            )}
          </div>
          <span className="mt-2 text-[clamp(10px,1.6vw,14px)] font-medium whitespace-nowrap">Lean Oracle</span>
        </div>
      </div>

      {/* Your contract: where the signed price is used */}
      <div
        className="absolute -translate-x-1/2 -translate-y-1/2"
        style={{ left: `${(CKB.x / 760) * 100}%`, top: `${(CKB.y / 420) * 100}%` }}
      >
        <div className="relative flex flex-col items-center">
          <motion.div
            className="flex size-[clamp(52px,12vw,104px)] items-center justify-center rounded-2xl border border-border bg-foreground text-background shadow-lg shadow-black/30"
            animate={animate ? { scale: [1, 1, 1.06, 1] } : undefined}
            transition={{ duration: CYCLE, times: [0, 0.78, 0.84, 0.92], repeat: Infinity }}
          >
            <span className="font-mono text-[clamp(14px,2.8vw,26px)] font-medium tracking-tight">{"{ }"}</span>
          </motion.div>
          <div className="mt-2 text-center leading-tight whitespace-nowrap">
            <div className="text-[clamp(10px,1.6vw,14px)] font-medium">Your contract</div>
            <div className="mt-1 text-[clamp(9px,1.4vw,12px)] text-muted-foreground">BTC/USDT</div>
            <div className="font-mono text-[clamp(10px,1.8vw,16px)] font-medium tabular-nums">{latest ? latest.price : "…"}</div>
            <div className="text-[clamp(9px,1.4vw,12px)] text-muted-foreground">{latest ? `signed at ${latest.time} UTC` : "waiting for the mirror"}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The Lean Oracle mark: the letter L drawn as a chart axis, holding one price candle. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 44 44" className={className} fill="none" aria-hidden="true">
      <path d="M11 5 V 39 H 39" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="20.5" y="12.5" width="8" height="15" rx="1.8" fill="var(--signal)" />
      <path d="M24.5 7.5 V 12.5 M24.5 27.5 V 32.5" stroke="var(--signal)" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}
