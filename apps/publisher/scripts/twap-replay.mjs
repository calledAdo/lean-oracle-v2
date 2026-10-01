#!/usr/bin/env node
// T5 of docs/designs/twap60.md: TWAP60 over a recording archive, from the recorded per-tick prices
// (with one publisher these are the finalized prices). Per feed: boundaries, VOID share (fewer than
// minTicks), and how much calmer the TWAP is than spot at the same boundaries.
//
//   node apps/publisher/scripts/twap-replay.mjs --dir ~/lean-recordings --config v1.json [--hours clean.txt]

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { computeTwap } from "../dist/twap.js";
import { eachLine } from "./t6.mjs";

const { values } = parseArgs({ options: { dir: { type: "string" }, config: { type: "string" }, hours: { type: "string" } } });
const config = (() => { const j = JSON.parse(readFileSync(values.config, "utf8")); return j.config ?? j; })();
const hours = values.hours ? new Set(readFileSync(values.hours, "utf8").split("\n").filter(Boolean)) : undefined;
const spotFeeds = config.feeds.filter((f) => !f.twap);
const twapOf = new Map(spotFeeds.map((f) => [f.feedId, { symbol: `${f.symbol}.TWAP60`, feedId: f.feedId, expo: f.expo, twap: { source: f.symbol, windowMs: 60_000, everyMs: 60_000, minTicks: 45 } }]));

const history = new Map(); // feedId → [{ tickMs, price, conf }] last ~70 s
const stats = new Map();
const last = new Map(); // feedId → { spot, twap } at the previous measured boundary
let latest;
const bps = (a, b) => Number(((a > b ? a - b : b - a) * 1_000_000n) / b) / 100;
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };

function onTick(rec) {
  const tickMs = BigInt(rec.tickMs);
  // Boundary first: its window ends at t-2 s, so this tick's own entries are not in it.
  if (tickMs % 60_000n === 0n) {
    const hour = new Date(Number(tickMs)).toISOString().slice(0, 13);
    if (!hours || hours.has(hour)) {
      for (const [id, feed] of twapOf) {
        const s = stats.get(feed.symbol) ?? { boundaries: 0, void: 0, spotStepBps: [], twapStepBps: [], spotVsTwapBps: [] };
        stats.set(feed.symbol, s);
        s.boundaries++;
        const out = computeTwap(feed, history.get(id) ?? [], tickMs, 1000, latest);
        const spot = rec.entries.find((e) => e.feedId === id);
        if (!out) {
          s.void++;
          last.delete(id);
          continue;
        }
        if (spot) s.spotVsTwapBps.push(bps(BigInt(spot.price), out.price));
        const prev = last.get(id);
        if (prev && spot) {
          s.spotStepBps.push(bps(BigInt(spot.price), prev.spot));
          s.twapStepBps.push(bps(out.price, prev.twap));
        }
        if (spot) last.set(id, { spot: BigInt(spot.price), twap: out.price });
      }
    }
  }
  for (const e of rec.entries) {
    const list = history.get(e.feedId) ?? [];
    history.set(e.feedId, list);
    list.push({ tickMs, price: BigInt(e.price), conf: BigInt(e.conf) });
    while (list.length && list[0].tickMs < tickMs - 70_000n) list.shift();
  }
  latest = tickMs;
}

for (const file of readdirSync(values.dir).filter((f) => /^rec-\d{10}\.ndjson\.gz$/.test(f)).sort()) {
  await eachLine(readFileSync(join(values.dir, file)), (line) => {
    if (!line.startsWith('{"t":"tick"')) return;
    onTick(JSON.parse(line));
  });
}

const rows = [...stats].map(([symbol, s]) => ({
  feed: symbol,
  boundaries: s.boundaries,
  voidPct: Math.round((s.void / s.boundaries) * 10000) / 100,
  medianMinuteMoveBps: { spot: pct(s.spotStepBps, 0.5), twap: pct(s.twapStepBps, 0.5) },
  p99MinuteMoveBps: { spot: pct(s.spotStepBps, 0.99), twap: pct(s.twapStepBps, 0.99) },
  medianSpotVsTwapBps: pct(s.spotVsTwapBps, 0.5),
}));
process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
