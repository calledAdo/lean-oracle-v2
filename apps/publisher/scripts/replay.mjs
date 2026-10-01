#!/usr/bin/env node
// Replays market-data recordings (apps/publisher/src/recorder.ts) through the publisher's methodology,
// for docs/designs/manipulation-resistant-pricing.md. It feeds the recorded events into MarketData in
// the order they were received and, at every recorded tick, prices each feed with a baseline config
// (A) and a candidate config (B).
//
//   node apps/publisher/scripts/replay.mjs --dir ~/lean-recordings --a configs/v1.json --b candidate.json
//   node apps/publisher/scripts/replay.mjs --dir ... --a v1.json --skew-ms 50 --publishers 3   (divergence)
//
// Reports per feed:
//   fidelity: A vs what the live publisher recorded (within 1 bp)
//   v2 change: B vs A, against A's conf
//   omissions: feeds priced by A but not B
// Configs are committee-config files ({ "config": ... } or a bare config).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { constants, gunzipSync } from "node:zlib";

import { MarketData } from "../dist/marketData.js";
import { observeFeeds } from "../dist/methodology.js";

const big = (v) => (v === undefined ? undefined : BigInt(v));

/**
 * The header Node's gzip writes (deflate, no flags, mtime 0, no extra flags), minus the last byte,
 * which names the OS (3 on Linux, other values elsewhere): where each member starts.
 */
const GZIP_HEADER = Buffer.from("1f8b08000000000000", "hex");

/**
 * Decompress a recording file member by member. A publisher that stops without flushing leaves a
 * cut-off member, and after a restart the same hour's file continues with a new member; each member
 * yields everything it holds, so neither the cut nor the open hour loses the rest of the file.
 */
export function readRecordingFile(buffer) {
  const starts = [];
  for (let i = buffer.indexOf(GZIP_HEADER); i !== -1; i = buffer.indexOf(GZIP_HEADER, i + 1)) starts.push(i);
  return starts
    .map((start, k) => {
      try {
        return gunzipSync(buffer.subarray(start, starts[k + 1] ?? buffer.length), { finishFlush: constants.Z_SYNC_FLUSH }).toString();
      } catch {
        return "";
      }
    })
    .join("\n");
}

/** Every record of every `rec-*.ndjson.gz` in `dir`, oldest file first, in write order. */
export function readRecording(dir) {
  const files = readdirSync(dir).filter((f) => /^rec-\d{10}\.ndjson\.gz$/.test(f)).sort();
  const records = [];
  for (const f of files) {
    const text = readRecordingFile(readFileSync(join(dir, f)));
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // a truncated last line of the file being written
      }
    }
  }
  return records;
}

/** Apply one recorded market event to `data` (other record types are ignored). */
export function apply(data, r, shiftMs = 0) {
  if (r.t === "quote") {
    const sizes = r.bidSize !== undefined && r.askSize !== undefined ? { bidSize: big(r.bidSize), askSize: big(r.askSize) } : {};
    data.quote(r.venue, r.market, { bid: big(r.bid), ask: big(r.ask), timeMs: r.ms + shiftMs, ...sizes });
  } else if (r.t === "trade") data.trade(r.venue, r.market, { price: big(r.price), qty: big(r.qty), timeMs: r.ms + shiftMs });
  else if (r.t === "alive") data.alive(r.venue, r.ms + shiftMs);
}

/** Observations from one pass over `records` with `config`: Map tickMs → Map feedId → entry. */
export function replay(records, config, { shift } = {}) {
  const data = new MarketData();
  const out = new Map();
  // With `shift`, each event arrives late by shift(i) ms: hold it until the replay clock passes it.
  const pending = [];
  records.forEach((r, i) => {
    if (r.t === "tick") {
      const tickMs = Number(r.tickMs);
      if (shift) {
        pending.sort((a, b) => a.at - b.at);
        while (pending.length && pending[0].at <= r.ms) apply(data, pending.shift().r);
      }
      out.set(tickMs, new Map(observeFeeds(config, data, tickMs).map((e) => [e.feedId, e])));
      return;
    }
    if (shift) pending.push({ r, at: r.ms + shift(i) });
    else apply(data, r);
  });
  return out;
}

