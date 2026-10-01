// TWAP feeds (docs/designs/twap60.md): the averaging rules, config validation, and a 4-publisher
// committee with a lagging publisher and a failed tick inside the window.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as p from "lean-oracle-sdk/protocol";

import { computeTwap, dueTwapFeeds, mergeEntries, twapWindow } from "../dist/twap.js";
import { committeeConfig, makeCommittee, T0, twapFeed } from "./helpers.mjs";

const TWAP60 = { ...twapFeed("Crypto.BTC/USD", { windowMs: 60_000, everyMs: 60_000, minTicks: 45 }) };
const t = 1_790_000_040_000n; // a minute boundary
const points = (n, f = (i) => ({ price: 1000n + BigInt(i), conf: 4n }), from = t - 62_000n) => // points(60): ticks t-61 s .. t-2 s
  Array.from({ length: n }, (_, i) => ({ tickMs: from + BigInt(i + 1) * 1000n, ...f(i) }));

test("window: the 60 ticks t-61 s .. t-2 s (ticks t and t-1 s are not finalized yet)", () => {
  assert.deepEqual(twapWindow(t, 60_000, 1000), { from: t - 62_000n, to: t - 2000n });
  const all = points(64, (i) => ({ price: 1000n, conf: 1n }), t - 63_000n); // t-62 s .. t+1 s
  const out = computeTwap(TWAP60, [...all, { tickMs: t - 1000n, price: 9_999_999n, conf: 1n }, { tickMs: t, price: 9_999_999n, conf: 1n }], t, 1000, t);
  assert.equal(out.price, 1000n, "t and t-1 s are excluded, t-62 s too");
});

test("value: floor mean, conf = max(mean conf, MAD), sourceTimeMs = newest tick in the window", () => {
  const out = computeTwap(TWAP60, points(60), t, 1000, t - 2000n);
  assert.equal(out.price, 1029n); // mean of 1000..1059 = 1029.5, floored
  assert.equal(out.conf, 15n); // MAD of 1000..1059 = 15 > mean conf 4
  assert.equal(out.sourceTimeMs, t - 2000n);
  const calm = computeTwap(TWAP60, points(60, () => ({ price: 500n, conf: 7n })), t, 1000, t - 2000n);
  assert.deepEqual([calm.price, calm.conf], [500n, 7n]); // MAD 0: the mean conf
});

test("gaps: 45 ticks give a TWAP, 44 do not; a missing window-end tick alone does not block it", () => {
  assert.ok(computeTwap(TWAP60, points(60).slice(15), t, 1000, t));
  assert.equal(computeTwap(TWAP60, points(60).slice(16), t, 1000, t), undefined);
  // t-2 s itself failed to finalize, but this publisher is synced past it: still a TWAP from 59.
  const noEnd = points(60).filter((pt) => pt.tickMs !== t - 2000n);
  assert.equal(computeTwap(TWAP60, noEnd, t, 1000, t - 1000n).sourceTimeMs, t - 3000n);
});

test("a publisher not synced through the window end sits the boundary out", () => {
  assert.equal(computeTwap(TWAP60, points(57), t, 1000, t - 5000n), undefined);
  assert.equal(computeTwap(TWAP60, points(60), t, 1000, undefined), undefined);
});

test("due only at boundaries; entries merged in ascending feed ID", () => {
  const config = { ...committeeConfig({ twap: ["Crypto.BTC/USD"] }) };
  assert.equal(dueTwapFeeds(config, BigInt(T0)).length, 1);
  assert.equal(dueTwapFeeds(config, BigInt(T0 + 1000)).length, 0);
  const merged = mergeEntries([{ feedId: "0x03" }, { feedId: "0x0a" }], [{ feedId: "0x05" }]);
  assert.deepEqual(merged.map((e) => e.feedId), ["0x03", "0x05", "0x0a"]);
});

