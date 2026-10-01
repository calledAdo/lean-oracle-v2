#!/usr/bin/env node
// T6 of docs/designs/manipulation-resistant-pricing.md: one streaming pass over a recording archive
// (too large to hold in memory), restricted to the CKB markets, which are the only feeds the v2
// methodology changes. Per tick it prices the CKB feeds with the baseline config (A, as signed live)
// and a candidate (B), and measures:
//   fidelity     A vs what the live publisher recorded (≤ 1 bp)
//   change       B vs A against A's conf; ticks where B omits a feed A priced
//   filters      per venue: trade notional the websocket filter rejects, clamp activity, floor fallbacks
//   cost         notional to move each venue 1% (from depth snapshots), median per 4-hour bucket
//   follow       how much of a ≥ threshold Binance move the websocket venues show 5 s later
//
//   node apps/publisher/scripts/t6.mjs --dir ~/lean-recordings --a v1.json [--b candidate.json] [--from ISO --to ISO]
// Without --b, B is A's CKB feeds plus the defaults below.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { parseArgs } from "node:util";
import { constants, createGunzip } from "node:zlib";

import { MarketData } from "../dist/marketData.js";
import { observeFeeds, tradesInsideBook } from "../dist/methodology.js";
import { REST_VENUES } from "../dist/sources/rest.js";

export const CANDIDATE = { vwapClampToBook: true, tradeBookToleranceMs: 500, tradeBookSlackPct: 100, vwapMinWindowNotional: 10 };
const ONE = 10n ** 18n;
const GZIP_HEADER = Buffer.from("1f8b08000000000000", "hex");
const HOUR_FILE = /^rec-(\d{10})\.ndjson\.gz$/;

const abs = (x) => (x < 0n ? -x : x);
const median = (xs) => {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor((s.length - 1) / 2)];
};
const medianNum = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] : null);
const pct = (n, d) => (d === 0 ? null : Math.round((n / d) * 10000) / 100);

/** Every line of one hourly file, member by member (cut-off members yield what they hold). */
export async function eachLine(buffer, onLine) {
  const starts = [];
  for (let i = buffer.indexOf(GZIP_HEADER); i !== -1; i = buffer.indexOf(GZIP_HEADER, i + 1)) starts.push(i);
  for (let k = 0; k < starts.length; k++) {
    const gunzip = createGunzip({ finishFlush: constants.Z_SYNC_FLUSH });
    const input = Readable.from([buffer.subarray(starts[k], starts[k + 1] ?? buffer.length)]);
    input.pipe(gunzip);
    const lines = createInterface({ input: gunzip, crlfDelay: Infinity });
    gunzip.on("error", () => lines.close()); // a cut-off member ends here
    // Errors from onLine are real bugs: let them propagate instead of looking like a cut-off file.
    for await (const line of lines) onLine(line);
  }
}

