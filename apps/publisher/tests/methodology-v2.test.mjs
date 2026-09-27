// Methodology v2 for `vwap` feeds (docs/designs/manipulation-resistant-pricing.md, D7): the clamp to
// each venue's own book, the websocket-only trade-vs-book filter, the volume floor and the conf gap.
// Every new field is optional; without them the output must equal v1's.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as p from "lean-oracle-sdk/protocol";

import { MarketData } from "../dist/marketData.js";
import { observeFeeds, tradesInsideBook } from "../dist/methodology.js";

const E18 = 10n ** 18n;
const T = 1_790_000_000_000;
const px = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n; // decimal → 18-dec fixed point
const SYMBOL = "Crypto.CKB/USDT";
const VENUES = ["binance", "gate", "kucoin"];

function feed(extra = {}, markets = VENUES) {
  return {
    symbol: SYMBOL, quote: "USDT", feedId: p.feedId(SYMBOL), expo: -6, toleranceBps: 200, emaHalfLifeMs: 3_600_000,
    method: "vwap", windowMs: 60_000, maxQuoteAgeMs: 60_000, maxSpreadBps: 300, minVenues: 2, maxDeviationBps: 1000,
    markets: markets.map((venue) => ({ venue, market: "CKBUSDT" })), ...extra,
  };
}
const observe = (data, f) => observeFeeds({ feeds: [f] }, data, T)[0];

/** A steady book (bid 0.999 / ask 1.001) and honest trades at 1.000 on every venue. */
function market(venues = VENUES) {
  const data = new MarketData();
  for (const v of venues) {
    for (let ms = T - 59_000; ms <= T; ms += 1000) {
      data.quote(v, "CKBUSDT", { bid: px(0.999), ask: px(1.001), timeMs: ms });
      if (ms % 5000 === 0) data.trade(v, "CKBUSDT", { price: px(1.0), qty: 100n * E18, timeMs: ms + 1 });
    }
  }
  return data;
}

test("without the new fields the vwap result equals v1 (plain VWAP, conf = max(half-spread, MAD))", () => {
  const data = market();
  data.trade("kucoin", "CKBUSDT", { price: px(1.05), qty: 10n * E18, timeMs: T - 10 });
  const v1 = observe(data, feed());
  // kucoin's plain VWAP is pulled up by the print; the median of the three venues is still 1.000.
  assert.equal(v1.price, 1_000_000n);
  const k = observe(data, feed({}, ["kucoin", "gate", "binance"]));
  assert.deepEqual(k, v1);
  const alone = observeFeeds({ feeds: [feed({ minVenues: 2 }, ["kucoin", "gate", "binance"])] }, data, T)[0];
  assert.equal(alone.conf, 1_000n); // half-spread 0.001 dominates MAD 0
});

test("a +5% wash print with $10 of volume on a websocket venue is rejected; the venue stays at its book", () => {
  const data = market(["kucoin"]);
  data.trade("kucoin", "CKBUSDT", { price: px(1.05), qty: 10n * E18, timeMs: T - 10 });
  const filtered = observe(data, feed({ tradeBookToleranceMs: 200, tradeBookSlackPct: 100, minVenues: 1 }, ["kucoin", "gate"]));
  const plain = observe(data, feed({ minVenues: 1 }, ["kucoin", "gate"]));
  assert.ok(plain.price > 1_000_000n, "v1 lets the print in");
  assert.equal(filtered.price, 1_000_000n);
});

test("a print at the book edge passes the filter and is then clamped to the venue's median ask", () => {
  const data = new MarketData();
  for (let ms = T - 59_000; ms <= T; ms += 1000) data.quote("gate", "CKBUSDT", { bid: px(0.999), ask: px(1.001), timeMs: ms });
  // Only prints at ask + slack (slack = 1 half-spread = 0.001): VWAP 1.002, above the ask.
  for (let ms = T - 50_000; ms <= T; ms += 10_000) data.trade("gate", "CKBUSDT", { price: px(1.002), qty: E18, timeMs: ms + 1 });
  const f = feed({ tradeBookToleranceMs: 200, tradeBookSlackPct: 100, vwapClampToBook: true, minVenues: 1 }, ["gate", "binance"]);
  const out = observe(data, f);
  assert.equal(out.price, 1_001_000n); // clamped to the median ask
  assert.equal(out.conf, 2_000n); // conf widened by |VWAP − mid| = 0.002
});

