// Mirror against real publisher nodes and their HTTP/stream API (in-memory committee from the
// publisher's test helpers), plus hostile sources: tampered blobs and an equivocating quorum.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MirrorClient } from "lean-oracle-sdk/mirror";
import * as p from "lean-oracle-sdk/protocol";
import * as pub from "lean-oracle-sdk/publisher";

import { startApi as startPublisherApi } from "../../publisher/dist/api.js";
import { makeCommittee, SET_TYPE_HASH, T0 } from "../../publisher/tests/helpers.mjs";
import { startMirror } from "../dist/mirror.js";

const BTC_USD = "Crypto.BTC/USD";
const BTC_USDT = "Crypto.BTC/USDT";
const waitFor = async (check, what, ms = 5000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
};
const listening = (server) => new Promise((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
const base = (server) => `http://127.0.0.1:${server.address().port}`;

async function setup({ rateLimit, extraSources = [] } = {}) {
  const c = makeCommittee(4);
  for (let i = 0; i < 3; i++) await c.runTick(T0 + i * 1000);
  const apis = [0, 1].map((i) => startPublisherApi("127.0.0.1", 0, c.nodes[i].store, () => ({})));
  await Promise.all(apis.map(listening));
  const dir = mkdtempSync(join(tmpdir(), "mirror-"));
  const setFile = join(dir, "set.hex");
  writeFileSync(setFile, p.bytesToHex(p.encodePublisherSetData(c.publisherSet)));
  const mirror = await startMirror({
    http: { host: "127.0.0.1", port: 0 },
    dataPath: join(dir, "mirror.db"),
    committees: [{ name: "majors", publisherSetTypeHash: SET_TYPE_HASH, publisherSetFile: setFile, publishers: [...apis.map(base), ...extraSources] }],
    rateLimit,
  });
  const url = base(mirror.server);
  const client = new MirrorClient({ urls: url, committees: { [SET_TYPE_HASH]: c.publisherSet } });
  const stop = async () => {
    await mirror.stop();
    await Promise.all(apis.map((a) => new Promise((r) => a.close(r))));
  };
  return { c, mirror, url, client, stop };
}

test("backfills history, follows the live stream, and serves verified queries", async () => {
  const { c, mirror, url, client, stop } = await setup();
  try {
    await waitFor(() => mirror.store.latestTick(SET_TYPE_HASH) === BigInt(T0 + 2000), "backfill");

    const streamed = [];
    const stream = client.stream([BTC_USDT], (u) => streamed.push(u));
    await new Promise((r) => setTimeout(r, 200));
    for (let i = 3; i < 5; i++) await c.runTick(T0 + i * 1000);
    await waitFor(() => streamed.length === 2, "two streamed updates");
    stream.close();
    assert.deepEqual(streamed.map((u) => u.publishTimeMs), [BigInt(T0 + 3000), BigInt(T0 + 4000)]);
    assert.deepEqual(streamed[0].prices.map((x) => x.feedId), [p.feedId(BTC_USDT)], "stream carries only subscribed feeds");

    const [latest] = await client.latest([BTC_USD, BTC_USDT]);
    assert.equal(latest.publishTimeMs, BigInt(T0 + 4000));
    assert.equal(latest.prices.length, 2, "both feeds in one update blob");
    assert.equal(p.decodePriceUpdate(latest.blob).entries.length, 2);
    p.verifyPriceUpdate(latest.blob, p.feedId(BTC_USD), SET_TYPE_HASH, c.publisherSet);

    const [at] = await client.at(T0 + 1500, [BTC_USD]);
    assert.equal(at.publishTimeMs, BigInt(T0 + 2000), "first update at or after t");
    const exact = await fetch(`${url}/v1/updates/at?t=${T0 + 2000}&ids=${encodeURIComponent(BTC_USD)}`);
    assert.match(exact.headers.get("cache-control"), /immutable/, "exact-tick answers are cacheable forever");

    const range = await client.range(BTC_USD, T0, T0 + 4000);
    assert.deepEqual(range.map((x) => x.publishTimeMs), [0, 1, 2, 3, 4].map((i) => BigInt(T0 + i * 1000)));

    const missing = await (await fetch(`${url}/v1/updates/latest?ids=Crypto.NOPE/USD`)).json();
    assert.deepEqual(missing, { updates: [], missing: [p.feedId("Crypto.NOPE/USD")] });
    assert.equal((await fetch(`${url}/v1/updates/at?t=abc&ids=${encodeURIComponent(BTC_USD)}`)).status, 400);
    const health = await (await fetch(`${url}/health`)).json();
    assert.equal(health.committees[0].latestTickMs, String(T0 + 4000));
  } finally {
    await stop();
  }
});

test("rejects tampered updates and records an equivocating quorum as evidence", async () => {
  const c0 = makeCommittee(4);
  await c0.runTick(T0);
  const honest = p.decodePriceUpdate(c0.nodes[0].store.finalizedAt(BigInt(T0)));
  // A quorum signing a second, different header for the same tick.
  const messages = honest.entries.map((e) => ({ ...e.message, price: e.message.price + 1n }));
  const { header, entries } = p.assemblePriceUpdate({ ...honest.header, messages });
  const signatures = pub.toSignatureBundle([0, 1, 2].map((i) => pub.signPriceUpdateHeader(header, c0.keysInOrder[i], i)));
  const conflicting = p.bytesToHex(p.encodePriceUpdate({ header, signatures, entries }));
  const tampered = p.bytesToHex(p.encodePriceUpdate({ ...honest, entries: honest.entries.map((e) => ({ ...e, message: { ...e.message, price: 1n } })) }));

  const hostile = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ blobs: req.url.includes("after=0") ? [tampered, conflicting] : [] }));
  });
  hostile.listen(0, "127.0.0.1");
  await listening(hostile);
  // Same keys as makeCommittee, so the hostile source's quorum signatures are valid.
  const { mirror, url, stop } = await setup({ extraSources: [base(hostile)] });
  try {
    await waitFor(() => mirror.store.equivocations(10).length === 2, "equivocation evidence");
    const [evidence] = [(await (await fetch(`${url}/v1/equivocations`)).json()).equivocations];
    assert.equal(evidence.length, 2);
    assert.ok(evidence.every((e) => e.tickMs === String(T0)));
    const canonical = mirror.store.atOrAfter(p.feedId(BTC_USD), BigInt(T0));
    assert.equal(p.priceUpdateSigningHash(p.decodePriceUpdate(canonical.blob).header), evidence.find((e) => e.receivedMs === Math.min(...evidence.map((x) => x.receivedMs))).headerHash);
    assert.ok(!mirror.store.range(p.feedId(BTC_USD), 0n, BigInt(T0 + 10_000), 100).some((s) => p.decodePriceUpdate(s.blob).entries[0].message.price === 1n), "tampered blob never stored");
  } finally {
    await stop();
    hostile.close();
  }
});

