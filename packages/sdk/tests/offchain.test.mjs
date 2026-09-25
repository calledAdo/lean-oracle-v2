// Observation and committee-config formats (off-chain, TypeScript only).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import * as p from "lean-oracle-sdk/protocol";
import * as pub from "lean-oracle-sdk/publisher";

const v = JSON.parse(readFileSync(new URL("../../../vectors/protocol.json", import.meta.url), "utf8"));
const set = p.decodePublisherSetData(v.committee.bytes).current;
const keys = v.committee.privateKeys;
const ids = ["Crypto.BTC/USD", "Crypto.ETH/USD"].map(p.feedId).sort();

const observation = (publisherIndex) => ({
  publisherSetTypeHash: v.update.publisherSetTypeHash,
  setIndex: set.setIndex,
  tickMs: 1_700_000_400_000n,
  configHash: `0x${"cf".repeat(32)}`,
  publisherIndex,
  entries: ids.map((feedId, i) => ({ feedId, price: 100n + BigInt(i), conf: 5n, sourceTimeMs: 1_700_000_399_900n })),
});

test("observation round trip, signature and strictness", () => {
  const signed = pub.signObservation(observation(1), keys[1]);
  const wire = p.encodeSignedObservation(signed);
  assert.equal(wire.length, p.OBSERVATION_HEADER_LEN + 2 * p.OBSERVATION_ENTRY_LEN + 65);
  assert.deepEqual(p.decodeSignedObservation(wire), signed);
  assert.ok(p.verifyObservation(signed, set));
  assert.equal(p.verifyObservation({ ...signed, observation: { ...signed.observation, publisherIndex: 2 } }, set), false);
  assert.equal(p.verifyObservation(pub.signObservation(observation(1), keys[2]), set), false);
  const unsorted = { ...observation(0), entries: [...observation(0).entries].reverse() };
  assert.throws(() => p.encodeObservation(unsorted), RangeError);
  assert.throws(() => p.decodeObservation(p.encodeObservation(observation(0)).slice(0, -1)), p.DecodeError);
});

const config = () => ({
  version: 1,
  committee: "majors",
  publisherSetTypeHash: v.update.publisherSetTypeHash,
  activationTickMs: "1700000000000",
  tickPeriodMs: 1000,
  observationDeadlineMs: 400,
  maxSigningLagMs: 3000,
  feeds: ["Crypto.BTC/USD", "Crypto.ETH/USD"]
    .map((symbol) => ({ symbol, quote: "USD", feedId: p.feedId(symbol), expo: -8, toleranceBps: 50, emaHalfLifeMs: 3_600_000, method: "mid",
      windowMs: 2000, maxQuoteAgeMs: 2000, maxSpreadBps: 50, minVenues: 2, markets: [
        { venue: "coinbase", market: "BTC-USD" },
        { venue: "kraken", market: "BTC/USD" },
        { venue: "bitstamp", market: "btcusd" },
      ] }))
    .sort((a, b) => (a.feedId < b.feedId ? -1 : 1)),
});

test("committee config: canonical hash, validation and quorum approval", () => {
  const c = config();
  assert.deepEqual(p.validateCommitteeConfig(c), []);
  const reordered = Object.fromEntries(Object.entries(c).reverse());
  assert.equal(p.committeeConfigHash(reordered), p.committeeConfigHash(c));
  assert.notEqual(p.committeeConfigHash({ ...c, version: 2 }), p.committeeConfigHash(c));
  assert.throws(() => p.canonicalJson({ x: 1.5 }), TypeError);

  const signatures = pub.toSignatureBundle([0, 1, 2].map((i) => pub.signCommitteeConfig(c, keys[i], i)));
  assert.ok(p.verifyCommitteeConfig({ config: c, signatures }, set));
  assert.equal(p.verifyCommitteeConfig({ config: c, signatures: signatures.slice(0, 2) }, set), false);

  const broken = { ...c, feeds: [...c.feeds].reverse() };
  assert.ok(p.validateCommitteeConfig(broken).some((x) => x.includes("ascending")));
  const feed = c.feeds[0];
  const withFeed = (f) => p.validateCommitteeConfig({ ...c, feeds: [{ ...feed, ...f }, c.feeds[1]] });
  assert.ok(withFeed({ quote: "USDT" }).some((x) => x.includes("does not match the symbol")));
  assert.ok(withFeed({ minVenues: 1 }).some((x) => x.includes("at least 2")));
  assert.ok(withFeed({ minVenues: 3 }).some((x) => x.includes("minVenues + 1")));
  assert.ok(withFeed({ markets: [...feed.markets, { venue: "coinbase", market: "BTC-USDC" }] }).some((x) => x.includes("more than once")));
});

test("DER and compact signatures become recoverable low-S signatures", async () => {
  const { secp256k1 } = await import("@noble/curves/secp256k1");
  const key = keys[0];
  const pubkey = pub.publicKeyOf(key);
  const digest = p.feedId("digest");
  const sig = secp256k1.sign(p.hexToBytes(digest), p.hexToBytes(key), { lowS: false });
  const highS = new secp256k1.Signature(sig.r, secp256k1.CURVE.n - sig.s);
  for (const form of [sig.toDERRawBytes(), highS.toDERRawBytes(), highS.toCompactRawBytes()]) {
    const recoverable = pub.toRecoverableSignature(form, digest, pubkey);
    assert.equal(recoverable, pub.signDigest(digest, key));
    assert.equal(p.recoverSigner(digest, recoverable), pubkey);
  }
  assert.throws(() => pub.toRecoverableSignature(sig.toDERRawBytes(), digest, pub.publicKeyOf(keys[1])));
  const uncompressed = secp256k1.getPublicKey(p.hexToBytes(key), false);
  const spki = new Uint8Array([0x30, 0x56, 0x30, 0x10, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a, 0x03, 0x42, 0x00, ...uncompressed]);
  assert.equal(pub.compressPublicKey(spki), pubkey);
  assert.equal(pub.compressPublicKey(uncompressed), pubkey);
});