test("the clamp bounds both sides", () => {
  const data = new MarketData();
  for (let ms = T - 59_000; ms <= T; ms += 1000) data.quote("gate", "CKBUSDT", { bid: px(0.999), ask: px(1.001), timeMs: ms });
  data.trade("gate", "CKBUSDT", { price: px(0.9), qty: E18, timeMs: T - 5 });
  assert.equal(observe(data, feed({ vwapClampToBook: true, minVenues: 1 }, ["gate", "binance"])).price, 999_000n);
});

test("REST venues skip the trade filter (poll-time stamps) but are still clamped", () => {
  const data = new MarketData();
  for (let ms = T - 59_000; ms <= T; ms += 1000) data.quote("mexc", "CKBUSDT", { bid: px(0.999), ask: px(1.001), timeMs: ms });
  data.trade("mexc", "CKBUSDT", { price: px(1.05), qty: E18, timeMs: T - 5 }); // would fail the filter
  const f = feed({ tradeBookToleranceMs: 200, tradeBookSlackPct: 100, vwapClampToBook: true, minVenues: 1 }, ["mexc", "gate"]);
  assert.equal(observe(data, f).price, 1_001_000n); // counted (no filter), then clamped
});

test("a venue with no usable book is not priced by vwap and, with no quotes for mid either, drops out", () => {
  const data = new MarketData();
  data.trade("gate", "CKBUSDT", { price: px(1.0), qty: E18, timeMs: T - 5 });
  data.alive("gate", T);
  assert.equal(observe(data, feed({ vwapClampToBook: true, minVenues: 1 }, ["gate", "binance"])), undefined);
});

test("below the window notional floor the venue uses the mid rule", () => {
  const data = new MarketData();
  for (let ms = T - 59_000; ms <= T; ms += 1000) data.quote("gate", "CKBUSDT", { bid: px(0.999), ask: px(1.001), timeMs: ms });
  data.trade("gate", "CKBUSDT", { price: px(1.0008), qty: 5n * E18, timeMs: T - 5 }); // $5 of trades
  const f = feed({ vwapMinWindowNotional: 10, minVenues: 1 }, ["gate", "binance"]);
  assert.equal(observe(data, f).price, 1_000_000n); // the mid, not the 1.0008 print
  assert.equal(observe(data, { ...f, vwapMinWindowNotional: 1 }).price, 1_000_800n);
});

test("the merged pass accepts exactly the trades the naive per-trade lookup accepts", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let round = 0; round < 50; round++) {
    const quotes = [];
    const trades = [];
    let ms = T;
    for (let i = 0; i < 200; i++) {
      ms += Math.floor(rand() * 300);
      const mid = 1 + (rand() - 0.5) * 0.02;
      quotes.push({ bid: px(mid - 0.0005), ask: px(mid + 0.0005), timeMs: ms });
      if (rand() < 0.3) trades.push({ price: px(mid + (rand() - 0.5) * 0.004), qty: E18, timeMs: ms + Math.floor(rand() * 400) });
    }
    trades.sort((a, b) => a.timeMs - b.timeMs);
    const tol = 150;
    const slack = px(0.0005);
    const naive = trades.filter((t) => {
      const before = quotes.filter((q) => q.timeMs <= t.timeMs - tol).at(-1);
      const around = quotes.filter((q) => q.timeMs > t.timeMs - tol && q.timeMs <= t.timeMs + tol);
      return [before, ...around].filter(Boolean).some((q) => t.price >= q.bid - slack && t.price <= q.ask + slack);
    });
    assert.deepEqual(tradesInsideBook(trades, quotes, tol, slack), naive, `round ${round}`);
  }
});

test("committee config validation accepts the new fields and rejects bad ones", () => {
  const base = { version: 1, committee: "majors", publisherSetTypeHash: `0x${"5e".repeat(32)}`, activationTickMs: "1790000000000", tickPeriodMs: 1000, observationDeadlineMs: 400, maxSigningLagMs: 3000 };
  const f = (extra) => ({ ...feed(extra, ["binance", "gate", "kucoin"]), minVenues: 2 });
  assert.deepEqual(p.validateCommitteeConfig({ ...base, feeds: [f({ vwapClampToBook: true, tradeBookToleranceMs: 200, tradeBookSlackPct: 100, vwapMinWindowNotional: 10 })] }), []);
  assert.match(p.validateCommitteeConfig({ ...base, feeds: [f({ tradeBookToleranceMs: 200 })] }).join(), /go together/);
  assert.match(p.validateCommitteeConfig({ ...base, feeds: [f({ vwapMinWindowNotional: -1 })] }).join(), /vwapMinWindowNotional must be a positive integer/);
  assert.match(p.validateCommitteeConfig({ ...base, feeds: [f({ vwapClampToBook: "yes" })] }).join(), /true or false/);
});
