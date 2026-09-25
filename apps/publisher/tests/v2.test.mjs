// Protocol v2 (leader order, early proposal, backups, wire, authenticated transport) and the
// measurement rules (liveness, dust, outliers, native pairs).
import assert from "node:assert/strict";
import { test } from "node:test";

import * as p from "lean-oracle-sdk/protocol";
import * as pub from "lean-oracle-sdk/publisher";
import WebSocket from "ws";

import { parseDecimal } from "../dist/fixed.js";
import { leaderOrder, NO_ANCHOR } from "../dist/leaderOrder.js";
import { MarketData } from "../dist/marketData.js";
import { observeFeeds } from "../dist/methodology.js";
import { decodeMessage, encodeMessage } from "../dist/wire.js";
import { WsTransport } from "../dist/wsTransport.js";
import { committeeConfig, makeCommittee, memorySigner, SET_TYPE_HASH, T0 } from "./helpers.mjs";

const BTC = p.feedId("Crypto.BTC/USD");
const headerOf = (blob) => blob && p.priceUpdateSigningHash(p.decodePriceUpdate(blob).header);

test("leader order is a deterministic permutation that changes with the anchor", () => {
  const a = leaderOrder(BigInt(T0), NO_ANCHOR, 7);
  assert.deepEqual([...a].sort(), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(leaderOrder(BigInt(T0), NO_ANCHOR, 7), a);
  const other = leaderOrder(BigInt(T0), `0x${"ab".repeat(32)}`, 7);
  const firsts = new Set(Array.from({ length: 64 }, (_, k) => leaderOrder(BigInt(T0), `0x${k.toString(16).padStart(64, "0")}`, 7)[0]));
  assert.ok(firsts.size >= 5, "different anchors pick different primaries");
  assert.ok(other.join() !== a.join() || firsts.size > 1);
});

test("rank 0 proposes as soon as every observation is in (no grace wait)", async () => {
  const c = makeCommittee(4);
  const tick = BigInt(T0);
  c.clock.now = T0;
  const { emitMockQuotes, mockMarketsFor } = await import("../dist/sources/mock.js");
  const { BASE } = await import("./helpers.mjs");
  const mocks = mockMarketsFor(c.config, BASE);
  for (const x of c.nodes) emitMockQuotes(x.marketData, mocks, T0 - 100);
  await Promise.all(c.nodes.map((x) => x.node.observe(tick)));
  await c.hub.settle();
  // No maybePropose call at all: finalized from observations alone.
  assert.ok(c.nodes.every((x) => x.store.finalizedAt(tick)), "every publisher finalized locally");
  assert.equal(new Set(c.nodes.map((x) => headerOf(x.store.finalizedAt(tick)))).size, 1);
});

test("backup re-proposes: a primary that crashes after one signature does not lose the tick", async () => {
  const c = makeCommittee(4);
  await c.runTick(T0);
  await c.runTick(T0 + 1000);
  const tick = T0 + 2000;
  const t = BigInt(tick);
  const [primary] = c.nodes[0].node.leaders(t);
  const others = [0, 1, 2, 3].filter((i) => i !== primary);
  // Only one other publisher will see the primary's proposal.
  const [witness, ...cut] = others;
  const { emitMockQuotes, mockMarketsFor } = await import("../dist/sources/mock.js");
  const { BASE } = await import("./helpers.mjs");
  const mocks = mockMarketsFor(c.config, BASE);
  c.clock.now = tick;
  for (const x of c.nodes) emitMockQuotes(x.marketData, mocks, tick - 100);
  // Observations reach everyone except that rank 0 must not propose early: hold one observation back.
  c.hub.setDown(cut[1], true);
  await Promise.all(c.nodes.filter((_, i) => i !== cut[1]).map((x) => x.node.observe(t)));
  await c.hub.settle();
  c.hub.setDown(cut[1], false);
  await c.nodes[cut[1]].node.observe(t);
  c.hub.setDown(cut[0], true);
  c.hub.setDown(cut[1], true);
  c.clock.now = tick + 100;
  await c.nodes[primary].node.maybePropose(t); // the witness signs; the primary signs; only 2 of 3
  await c.hub.settle();
  const primaryHeader = [...c.nodes[witness].node["ticks"].get(t).derived.keys()][0];
  assert.ok(primaryHeader, "the witness derived the primary's header");
  assert.ok(!c.nodes.some((x) => x.store.finalizedAt(t)), "not finalized with 2 signatures");
  // The primary crashes; the others come back; the backup's slot opens.
  c.hub.setDown(primary, true);
  c.hub.setDown(cut[0], false);
  c.hub.setDown(cut[1], false);
  c.clock.now = tick + c.config.observationDeadlineMs;
  for (let call = 0; call < 2; call++) {
    await Promise.all(others.map((i) => c.nodes[i].node.maybePropose(t)));
    await c.hub.settle();
  }
  const finals = others.map((i) => c.nodes[i].store.finalizedAt(t));
  assert.ok(finals.every(Boolean), "the backup finalized the tick");
  assert.ok(finals.every((b) => headerOf(b) === primaryHeader), "with the primary's header");
});

test("wire frames round-trip", () => {
  const signed = pub.signObservation(
    { publisherSetTypeHash: SET_TYPE_HASH, setIndex: 0, tickMs: 5n, configHash: `0x${"cf".repeat(32)}`, publisherIndex: 1, entries: [{ feedId: BTC, price: 7n, conf: 1n, sourceTimeMs: 4n }] },
    `0x${"11".repeat(32)}`,
  );
  const messages = [
    { type: "observation", signed },
    { type: "proposal", rank: 1, proposer: 2, body: { tickMs: 5n, anchorTickMs: 3n, anchorHash: `0x${"aa".repeat(32)}`, prevTickMs: 4n, chosen: [{ index: 0, hash: `0x${"bb".repeat(32)}` }, { index: 2, hash: `0x${"cc".repeat(32)}` }] }, signature: `0x${"ab".repeat(65)}` },
    { type: "tick_request", tickMs: 5n },
    { type: "signature", tickMs: 5n, headerHash: `0x${"dd".repeat(32)}`, signature: `0x${"ee".repeat(65)}` },
    { type: "obs_request", tickMs: 5n, indexes: [0, 3] },
    { type: "sync_request", afterTickMs: 9n },
    { type: "sync_response", blobs: [Uint8Array.of(1, 2, 3), Uint8Array.of()] },
  ];
  for (const m of messages) assert.deepEqual(decodeMessage(encodeMessage(m)), m);
  assert.throws(() => decodeMessage(Uint8Array.of(99)));
  assert.throws(() => decodeMessage(new Uint8Array([...encodeMessage(messages[4]), 0])));
});

test("websocket transport authenticates peers and rejects impostors", async () => {
  const keys = [`0x${"21".repeat(32)}`, `0x${"22".repeat(32)}`, `0x${"23".repeat(32)}`];
  const ordered = keys.map((k) => ({ k, pk: pub.publicKeyOf(k) })).sort((a, b) => (a.pk < b.pk ? -1 : 1));
  const set = { setIndex: 0, pubkeys: ordered.map((o) => o.pk) };
  const port = 17990;
  const server = new WsTransport({ selfIndex: 0, signer: memorySigner(ordered[0].k), set, host: "127.0.0.1", port, peers: new Map() });
  const client = new WsTransport({ selfIndex: 1, signer: memorySigner(ordered[1].k), set, host: "127.0.0.1", port: port + 1, peers: new Map([[0, `ws://127.0.0.1:${port}`]]) });
  const received = [];
  server.onFrame((from, frame) => received.push({ from, frame: [...frame] }));
  for (let i = 0; i < 50 && client.connectedPeers().length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  client.send(0, Uint8Array.of(9, 9));
  // An impostor claims index 2 but signs with a key outside the set.
  const impostor = new WebSocket(`ws://127.0.0.1:${port}`);
  const closed = new Promise((resolve) => impostor.on("close", resolve));
  impostor.once("message", async (challenge) => {
    const { answerHello } = await import("../dist/wire.js");
    impostor.send(await answerHello(new Uint8Array(challenge), set.pubkeys[0], 2, memorySigner(`0x${"99".repeat(32)}`)));
    impostor.send(Uint8Array.of(7));
  });
  await closed;
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(received, [{ from: 1, frame: [9, 9] }]);
  await client.close();
  await server.close();
});

function feedMethod(overrides = {}) {
  return { method: "mid", windowMs: 1000, maxQuoteAgeMs: 2000, maxSpreadBps: 50, minVenues: 2, ...overrides };
}

test("measurement: a quiet book on a live connection still counts; a dead connection does not", () => {
  const cfg = { ...committeeConfig(), feeds: [{ ...committeeConfig().feeds[0], ...feedMethod(), markets: [{ venue: "a", market: "X" }, { venue: "b", market: "X" }] }] };
  const data = new MarketData();
  data.quote("a", "X", { bid: parseDecimal("100"), ask: parseDecimal("100.02"), timeMs: 0 });
  data.quote("b", "X", { bid: parseDecimal("100.01"), ask: parseDecimal("100.03"), timeMs: 0 });
  data.alive("a", 9_500);
  data.alive("b", 9_500);
  assert.equal(observeFeeds(cfg, data, 10_000).length, 1, "books unchanged for 10 s but connections alive");
  data.alive("a", 9_500);
  assert.equal(observeFeeds(cfg, data, 12_000).length, 0, "both connections silent for 2.5 s");
});

test("measurement: dust filter and outlier pass", () => {
  const base = committeeConfig().feeds[0];
  const data = new MarketData();
  const q = (venue, bid, ask, size) => {
    data.quote(venue, "X", { bid: parseDecimal(bid), ask: parseDecimal(ask), timeMs: 900, ...(size ? { bidSize: parseDecimal(size), askSize: parseDecimal(size) } : {}) });
  };
  q("a", "100", "100.02", "10");
  q("b", "100.01", "100.03", "10");
  q("c", "100.02", "100.04", "0.001"); // dust: $0.10 per side
  q("d", "130", "130.02", "10"); // outlier
  const markets = ["a", "b", "c", "d"].map((venue) => ({ venue, market: "X" }));
  const cfg = (extra) => ({ ...committeeConfig(), feeds: [{ ...base, expo: -2, ...feedMethod(extra), markets }] });
  const price = (extra) => observeFeeds(cfg(extra), data, 1000)[0]?.price;
  assert.equal(price({}), 10_003n, "median of 4 = midpoint of the two middle venues");
  assert.equal(price({ minTopNotional: 50, maxDeviationBps: 100 }), 10_002n, "dust and outlier removed → median of a, b");
  assert.equal(price({ minTopNotional: 50, maxDeviationBps: 100, minVenues: 3 }), undefined, "too few venues left");

});

test("measurement: each feed uses only its own pair's markets, with no conversion", () => {
  const cfg = committeeConfig();
  const data = new MarketData();
  const book = (venue, market, mid) => data.quote(venue, market, { bid: parseDecimal(mid), ask: parseDecimal(mid) + parseDecimal("0.01"), timeMs: 900 });
  for (const [venue, market] of [["coinbase", "BTC-USD"], ["kraken", "BTC/USD"], ["bitstamp", "btcusd"]]) book(venue, market, "60000");
  for (const [venue, market] of [["binance", "BTCUSDT"], ["okx", "BTC-USDT"], ["bybit", "BTCUSDT"]]) book(venue, market, "60300");
  const bySymbol = Object.fromEntries(observeFeeds(cfg, data, 1000).map((e) => [cfg.feeds.find((f) => f.feedId === e.feedId).symbol, e.price]));
  assert.equal(bySymbol["Crypto.BTC/USD"], 6_000_000_500_000n);
  assert.equal(bySymbol["Crypto.BTC/USDT"], 6_030_000_500_000n, "USDT markets priced in USDT, untouched by USD books");
  assert.equal(bySymbol["Crypto.USDT/USD"], undefined, "no USDT/USD markets → no feed, and nothing else depends on it");
});