test("rate limits per IP and per API key", async () => {
  const rateLimit = { anonymous: { rps: 1, burst: 2, maxStreams: 1 }, keys: { "k-1": { rps: 100, burst: 100, maxStreams: 5 } } };
  const { url, stop } = await setup({ rateLimit });
  try {
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await fetch(`${url}/v1/feeds`)).status);
    assert.deepEqual(statuses, [200, 200, 429]);
    const limited = await fetch(`${url}/v1/feeds`);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    assert.equal((await fetch(`${url}/v1/feeds`, { headers: { "x-api-key": "k-1" } })).status, 200, "a key has its own budget");
    assert.equal((await fetch(`${url}/v1/feeds`, { headers: { "x-api-key": "nope" } })).status, 401);
    assert.equal((await fetch(`${url}/health`)).status, 200, "health is never limited");
  } finally {
    await stop();
  }
});

test("a rotated-out set can only vouch for ticks before its retirement", async () => {
  const { Committee } = await import("../dist/committee.js");
  const c = makeCommittee(4);
  await c.runTick(T0);
  const blob = c.nodes[0].store.finalizedAt(BigInt(T0));
  const next = { ...c.publisherSet, current: { setIndex: 1, pubkeys: c.publisherSet.current.pubkeys } };
  for (const [retiredAt, accepted] of [[T0 + 1, true], [T0, false]]) {
    const committee = new Committee({ name: "majors", publisherSetTypeHash: SET_TYPE_HASH, publishers: [] }, undefined, () => retiredAt);
    committee.observe(c.publisherSet);
    committee.observe(next);
    if (accepted) committee.verify(blob);
    else assert.throws(() => committee.verify(blob), /retired set/);
  }
});
