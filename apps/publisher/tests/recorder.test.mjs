// The market-data recorder: forwards every event unchanged, records it, rotates hourly under a disk
// cap, never blocks or breaks pricing, and takes depth snapshots without escalating rate limits.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { MarketData } from "../dist/marketData.js";
import { DEPTH_REFUSED_BACKOFF_MS, Recorder } from "../dist/recorder.js";
import { RestPoller, mexc } from "../dist/sources/rest.js";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 27, 10, 0, 0);
const dir = () => mkdtempSync(join(tmpdir(), "lean-rec-"));
const lines = (path) => gunzipSync(readFileSync(path)).toString().trim().split("\n").map((l) => JSON.parse(l));
const E18 = 10n ** 18n;

test("forwards every event to MarketData unchanged and records it with bigint values as strings", async () => {
  const data = new MarketData();
  const d = dir();
  const rec = new Recorder(data, { dir: d, now: () => T0 });
  rec.quote("binance", "CKBUSDT", { bid: 14n * E18, ask: 15n * E18, timeMs: T0, bidSize: 2n * E18, askSize: 3n * E18 });
  rec.trade("binance", "CKBUSDT", { price: 14n * E18, qty: E18, timeMs: T0 + 1 });
  rec.alive("gate", T0 + 2);
  rec.tick(BigInt(T0), [{ feedId: "0xab", price: 1435n, conf: 5n, sourceTimeMs: BigInt(T0) }]);
  rec.event("venue.error", { venue: "mexc", error: "HTTP 429" });
  await rec.close();

  assert.equal(data.latestQuote("binance", "CKBUSDT", T0).bid, 14n * E18);
  assert.equal(data.tradesIn("binance", "CKBUSDT", T0, T0 + 1).length, 1);
  assert.equal(data.lastAliveMs("gate"), T0 + 2);

  const files = readdirSync(d);
  assert.deepEqual(files, ["rec-2026092710.ndjson.gz"]);
  const recs = lines(join(d, files[0]));
  assert.deepEqual(recs.map((r) => r.t), ["quote", "trade", "alive", "tick", "event"]);
  assert.equal(recs[0].bid, (14n * E18).toString());
  assert.equal(recs[3].tickMs, String(T0));
  assert.equal(recs[3].entries[0].price, "1435");
  assert.equal(recs[4].error, "HTTP 429");
});

test("rotates every UTC hour and deletes the oldest hours beyond the cap", async () => {
  const d = dir();
  // Two old recordings of 600 bytes each already on disk.
  writeFileSync(join(d, "rec-2026092707.ndjson.gz"), Buffer.alloc(600));
  writeFileSync(join(d, "rec-2026092708.ndjson.gz"), Buffer.alloc(600));
  writeFileSync(join(d, "notes.txt"), "kept: not a recording");
  const rec = new Recorder(new MarketData(), { dir: d, maxBytes: 1000 });
  rec.alive("gate", T0); // opens hour 10: 1200 bytes > 1000, the oldest hour goes
  assert.deepEqual(readdirSync(d).filter((f) => f.endsWith("07.ndjson.gz") || f.endsWith("08.ndjson.gz")), ["rec-2026092708.ndjson.gz"]);
  rec.alive("gate", T0 + HOUR); // hour 11
  rec.alive("gate", T0 + HOUR - 1); // a late event from hour 10 stays in the open file
  await rec.close();
  const files = readdirSync(d).sort();
  assert.ok(files.includes("rec-2026092710.ndjson.gz") && files.includes("rec-2026092711.ndjson.gz"));
  assert.deepEqual(lines(join(d, "rec-2026092711.ndjson.gz")).map((r) => r.ms), [T0 + HOUR, T0 + HOUR - 1]);
  assert.ok(files.includes("notes.txt"));
});

test("a write failure turns recording off while pricing keeps receiving events", async () => {
  const d = dir();
  chmodSync(d, 0o500); // read-only directory: opening the hour file fails
  const logs = [];
  const data = new MarketData();
  const rec = new Recorder(data, { dir: d, log: (event) => logs.push(event) });
  rec.alive("gate", T0);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(rec.active, false);
  assert.ok(logs.includes("recorder.failed"));
  rec.quote("gate", "CKB_USDT", { bid: E18, ask: 2n * E18, timeMs: T0 + 10 });
  assert.equal(data.latestQuote("gate", "CKB_USDT", T0 + 10).bid, E18);
  chmodSync(d, 0o700);
});

test("when the stream pushes back, events are dropped and counted instead of queued", async () => {
  const d = dir();
  const data = new MarketData();
  const rec = new Recorder(data, { dir: d });
  // One synchronous burst of ~6 MB of trades: past the 4 MB high-water mark nothing more is queued.
  const big = "9".repeat(200);
  for (let i = 0; i < 30_000; i++) rec.event("burst", { i, pad: big });
  assert.ok(rec.droppedEvents > 0);
  rec.trade("binance", "CKBUSDT", { price: E18, qty: E18, timeMs: T0 });
  assert.equal(data.tradesIn("binance", "CKBUSDT", T0 - 1, T0).length, 1); // pricing still fed
  await rec.close();
});

test("depth snapshots: recorded, skipped while the venue's price source backs off, and backed off on 429", async () => {
  const d = dir();
  let now = T0;
  const calls = [];
  let refuse = false;
  let priceBackoff = false;
  const rec = new Recorder(new MarketData(), {
    dir: d,
    now: () => now,
    depth: [{ venue: "mexc", market: "CKBUSDT" }, { venue: "gate", market: "CKB_USDT" }],
    isBackingOff: (venue) => priceBackoff && venue === "mexc",
    getJson: async (url) => {
      calls.push(url);
      if (refuse) throw new Error("HTTP 429");
      return { bids: [["0.001435", "1000"]], asks: [["0.001436", "2000"]] };
    },
  });
  await rec.snapshotAll();
  assert.equal(calls.length, 2);

  priceBackoff = true;
  await rec.snapshotAll();
  assert.equal(calls.length, 3); // mexc skipped, gate taken

  priceBackoff = false;
  refuse = true;
  await rec.snapshotAll(); // both refused: 10 min backoff each
  assert.equal(calls.length, 5);
  refuse = false;
  now += DEPTH_REFUSED_BACKOFF_MS - 1;
  await rec.snapshotAll();
  assert.equal(calls.length, 5);
  now += 2;
  await rec.snapshotAll();
  assert.equal(calls.length, 7);

  await rec.close();
  const depth = lines(join(d, readdirSync(d)[0])).filter((r) => r.t === "depth");
  assert.equal(depth.length, 5);
  assert.deepEqual(depth[0].bids, [["0.001435", "1000"]]);
});

test("the REST poller reports its backoff after a refusal", async () => {
  let now = T0;
  const poller = new RestPoller(mexc, ["CKBUSDT"], new MarketData(), () => {}, async () => ({ ok: false, status: 429, json: async () => ({}) }), () => now);
  assert.equal(poller.isBackingOff(), false);
  await poller.poll();
  assert.equal(poller.isBackingOff(), true);
  now += 30_001;
  assert.equal(poller.isBackingOff(), false);
});

test("close() flushes the open hour and is safe to call twice (stop, then shutdown)", async () => {
  const d = dir();
  const rec = new Recorder(new MarketData(), { dir: d });
  rec.alive("gate", T0);
  rec.stop();
  await Promise.race([rec.close(), new Promise((_, no) => setTimeout(() => no(new Error("second close hung")), 2000))]);
  assert.equal(lines(join(d, readdirSync(d)[0])).length, 1); // a complete gzip file
});