test("config validation accepts a TWAP feed and rejects every malformed one", () => {
  const ok = committeeConfig({ twap: ["Crypto.BTC/USD"] });
  assert.deepEqual(p.validateCommitteeConfig(ok), []);
  const bad = (edit) => {
    const c = structuredClone(ok);
    const f = c.feeds.find((x) => x.twap);
    edit(f, c);
    return p.validateCommitteeConfig(c).join(" | ");
  };
  assert.match(bad((f) => (f.twap.source = "Crypto.ETH/USD")), /not a feed of this config/);
  assert.match(bad((f) => (f.twap.windowMs = 20_000)), /symbol must be/);
  assert.match(bad((f) => (f.twap.everyMs = 1500)), /everyMs must be a multiple/);
  assert.match(bad((f) => (f.twap.minTicks = 11)), /minTicks exceeds/);
  assert.match(bad((f) => (f.twap.minTicks = 0)), /minTicks must be a positive integer/);
  assert.match(bad((f) => (f.expo = -6)), /expo must equal/);
  assert.match(bad((f) => (f.quote = "USDT")), /quote must equal/);
  assert.match(bad((f) => (f.markets = [])), /has no markets/);
  assert.match(bad((f, c) => {
    const src = c.feeds.find((x) => x.symbol === "Crypto.BTC/USD");
    Object.assign(f.twap, { source: f.symbol });
  }), /is itself a TWAP|not a feed/);
});

/** Run `n` ticks from `start`, returning the finalized update at `at` as decoded by publisher 0. */
async function runUntil(c, start, end, { down = () => [] } = {}) {
  for (let tick = start; tick <= end; tick += 1000) await c.runTick(tick, { down: down(tick) });
}
const twapLeaf = (c, i, tickMs) => {
  const hex = c.nodes[i].store.finalizedAt(BigInt(tickMs));
  if (!hex) return undefined;
  const id = p.feedId("Crypto.BTC/USD.TWAP10");
  return p.decodePriceUpdate(hex).entries.find((e) => e.message.feedId === id)?.message;
};
const spot = (c, tickMs) => {
  const hex = c.nodes[0].store.finalizedAt(BigInt(tickMs));
  return hex && p.decodePriceUpdate(hex).entries.find((e) => e.message.feedId === p.feedId("Crypto.BTC/USD"))?.message.price;
};

test("committee: boundary updates carry the TWAP, others do not, and it equals the mean of the window", async () => {
  const c = makeCommittee(4, { twap: ["Crypto.BTC/USD"] });
  await runUntil(c, T0, T0 + 20_000);
  const boundary = T0 + 20_000;
  const leaf = twapLeaf(c, 0, boundary);
  assert.ok(leaf, "boundary has a TWAP");
  assert.equal(twapLeaf(c, 0, boundary - 1000), undefined, "non-boundary has none");
  const window = Array.from({ length: 10 }, (_, i) => spot(c, boundary - 11_000 + i * 1000)); // t-11 s .. t-2 s
  assert.ok(window.every((x) => x !== undefined));
  assert.equal(leaf.price, window.reduce((s, x) => s + x, 0n) / 10n);
  for (let i = 1; i < 4; i++) assert.deepEqual(twapLeaf(c, i, boundary), leaf, "every publisher finalized the same leaf");
});

test("committee: a publisher that missed recent ticks sits out; the other 3 still sign the TWAP", async () => {
  const c = makeCommittee(4, { twap: ["Crypto.BTC/USD"] });
  const boundary = T0 + 20_000;
  // Publisher 3 is down for the last 4 ticks before the boundary, then back exactly at it.
  await runUntil(c, T0, boundary, { down: (tick) => (tick >= boundary - 4000 && tick < boundary ? [3] : []) });
  assert.ok(twapLeaf(c, 0, boundary), "quorum of 3 synced publishers produced it");
  const lagging = c.events.filter((e) => e.index === 3 && e.event === "sign.reject" && e.reason === "outside tolerance");
  assert.equal(lagging.length, 0, "the lagging publisher did not refuse over a TWAP it could not compute");
});

