// The replay harness (scripts/replay.mjs): a recording made by the Recorder replays to exactly the
// observations the publisher made live, twice identically, and the D5 divergence rule is enforced.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import * as p from "lean-oracle-sdk/protocol";

import { MarketData } from "../dist/marketData.js";
import { observeFeeds } from "../dist/methodology.js";
import { Recorder } from "../dist/recorder.js";
import { compare, divergence, readRecording, recordedTicks, replay, skew } from "../scripts/replay.mjs";

const E18 = 10n ** 18n;
const T = Date.UTC(2026, 8, 27, 10, 0, 0);
const feed = (symbol, method, extra = {}) => ({
  symbol, quote: "USDT", feedId: p.feedId(symbol), expo: -6, toleranceBps: 200, emaHalfLifeMs: 3_600_000,
  method, windowMs: method === "vwap" ? 60_000 : 1000, maxQuoteAgeMs: method === "vwap" ? 60_000 : 2000, maxSpreadBps: 300,
  minVenues: 2, maxDeviationBps: 300, markets: ["binance", "gate", "kucoin"].map((venue) => ({ venue, market: "X" })), ...extra,
});
const config = { feeds: [feed("Crypto.CKB/USDT", "vwap"), feed("Crypto.BTC/USDT", "mid")].sort((a, b) => (a.feedId < b.feedId ? -1 : 1)) };

/** Simulate 120 s of live publishing through the Recorder, observing every second like the node. */
async function record() {
  const dir = mkdtempSync(join(tmpdir(), "lean-replay-"));
  const data = new MarketData();
  const rec = new Recorder(data, { dir });
  let seed = 3;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let ms = T; ms < T + 120_000; ms += 50) {
    for (const v of ["binance", "gate", "kucoin"]) {
      if (rand() < 0.3) {
        const mid = 1_000_000n + BigInt(Math.floor((rand() - 0.5) * 4000));
        rec.quote(v, "X", { bid: (mid - 500n) * 10n ** 12n, ask: (mid + 500n) * 10n ** 12n, timeMs: ms });
      }
      if (rand() < 0.05) rec.trade(v, "X", { price: (1_000_000n + BigInt(Math.floor((rand() - 0.5) * 3000))) * 10n ** 12n, qty: E18, timeMs: ms });
    }
    if (ms % 1000 === 0 && ms > T) {
      rec.tick(BigInt(ms), observeFeeds(config, data, ms));
      await new Promise((r) => setImmediate(r)); // a live process yields between ticks
    }
  }
  assert.equal(rec.droppedEvents, 0);
  await rec.close();
  return dir;
}

test("a replay reproduces the recorded live observations exactly, and twice identically", async () => {
  const records = readRecording(await record());
  const live = recordedTicks(records);
  const a = replay(records, config);
  assert.equal(a.size, 119);
  const fidelity = Object.values(compare(live, a));
  assert.equal(fidelity.length, 2);
  for (const f of fidelity) assert.deepEqual([f.onlyA, f.onlyB, f.beyond1bp], [0, 0, 0]);
  const b = replay(records, config);
  assert.deepEqual([...b], [...a]);
});

test("compare reports what a candidate config changes, against the baseline's conf", async () => {
  const records = readRecording(await record());
  const a = replay(records, config);
  const clamp = { feeds: config.feeds.map((f) => (f.method === "vwap" ? { ...f, vwapClampToBook: true } : f)) };
  const change = compare(a, replay(records, clamp));
  const btc = change[p.feedId("Crypto.BTC/USDT")];
  assert.deepEqual([btc.beyond1bp, btc.maxBps], [0, 0]); // mid feeds untouched
  assert.ok(change[p.feedId("Crypto.CKB/USDT")].ticks > 0);
});

test("the divergence rule: min conf on at least 99% of shared ticks, max conf on every tick", () => {
  const e = (price, conf) => new Map([["f", { price, conf }]]);
  const run = (pairs) => new Map(pairs.map(([t, price, conf]) => [t, e(price, conf)]));
  const base = run(Array.from({ length: 200 }, (_, t) => [t, 1000n, 10n]));
  // 2 of 200 ticks beyond the smaller conf (1%), none beyond the larger: pass.
  const near = run(Array.from({ length: 200 }, (_, t) => [t, t < 2 ? 1015n : 1000n, t < 2 ? 20n : 10n]));
  assert.equal(divergence([base, near]).pass, true);
  // 3 of 200 (1.5%): fail.
  const drift = run(Array.from({ length: 200 }, (_, t) => [t, t < 3 ? 1015n : 1000n, t < 3 ? 20n : 10n]));
  assert.equal(divergence([base, drift]).pass, false);
  // One tick beyond the larger conf: fail.
  const wild = run(Array.from({ length: 200 }, (_, t) => [t, t === 0 ? 1100n : 1000n, 10n]));
  assert.equal(divergence([base, wild]).pass, false);
});

test("skewed arrival is deterministic per simulated publisher and bounded by the skew", async () => {
  const s = skew(50, 1);
  const first = Array.from({ length: 100 }, (_, i) => s(i));
  assert.deepEqual(Array.from({ length: 100 }, (_, i) => s(i)), first);
  assert.ok(first.every((d) => d >= 0 && d <= 50));
  assert.notDeepEqual(Array.from({ length: 100 }, (_, i) => skew(50, 2)(i)), first);
  const records = readRecording(await record());
  const runs = [0, 1, 2].map((k) => replay(records, config, { shift: skew(50, k) }));
  assert.equal(divergence(runs).pass, true);
});

test("a file cut off mid-write and continued after a restart keeps both halves", async () => {
  const { gzipSync } = await import("node:zlib");
  const { readRecordingFile } = await import("../scripts/replay.mjs");
  const first = gzipSync(Buffer.from(Array.from({ length: 2000 }, (_, i) => JSON.stringify({ t: "alive", ms: i, venue: "a" })).join("\n") + "\n"));
  const cut = first.subarray(0, Math.floor(first.length * 0.7)); // killed before the flush
  const second = gzipSync(Buffer.from(`${JSON.stringify({ t: "alive", ms: 99_999, venue: "b" })}\n`));
  const text = readRecordingFile(Buffer.concat([cut, second]));
  const recs = text.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  assert.ok(recs.filter((r) => r.venue === "a").length > 500, "the cut member still yields its data");
  assert.equal(recs.at(-1).venue, "b", "the member after the restart is read");
});
