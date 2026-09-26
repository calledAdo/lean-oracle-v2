"use client";

import { useState } from "react";

// One tick's update: feeds as leaves, one root signed by the quorum. Picking a feed lights up the
// proof path: the few sibling hashes that tie that one price to the signed root.

const LEAVES = ["BTC/USD", "BTC/USDT", "ETH/USD", "ETH/USDT", "SOL/USD", "SOL/USDT", "USDT/USD", "BTC/USDC"];
const W = 640;
const leafX = (i: number) => 40 + i * ((W - 80) / 7);
const LEVELS = [
  { y: 222, xs: LEAVES.map((_, i) => leafX(i)) },
  { y: 160, xs: [0, 1, 2, 3].map((i) => (leafX(2 * i) + leafX(2 * i + 1)) / 2) },
  { y: 104, xs: [0, 1].map((i) => (leafX(4 * i) + leafX(4 * i + 3)) / 2) },
  { y: 52, xs: [W / 2] },
];

export function MerkleTree() {
  const [picked, setPicked] = useState(1);

  // Path nodes (index per level) and their siblings (the proof).
  const path = LEVELS.map((_, level) => picked >> level);
  const proof = LEVELS.slice(0, -1).map((_, level) => (picked >> level) ^ 1);

  const tone = (level: number, i: number) =>
    path[level] === i ? "var(--signal)" : proof[level] === i ? "var(--proof)" : "var(--border)";

  return (
    <figure className="not-prose my-8 rounded-xl border border-border bg-card p-4 sm:p-5">
      <svg viewBox={`0 0 ${W} 262`} className="w-full" role="img" aria-label="Merkle tree of one tick's prices with a signed root">
        {LEVELS.slice(1).map((lvl, l) =>
          lvl.xs.map((x, i) =>
            [0, 1].map((c) => {
              const child = LEVELS[l].xs[2 * i + c];
              const on = path[l] === 2 * i + c;
              return (
                <line key={`${l}-${i}-${c}`} x1={x} y1={lvl.y + 10} x2={child} y2={LEVELS[l].y - 12} stroke={on ? "var(--signal)" : "var(--border)"} strokeWidth={on ? 2 : 1.2} />
              );
            }),
          ),
        )}
        {LEVELS.slice(0, -1).map((lvl, l) =>
          lvl.xs.map((x, i) => (
            <rect key={`n${l}-${i}`} x={x - (l === 0 ? 30 : 12)} y={lvl.y - 11} width={l === 0 ? 60 : 24} height="22" rx="5" fill="var(--background)" stroke={tone(l, i)} strokeWidth="1.5" />
          )),
        )}
        {LEAVES.map((name, i) => (
          <text key={name} x={leafX(i)} y="226" textAnchor="middle" fontSize="10.5" fill={i === picked ? "var(--foreground)" : "var(--muted-foreground)"} fontFamily="inherit">
            {name}
          </text>
        ))}
        {/* Signed root */}
        <rect x={W / 2 - 46} y="38" width="92" height="28" rx="6" fill="var(--signal)" />
        <text x={W / 2} y="56" textAnchor="middle" fontSize="12" fontWeight="600" fill="var(--background)" fontFamily="inherit">Merkle root</text>
        <text x={W / 2 + 60} y="56" fontSize="11.5" fill="var(--muted-foreground)" fontFamily="inherit">signed by 3 of 4 publishers</text>
        {/* Hit areas */}
        {LEAVES.map((name, i) => (
          <rect key={`h${name}`} x={leafX(i) - 34} y="205" width="68" height="34" fill="transparent" className="cursor-pointer" onClick={() => setPicked(i)} onMouseEnter={() => setPicked(i)}>
            <title>{name}</title>
          </rect>
        ))}
      </svg>
      <figcaption className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
        Pick a feed. To prove <span className="text-foreground">{LEAVES[picked]}</span>, an update carries only that price and
        the <span className="text-[var(--proof)]">three sibling hashes</span> on its path, not the other seven prices. One set of
        signatures covers every feed in the tick.
      </figcaption>
    </figure>
  );
}