test("committee: a failed tick inside the window still yields a TWAP from the rest", async () => {
  const c = makeCommittee(4, { twap: ["Crypto.BTC/USD"] });
  const boundary = T0 + 20_000;
  const failed = boundary - 5000;
  await runUntil(c, T0, boundary, { down: (tick) => (tick === failed ? [0, 1, 2, 3] : []) });
  assert.equal(spot(c, failed), undefined, "that tick never finalized");
  const leaf = twapLeaf(c, 0, boundary);
  assert.ok(leaf, "9 of 10 ticks (minTicks 8) still give a TWAP");
  const window = Array.from({ length: 10 }, (_, i) => spot(c, boundary - 11_000 + i * 1000)).filter((x) => x !== undefined);
  assert.equal(leaf.price, window.reduce((s, x) => s + x, 0n) / BigInt(window.length));
});

test("REGRESSION: a config without TWAP feeds produces the same updates as before", async () => {
  const a = makeCommittee(4);
  const b = makeCommittee(4);
  await runUntil(a, T0, T0 + 12_000);
  await runUntil(b, T0, T0 + 12_000);
  for (let tick = T0; tick <= T0 + 12_000; tick += 1000) assert.equal(a.nodes[0].store.finalizedAt(BigInt(tick)), b.nodes[0].store.finalizedAt(BigInt(tick)));
  assert.equal(committeeConfig().feeds.some((f) => f.twap), false);
});

test("points at another exponent (a later config changed it) are skipped, never averaged", () => {
  // 10 of 60 ticks at expo -10 (100x the value): skipped, leaving 50 ≥ minTicks at expo -8.
  const mixed = points(60).map((pt, i) => (i < 10 ? { ...pt, price: pt.price * 100n, expo: -10 } : { ...pt, expo: -8 }));
  const kept = points(60).slice(10).map((pt) => pt.price);
  assert.equal(computeTwap(TWAP60, mixed, t, 1000, t).price, kept.reduce((s, x) => s + x, 0n) / 50n);
  assert.equal(computeTwap(TWAP60, points(60).map((pt) => ({ ...pt, expo: -6 })), t, 1000, t), undefined, "no point at the feed's scale");
});

test("validation: windows over an hour and any market setting on a TWAP feed are rejected", () => {
  const c = committeeConfig({ twap: ["Crypto.BTC/USD"] });
  const f = c.feeds.find((x) => x.twap);
  f.minTopNotional = 5;
  assert.match(p.validateCommitteeConfig(c).join(), /has no minTopNotional/);
  delete f.minTopNotional;
  Object.assign(f, { symbol: "Crypto.BTC/USD.TWAP7200", feedId: p.feedId("Crypto.BTC/USD.TWAP7200") });
  f.twap.windowMs = 7_200_000;
  assert.match(p.validateCommitteeConfig(c).join(), /at most 1 hour/);
});

test("a synced blob whose entries do not match its signed Merkle root is refused", async () => {
  const c = makeCommittee(4);
  for (let tick = T0; tick <= T0 + 3000; tick += 1000) await c.runTick(tick, { down: tick === T0 + 3000 ? [3] : [] });
  const hex = c.nodes[0].store.finalizedAt(BigInt(T0 + 3000));
  const update = p.decodePriceUpdate(hex);
  update.entries[0].message.price += 1_000_000n; // same signed header, altered price
  const tampered = p.encodePriceUpdate(update);
  c.nodes[3].node.acceptFinalized(tampered);
  assert.equal(c.nodes[3].store.finalizedAt(BigInt(T0 + 3000)), undefined);
  assert.ok(c.events.some((e) => e.index === 3 && e.event === "finalized.bad_entries"));
  c.nodes[3].node.acceptFinalized(Uint8Array.from(Buffer.from(hex.slice(2), "hex")));
  assert.equal(c.nodes[3].store.finalizedAt(BigInt(T0 + 3000)), hex, "the genuine blob is accepted");
});