/** What the live publisher recorded: Map tickMs → Map feedId → entry. */
export function recordedTicks(records) {
  return new Map(
    records
      .filter((r) => r.t === "tick")
      .map((r) => [Number(r.tickMs), new Map(r.entries.map((e) => [e.feedId, { ...e, price: big(e.price), conf: big(e.conf) }]))]),
  );
}

const abs = (x) => (x < 0n ? -x : x);
const withinBps = (a, b, bps) => abs(a - b) * 10_000n <= BigInt(bps) * abs(b);

/** Per-feed comparison of `b` against `a` (both from `replay` or `recordedTicks`). */
export function compare(a, b) {
  const feeds = new Map();
  const row = (id) => feeds.get(id) ?? feeds.set(id, { ticks: 0, onlyA: 0, onlyB: 0, beyondConfA: 0, beyond1bp: 0, maxBps: 0 }).get(id);
  for (const [tick, ea] of a) {
    const eb = b.get(tick) ?? new Map();
    for (const [id, x] of ea) {
      const r = row(id);
      r.ticks++;
      const y = eb.get(id);
      if (!y) {
        r.onlyA++;
        continue;
      }
      const diff = abs(x.price - y.price);
      if (diff > x.conf) r.beyondConfA++;
      if (!withinBps(y.price, x.price, 1)) r.beyond1bp++;
      r.maxBps = Math.max(r.maxBps, Number((diff * 10_000n) / (x.price === 0n ? 1n : x.price)));
    }
    for (const id of eb.keys()) if (!ea.has(id)) row(id).onlyB++;
  }
  return Object.fromEntries(feeds);
}

/**
 * D5 divergence rule between simulated publishers: for every pair, |P_i − P_j| ≤ min(conf) on at
 * least 99% of shared ticks and ≤ max(conf) on every one.
 */
export function divergence(runs) {
  const result = { pairs: 0, ticks: 0, overMin: 0, overMax: 0 };
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      result.pairs++;
      for (const [tick, ei] of runs[i]) {
        const ej = runs[j].get(tick);
        if (!ej) continue;
        for (const [id, x] of ei) {
          const y = ej.get(id);
          if (!y) continue;
          result.ticks++;
          const d = abs(x.price - y.price);
          if (d > (x.conf < y.conf ? x.conf : y.conf)) result.overMin++;
          if (d > (x.conf > y.conf ? x.conf : y.conf)) result.overMax++;
        }
      }
    }
  }
  result.pass = result.overMax === 0 && result.overMin * 100 <= result.ticks;
  return result;
}

/** Deterministic per-event delays in [0, skewMs] for simulated publisher `k`. */
export function skew(skewMs, k) {
  let seed = 2_654_435_761 * (k + 1);
  const delays = new Map();
  return (i) => {
    if (!delays.has(i)) {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      delays.set(i, Math.floor((seed / 2 ** 31) * (skewMs + 1)));
    }
    return delays.get(i);
  };
}

const loadConfig = (path) => {
  const json = JSON.parse(readFileSync(path, "utf8"));
  return json.config ?? json;
};

function main() {
  const { values } = parseArgs({
    options: { dir: { type: "string" }, a: { type: "string" }, b: { type: "string" }, "skew-ms": { type: "string" }, publishers: { type: "string" } },
  });
  if (!values.dir || !values.a) throw new Error("usage: replay.mjs --dir <recordings> --a <config> [--b <config>] [--skew-ms N --publishers K]");
  const records = readRecording(values.dir);
  const configA = loadConfig(values.a);
  const a = replay(records, configA);
  const report = { records: records.length, ticks: a.size, fidelity: compare(recordedTicks(records), a) };
  if (values.b) {
    const b = replay(records, loadConfig(values.b));
    report.change = compare(a, b);
  }
  if (values["skew-ms"]) {
    const k = Number(values.publishers ?? 3);
    report.divergence = divergence(Array.from({ length: k }, (_, i) => replay(records, configA, { shift: skew(Number(values["skew-ms"]), i) })));
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