export async function analyze({ dir, configA, configB, fromMs = 0, toMs = Infinity, followThreshold = 0.01, hours, log = () => {} }) {
  const ckbA = { feeds: configA.feeds.filter((f) => f.symbol.includes("CKB")) };
  const ckbB = configB ? { feeds: configB.feeds.filter((f) => f.symbol.includes("CKB")) } : { feeds: ckbA.feeds.map((f) => ({ ...f, ...CANDIDATE })) };
  const feedName = new Map(ckbA.feeds.map((f) => [f.feedId, f.symbol]));
  const markets = new Map(); // "venue market" → { venue, market, feed }
  for (const f of ckbB.feeds) for (const m of f.markets) markets.set(`${m.venue} ${m.market}`, { ...m, feed: f });
  const venues = new Set([...markets.values()].map((m) => m.venue));

  const data = new MarketData();
  const r = {
    records: 0,
    ticks: 0,
    firstTickMs: null,
    lastTickMs: null,
    gaps: [], // recorded tick gaps over 5 s
    fidelity: {},
    perHour: {}, // hour → { ticks, fidelityTicks, beyond1bp }, to tell clean recording hours from lossy ones
    change: {},
    filters: {},
    cost: {},
    follow: { thresholdPct: followThreshold * 100, events: [] },
  };
  const row = (obj, k, init) => (obj[k] ??= init());
  let lastTick = null;
  let tickNo = 0;
  const mids = new Map(); // CKBUSDT venue → [ [tickMs, mid] ] last 70 s
  const pendingFollow = [];
  let followQuietUntil = 0;
  const depthBuckets = new Map();

  const onRecord = (rec) => {
    if (rec.t === "quote" || rec.t === "trade") {
      if (!markets.has(`${rec.venue} ${rec.market}`)) return;
      if (rec.t === "quote") {
        const sizes = rec.bidSize !== undefined && rec.askSize !== undefined ? { bidSize: BigInt(rec.bidSize), askSize: BigInt(rec.askSize) } : {};
        data.quote(rec.venue, rec.market, { bid: BigInt(rec.bid), ask: BigInt(rec.ask), timeMs: rec.ms, ...sizes });
      } else data.trade(rec.venue, rec.market, { price: BigInt(rec.price), qty: BigInt(rec.qty), timeMs: rec.ms });
      return;
    }
    if (rec.t === "alive") {
      if (venues.has(rec.venue)) data.alive(rec.venue, rec.ms);
      return;
    }
    if (rec.t === "depth") return onDepth(rec);
    if (rec.t === "tick") return onTick(rec);
  };

  const onDepth = (rec) => {
    const bids = rec.bids.map(([p, q]) => [Number(p), Number(q)]);
    const asks = rec.asks.map(([p, q]) => [Number(p), Number(q)]);
    if (!bids.length || !asks.length) return;
    const mid = (bids[0][0] + asks[0][0]) / 2;
    const within = (side, dir) => side.filter(([p]) => (dir > 0 ? p <= mid * 1.01 : p >= mid * 0.99)).reduce((s, [p, q]) => s + p * q, 0);
    const bucket = new Date(Math.floor(rec.ms / 14_400_000) * 14_400_000).toISOString().slice(0, 13);
    const key = `${rec.venue} ${rec.market}`;
    const b = depthBuckets.get(key) ?? new Map();
    depthBuckets.set(key, b);
    const list = b.get(bucket) ?? [];
    b.set(bucket, list);
    list.push({ up: within(asks, 1), down: within(bids, -1) });
  };

  const onTick = (rec) => {
    const tickMs = Number(rec.tickMs);
    if (tickMs < fromMs || tickMs > toMs) return;
    const hour = new Date(tickMs).toISOString().slice(0, 13);
    const ph = (r.perHour[hour] ??= { ticks: 0, fidelityTicks: 0, beyond1bp: 0 });
    ph.ticks++;
    // Hours outside `hours` (lossy recording) still feed MarketData but are not measured.
    const measured = !hours || hours.has(hour);
    r.ticks++;
    r.firstTickMs ??= tickMs;
    r.lastTickMs = tickMs;
    if (lastTick !== null && tickMs - lastTick > 5000) r.gaps.push({ from: new Date(lastTick).toISOString(), seconds: (tickMs - lastTick) / 1000 });
    lastTick = tickMs;

    const recorded = new Map(rec.entries.filter((e) => feedName.has(e.feedId)).map((e) => [e.feedId, { price: BigInt(e.price), conf: BigInt(e.conf) }]));
    const a = new Map(observeFeeds(ckbA, data, tickMs).map((e) => [e.feedId, e]));
    const b = new Map(observeFeeds(ckbB, data, tickMs).map((e) => [e.feedId, e]));
    for (const [id, name] of feedName) {
      const f = row(r.fidelity, name, () => ({ ticks: 0, recordedOnly: 0, replayOnly: 0, beyond1bp: 0 }));
      const c = row(r.change, name, () => ({ ticksA: 0, omittedByB: 0, addedByB: 0, beyondConfA: 0, maxBps: 0, sumAbsBps: 0, compared: 0 }));
      const x = recorded.get(id);
      const y = a.get(id);
      const z = b.get(id);
      if (x || y) f.ticks++;
      if (x && !y) f.recordedOnly++;
      if (y && !x) f.replayOnly++;
      if (x && y) {
        ph.fidelityTicks++;
        if (abs(x.price - y.price) * 10_000n > x.price) {
          f.beyond1bp++;
          ph.beyond1bp++;
        }
      }
      if (!measured) continue;
      if (y) c.ticksA++;
      if (y && !z) c.omittedByB++;
      if (z && !y) c.addedByB++;
      if (y && z) {
        c.compared++;
        const d = abs(y.price - z.price);
        if (d > y.conf) c.beyondConfA++;
        const bps = Number((d * 1_000_000n) / y.price) / 100;
        c.maxBps = Math.max(c.maxBps, bps);
        c.sumAbsBps += bps;
      }
    }

    // Per-venue filter activity, every 10th tick (the window is 60 s, so consecutive ticks overlap).
    if (measured && tickNo++ % 10 === 0) {
      for (const { venue, market, feed } of markets.values()) {
        const s = row(r.filters, `${feed.symbol} ${venue}`, () => ({ samples: 0, withTrades: 0, tradeNotional: 0, rejectedNotional: 0, clampActive: 0, belowFloor: 0, noBook: 0, rest: Boolean(REST_VENUES[venue]) }));
        s.samples++;
        const trades = data.tradesIn(venue, market, tickMs - feed.windowMs, tickMs);
        if (trades.length === 0) continue;
        s.withTrades++;
        const book = data.quotesIn(venue, market, tickMs - feed.windowMs - (feed.tradeBookToleranceMs ?? 0) - 60_000, tickMs).filter((q) => q.ask >= q.bid);
        const inWin = book.filter((q) => q.timeMs > tickMs - feed.windowMs);
        const win = inWin.length ? inWin : book.slice(-1);
        if (!win.length) {
          s.noBook++;
          continue;
        }
        const hs = median(win.map((q) => (q.ask - q.bid) / 2n));
        const notional = (ts) => ts.reduce((t, x) => t + (x.price * x.qty) / ONE, 0n);
        const all = notional(trades);
        const filtered = !REST_VENUES[venue] && feed.tradeBookToleranceMs !== undefined;
        const used = !filtered ? trades : tradesInsideBook(trades, book, feed.tradeBookToleranceMs, (hs * BigInt(feed.tradeBookSlackPct)) / 100n);
        const kept = notional(used);
        s.tradeNotional += Number(all) / 1e18;
        s.rejectedNotional += Number(all - kept) / 1e18;
        if (feed.vwapMinWindowNotional !== undefined && kept / ONE < BigInt(feed.vwapMinWindowNotional)) {
          s.belowFloor++;
          continue;
        }
        const vol = used.reduce((t, x) => t + x.qty, 0n);
        if (vol === 0n) continue; // every trade rejected
        const vwap = used.reduce((t, x) => t + x.price * x.qty, 0n) / vol;
        const bid = median(win.map((q) => q.bid));
        const ask = median(win.map((q) => q.ask));
        if (vwap < bid || vwap > ask) s.clampActive++;
      }
    }

    // Follow-through on CKB/USDT: Binance moves ≥ threshold over 60 s, then the websocket venues 5 s later.
    for (const venue of ["binance", "gate", "bitget", "kucoin"]) {
      const m = venue === "kucoin" ? "CKB-USDT" : venue === "gate" ? "CKB_USDT" : "CKBUSDT";
      const q = data.latestQuote(venue, m, tickMs);
      if (!q || tickMs - q.timeMs > 60_000) continue;
      const list = mids.get(venue) ?? [];
      mids.set(venue, list);
      list.push([tickMs, Number((q.bid + q.ask) / 2n) / 1e18]);
      while (list.length && list[0][0] < tickMs - 70_000) list.shift();
    }
    const at = (venue, t) => {
      const list = mids.get(venue) ?? [];
      let v;
      for (const [ms, mid] of list) if (ms <= t) v = mid;
      return v;
    };
    while (pendingFollow.length && pendingFollow[0].resolveAt <= tickMs) {
      const e = pendingFollow.shift();
      const ratios = {};
      for (const v of ["gate", "bitget", "kucoin"]) {
        const before = at(v, e.startMs);
        const after = at(v, tickMs);
        if (before !== undefined && after !== undefined) ratios[v] = Math.round(((after - before) / before / e.move) * 100) / 100;
      }
      r.follow.events.push({ at: new Date(e.atMs).toISOString(), movePct: Math.round(e.move * 10000) / 100, ratio5s: ratios });
    }
    const bNow = at("binance", tickMs);
    const bThen = at("binance", tickMs - 60_000);
    if (tickMs >= followQuietUntil && bNow !== undefined && bThen !== undefined && Math.abs(bNow - bThen) / bThen >= followThreshold) {
      pendingFollow.push({ atMs: tickMs, startMs: tickMs - 60_000, move: (bNow - bThen) / bThen, resolveAt: tickMs + 5000 });
      followQuietUntil = tickMs + 60_000;
    }
  };

  const files = readdirSync(dir).filter((f) => HOUR_FILE.test(f)).sort();
  for (const file of files) {
    const started = Date.now();
    await eachLine(readFileSync(join(dir, file)), (line) => {
      r.records++;
      // Cheap prefilter: market events of non-CKB markets are most of the archive.
      if ((line.startsWith('{"t":"quote"') || line.startsWith('{"t":"trade"')) && !line.includes("CKB")) return;
      if (line.startsWith('{"t":"event"')) return;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        return;
      }
      onRecord(rec);
    });
    log(`${file} ${((Date.now() - started) / 1000).toFixed(0)} s, ticks so far ${r.ticks}`);
  }

  for (const [key, buckets] of depthBuckets) {
    r.cost[key] = Object.fromEntries([...buckets].map(([bucket, list]) => [bucket, { up1pct: Math.round(medianNum(list.map((x) => x.up))), down1pct: Math.round(medianNum(list.map((x) => x.down))), n: list.length }]));
  }
  for (const c of Object.values(r.change)) {
    c.meanAbsBps = c.compared ? Math.round((c.sumAbsBps / c.compared) * 100) / 100 : null;
    c.withinConfAPct = pct(c.compared - c.beyondConfA, c.compared);
    c.omittedPct = pct(c.omittedByB, c.ticksA);
    delete c.sumAbsBps;
  }
  for (const s of Object.values(r.filters)) {
    s.rejectedNotionalPct = pct(s.rejectedNotional, s.tradeNotional);
    s.clampActivePct = pct(s.clampActive, s.withTrades);
    s.belowFloorPct = pct(s.belowFloor, s.withTrades);
    s.tradeNotional = Math.round(s.tradeNotional);
    s.rejectedNotional = Math.round(s.rejectedNotional);
  }
  const ratios = r.follow.events.flatMap((e) => Object.values(e.ratio5s));
  r.follow.summary = { events: r.follow.events.length, medianRatio5s: medianNum(ratios), sufficient: r.follow.events.length >= 10 };
  return r;
}

const loadConfig = (path) => {
  const json = JSON.parse(readFileSync(path, "utf8"));
  return json.config ?? json;
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const { values } = parseArgs({
    options: { dir: { type: "string" }, a: { type: "string" }, b: { type: "string" }, from: { type: "string" }, to: { type: "string" }, follow: { type: "string" }, hours: { type: "string" } },
  });
  if (!values.dir || !values.a) throw new Error("usage: t6.mjs --dir <recordings> --a <config> [--b <config>] [--from ISO --to ISO] [--follow 0.01]");
  const report = await analyze({
    dir: values.dir,
    configA: loadConfig(values.a),
    configB: values.b ? loadConfig(values.b) : undefined,
    fromMs: values.from ? Date.parse(values.from) : 0,
    toMs: values.to ? Date.parse(values.to) : Infinity,
    followThreshold: values.follow ? Number(values.follow) : 0.01,
    // A file listing the hours to measure (one "YYYY-MM-DDTHH" per line), e.g. from a first --a-only pass.
    hours: values.hours ? new Set(readFileSync(values.hours, "utf8").split("\n").filter(Boolean)) : undefined,
    log: (m) => process.stderr.write(`${m}\n`),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
