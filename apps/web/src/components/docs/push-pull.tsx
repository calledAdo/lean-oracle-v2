"use client";

import { useEffect, useState } from "react";

// Push vs pull on one clock. A cursor sweeps through time. In the push panel the on-chain price is
// written at fixed intervals and lags the market in between; in the pull panel prices are signed
// every tick off-chain and a transaction brings the latest one on-chain only when it needs it.

const W = 640;
const X0 = 110; // time axis starts after the row labels
const X1 = W - 16;
const LOOP_MS = 9000;
const PUSH_EVERY = 150; // px between push writes
const TICK_EVERY = 9; // px between signed updates
const PULLS = [300, 505]; // where a transaction pulls a price

// A market price wandering around the row's centre line (deterministic, so the loop is seamless).
const market = (x: number) => Math.sin(x / 37) * 9 + Math.sin(x / 13 + 1) * 4 + Math.sin(x / 91) * 11;

function path(from: number, to: number, y: (x: number) => number) {
  let d = "";
  for (let x = from; x <= to; x += 3) d += `${d ? "L" : "M"}${x.toFixed(1)} ${y(x).toFixed(1)}`;
  return d;
}

function usePlayhead() {
  const [x, setX] = useState(X1);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = ((now - start) % LOOP_MS) / LOOP_MS;
      // Sweep for 85% of the loop, then hold the finished picture briefly.
      setX(X0 + Math.min(p / 0.85, 1) * (X1 - X0));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return x;
}

export function PushPull() {
  const cursor = usePlayhead();

  // Push panel: market row at y=60, on-chain value drawn on the same scale.
  const pm = (x: number) => 62 + market(x);
  const writeAt = (x: number) => X0 + Math.floor((x - X0) / PUSH_EVERY) * PUSH_EVERY;
  const pushSteps = (to: number) => {
    let d = "";
    for (let x = X0; x <= to; x += 3) d += `${d ? "L" : "M"}${x.toFixed(1)} ${pm(writeAt(x)).toFixed(1)}`;
    return d;
  };
  const stale = (to: number) => {
    let top = "";
    let bottom = "";
    for (let x = X0; x <= to; x += 3) {
      top += `${top ? "L" : "M"}${x} ${pm(x).toFixed(1)}`;
      bottom = `L${x} ${pm(writeAt(x)).toFixed(1)}` + bottom;
    }
    return top + bottom + "Z";
  };

  // Pull panel: market at y=190 and signed ticks along it; chain row at y=250.
  const qm = (x: number) => 190 + market(x);
  const ticks: number[] = [];
  for (let x = X0; x <= cursor; x += TICK_EVERY) ticks.push(x);

  return (
    <figure className="not-prose my-8 rounded-xl border border-border bg-card p-4 sm:p-5">
      <svg viewBox={`0 0 ${W} 290`} className="w-full" role="img" aria-label="Push oracle compared with a pull oracle over time">
        <g fontFamily="inherit" fontSize="12" fill="var(--muted-foreground)">
          <text x="0" y="22" fill="var(--foreground)" fontSize="13" fontWeight="600">Push oracle</text>
          <text x="0" y="66">Market</text>
          <text x="0" y="104">On-chain</text>
          <text x="0" y="152" fill="var(--foreground)" fontSize="13" fontWeight="600">Pull oracle</text>
          <text x="0" y="194">Signed</text>
          <text x="0" y="254">On-chain</text>
        </g>
        <line x1={X0} x2={X1} y1="130" y2="130" stroke="var(--border)" />

        {/* Push: the gap between the market and the last write is what contracts read as stale. */}
        <path d={stale(cursor)} fill="var(--signal)" opacity="0.14" />
        <path d={path(X0, cursor, pm)} fill="none" stroke="var(--muted-foreground)" strokeWidth="1.5" />
        <path d={pushSteps(cursor)} fill="none" stroke="var(--signal)" strokeWidth="2" />
        {Array.from({ length: Math.floor((cursor - X0) / PUSH_EVERY) + 1 }, (_, i) => X0 + i * PUSH_EVERY).map((x) => (
          <g key={x}>
            <line x1={x} x2={x} y1={pm(x).toFixed(1)} y2="100" stroke="var(--signal)" strokeDasharray="2 3" />
            <rect x={x - 5} y="96" width="10" height="10" rx="2" fill="var(--signal)" />
          </g>
        ))}

        {/* Pull: a signed update every tick; the chain only sees the ones a transaction carries. */}
        <path d={path(X0, cursor, qm)} fill="none" stroke="var(--muted-foreground)" strokeWidth="1.5" opacity="0.5" />
        {ticks.map((x) => (
          <circle key={x} cx={x} cy={qm(x).toFixed(1)} r="2.2" fill="var(--signal)" />
        ))}
        {PULLS.filter((x) => x <= cursor).map((x) => (
          <g key={x}>
            <line x1={x} x2={x} y1={(qm(x) + 4).toFixed(1)} y2="242" stroke="var(--proof)" strokeWidth="1.5" />
            <circle cx={x} cy={qm(x).toFixed(1)} r="4.5" fill="none" stroke="var(--proof)" strokeWidth="1.5" />
            <rect x={x - 34} y="242" width="68" height="22" rx="5" fill="var(--background)" stroke="var(--proof)" />
            <text x={x} y="257" textAnchor="middle" fontSize="11" fill="var(--proof)" fontFamily="inherit">your tx</text>
          </g>
        ))}
        <line x1={X0} x2={X1} y1="253" y2="253" stroke="var(--border)" strokeDasharray="2 4" />

        <line x1={cursor} x2={cursor} y1="30" y2="275" stroke="var(--foreground)" opacity="0.18" />
      </svg>
      <figcaption className="mt-3 grid gap-3 text-[13.5px] leading-relaxed text-muted-foreground sm:grid-cols-2">
        <p>
          <span className="text-foreground">Push.</span> The oracle writes to the chain on a schedule and pays for every
          write. Between writes, contracts read an old price (the shaded gap).
        </p>
        <p>
          <span className="text-foreground">Pull.</span> Prices are signed off-chain every second. A transaction carries
          the latest one on-chain only when it needs a price, and the contract checks the signatures.
        </p>
      </figcaption>
    </figure>
  );
}
