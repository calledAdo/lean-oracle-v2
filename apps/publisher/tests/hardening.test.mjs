// Config-version switching, KMS signing, and the KuCoin/MEXC sources.
import assert from "node:assert/strict";
import { test } from "node:test";

import { secp256k1 } from "@noble/curves/secp256k1";
import * as p from "lean-oracle-sdk/protocol";
import * as pub from "lean-oracle-sdk/publisher";

import { ConfigSchedule } from "../dist/configSchedule.js";
import { parseDecimal } from "../dist/fixed.js";
import { AwsKmsSigner } from "../dist/keySigner.js";
import { MarketData } from "../dist/marketData.js";
import { TickScheduler } from "../dist/scheduler.js";
import { mexc, RestPoller } from "../dist/sources/rest.js";
import { VENUES } from "../dist/sources/venues.js";
import { approve, committeeConfig, makeCommittee, SET_TYPE_HASH, T0 } from "./helpers.mjs";

const BTC = p.feedId("Crypto.BTC/USD");

function version2(activationTickMs) {
  const v1 = committeeConfig();
  return { ...v1, version: 2, activationTickMs: String(activationTickMs), feeds: v1.feeds.map((f) => ({ ...f, toleranceBps: 40 })) };
}

test("a committee switches config version exactly at its activation tick", async () => {
  const v2 = version2(T0 + 3000);
  const c = makeCommittee(4, { configs: [v2] });
  for (let k = 0; k < 6; k++) await c.runTick(T0 + k * 1000);
  const v2Hash = p.committeeConfigHash(v2);
  for (let k = 0; k < 6; k++) {
    const blob = c.nodes[0].store.finalizedAt(BigInt(T0 + k * 1000));
    if (!blob) continue;
    const header = p.decodePriceUpdate(blob).header;
    assert.equal(header.configHash, k < 3 ? c.configHash : v2Hash, `tick ${k}`);
  }
  assert.ok(c.nodes[0].store.finalizedAt(BigInt(T0 + 3000)) || c.nodes[0].store.finalizedAt(BigInt(T0 + 4000)), "finalizes under v2");
});

test("config schedule rejects unapproved, out-of-order and conflicting versions", () => {
  const c = makeCommittee(4);
  const schedule = new ConfigSchedule(SET_TYPE_HASH, c.publisherSet.current);
  schedule.add(approve(c.config, c.keysInOrder));
  assert.throws(() => schedule.add({ config: version2(T0 + 5000), signatures: approve(version2(T0 + 5000), c.keysInOrder).signatures.slice(0, 2) }), /quorum/);
  assert.throws(() => schedule.add(approve({ ...version2(T0 + 5000), version: 1 }, c.keysInOrder)), /conflicting/);
  assert.throws(() => schedule.add(approve(version2(T0 - 1000), c.keysInOrder)), /follow/);
  schedule.add(approve(version2(T0 + 5000), c.keysInOrder));
  assert.equal(schedule.at(BigInt(T0 + 4999)).config.version, 1);
  assert.equal(schedule.at(BigInt(T0 + 5000)).config.version, 2);
  assert.equal(schedule.at(BigInt(T0 - 1)), undefined);
  // The scheduler lands exactly on an activation tick.
  const scheduler = new TickScheduler({}, schedule);
  assert.equal(scheduler.nextTick(T0 + 4200), BigInt(T0 + 5000));
});

test("AWS KMS signer: public key from SPKI, DER signatures made recoverable", async () => {
  const key = `0x${"42".repeat(32)}`;
  const uncompressed = secp256k1.getPublicKey(p.hexToBytes(key), false);
  const spki = new Uint8Array([0x30, 0x56, 0x30, 0x10, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a, 0x03, 0x42, 0x00, ...uncompressed]);
  const fakeKms = {
    async send(command) {
      const input = command.input;
      if (!input.Message) return { PublicKey: spki };
      assert.equal(input.MessageType, "DIGEST");
      const sig = secp256k1.sign(input.Message, p.hexToBytes(key), { lowS: false });
      return { Signature: new secp256k1.Signature(sig.r, secp256k1.CURVE.n - sig.s).toDERRawBytes() };
    },
  };
  const signer = await AwsKmsSigner.create("alias/test", "us-east-1", fakeKms);
  assert.equal(signer.publicKey, pub.publicKeyOf(key));
  const digest = p.feedId("digest");
  assert.equal(await signer.sign(digest), pub.signDigest(digest, key));
});

test("KuCoin messages", () => {
  const quote = VENUES.kucoin.parse({ type: "message", topic: "/market/ticker:CKB-USDT", subject: "trade.ticker", data: { bestBid: "0.00127", bestAsk: "0.001272", bestBidSize: "1000", bestAskSize: "900" } });
  assert.deepEqual(quote, [{ kind: "quote", market: "CKB-USDT", bid: "0.00127", ask: "0.001272", bidSize: "1000", askSize: "900" }]);
  const trade = VENUES.kucoin.parse({ type: "message", topic: "/market/match:CKB-USDT", subject: "trade.l3match", data: { symbol: "CKB-USDT", price: "0.001271", size: "5000" } });
  assert.equal(trade[0].kind, "trade");
  assert.deepEqual(VENUES.kucoin.parse({ type: "welcome" }), []);
});

test("MEXC REST poller: quotes every poll, each trade exactly once", async () => {
  let trades = [{ price: "0.001270", qty: "100", time: 1000 }];
  const fetchFn = async (url) => ({
    ok: true,
    json: async () => (url.includes("bookTicker") ? { bidPrice: "0.001270", askPrice: "0.001272" } : trades),
  });
  const data = new MarketData();
  let now = 5000;
  const poller = new RestPoller(mexc, ["CKBUSDT"], data, undefined, fetchFn, () => now);
  await poller.poll(); // first poll sets the trade cursor without backfilling
  assert.equal(data.tradesIn("mexc", "CKBUSDT", 0, now).length, 0);
  assert.deepEqual(data.latestQuote("mexc", "CKBUSDT", now), { bid: parseDecimal("0.00127"), ask: parseDecimal("0.001272"), timeMs: 5000 });
  trades = [{ price: "0.001271", qty: "50", time: 2000 }, { price: "0.001270", qty: "100", time: 1000 }];
  now = 6000;
  await poller.poll();
  await poller.poll();
  assert.equal(data.tradesIn("mexc", "CKBUSDT", 0, now).length, 1);
});

test("MEXC REST poller backs off a market the venue refuses", async () => {
  let calls = 0;
  let status = 403;
  const fetchFn = async () => { calls++; return { ok: status === 200, status, json: async () => ({ bidPrice: "1", askPrice: "1.01" }) }; };
  let now = 0;
  const poller = new RestPoller(mexc, ["BTCUSDT"], new MarketData(), undefined, fetchFn, () => now);
  await poller.poll();
  const refused = calls;
  now = 29_000;
  await poller.poll();
  assert.equal(calls, refused, "no requests during the back-off");
  status = 200;
  now = 31_000;
  await poller.poll();
  assert.ok(calls > refused, "polling resumes after the back-off");
});

test("single-key committee still finalizes through the async signer", async () => {
  const c = makeCommittee(1);
  await c.runTick(T0);
  assert.ok(p.verifyPriceUpdate(c.nodes[0].store.finalizedAt(BigInt(T0)), BTC, SET_TYPE_HASH, c.publisherSet));
});
