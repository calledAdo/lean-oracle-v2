// End-to-end: an in-process committee finalizes updates that the SDK (and so the contract) accepts.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as p from "lean-oracle-sdk/protocol";

import { makeCommittee, SET_TYPE_HASH, T0 } from "./helpers.mjs";

const BTC = p.feedId("Crypto.BTC/USD");

function finalized(committee, tickMs) {
  return committee.nodes.map((x) => x.store.finalizedAt(BigInt(tickMs)));
}

/** The update everyone agreed on is the header; each publisher may hold a different quorum of signatures. */
const headerOf = (blob) => blob && p.priceUpdateSigningHash(p.decodePriceUpdate(blob).header);

test("4-of-4 committee finalizes verifiable, identical updates every tick", async () => {
  const c = makeCommittee(4, { skews: [0, 3, -3, 6] });
  for (let k = 0; k < 5; k++) await c.runTick(T0 + k * 1000);
  for (let k = 0; k < 5; k++) {
    const blobs = finalized(c, T0 + k * 1000);
    assert.ok(blobs.every((b) => b && headerOf(b) === headerOf(blobs[0])), `tick ${k} differs or missing`);
    for (const b of blobs) p.verifyPriceUpdate(b, BTC, SET_TYPE_HASH, c.publisherSet);
    const verified = p.verifyPriceUpdate(blobs[0], BTC, SET_TYPE_HASH, c.publisherSet);
    assert.equal(verified.header.publishTimeMs, BigInt(T0 + k * 1000));
    assert.equal(verified.message.numPublishers, 4);
    assert.equal(verified.message.prevPublishTimeMs, k === 0 ? 0n : BigInt(T0 + (k - 1) * 1000));
    assert.ok(verified.message.price > 6_490_000_000_000n && verified.message.price < 6_510_000_000_000n);
  }
  const update = p.decodePriceUpdate(finalized(c, T0 + 4000)[0]);
  assert.equal(update.entries.length, 3);
  assert.equal(update.signatures.length, 3);
});

test("a down primary is replaced by the backup in the same tick", async () => {
  const c = makeCommittee(4);
  await c.runTick(T0);
  await c.runTick(T0 + 1000);
  const tick = T0 + 2000;
  const [primary, backup] = c.nodes[0].node.leaders(BigInt(tick));
  assert.notEqual(primary, backup);
  await c.runTick(tick, { down: [primary] });
  const blob = finalized(c, tick).find((b) => b);
  assert.ok(blob, "the backup finalized the tick");
  const verified = p.verifyPriceUpdate(blob, BTC, SET_TYPE_HASH, c.publisherSet);
  assert.equal(verified.message.numPublishers, 3);
  assert.equal(verified.message.prevPublishTimeMs, BigInt(T0 + 1000));
  assert.ok(!c.events.some((e) => e.event === "finalized" && e.index === primary && e.tickMs === String(tick)));
});

test("a lagging publisher catches up through sync and signs again", async () => {
  const c = makeCommittee(4);
  for (let k = 0; k < 3; k++) await c.runTick(T0 + k * 1000, { down: [2] });
  assert.equal(c.nodes[2].store.latestFinalizedTick(), undefined);
  const expected = c.nodes[0].store.latestFinalizedTick();
  assert.ok(expected !== undefined);
  c.hub.setDown(2, false);
  c.nodes[2].node.requestSync();
  await c.hub.settle();
  assert.equal(c.nodes[2].store.latestFinalizedTick(), expected);
  await c.runTick(T0 + 3000);
  const verified = p.verifyPriceUpdate(finalized(c, T0 + 3000)[0], BTC, SET_TYPE_HASH, c.publisherSet);
  assert.equal(verified.message.numPublishers, 4);
  assert.equal(new Set(finalized(c, T0 + 3000).map(headerOf)).size, 1);
});

test("a publisher whose data is far off refuses to sign; the rest still finalize", async () => {
  const c = makeCommittee(4, { skews: [0, 0, 0, 300] });
  await c.runTick(T0);
  assert.ok(c.events.some((e) => e.index === 3 && e.event === "sign.reject" && e.reason === "outside tolerance"));
  const verified = p.verifyPriceUpdate(finalized(c, T0)[0], BTC, SET_TYPE_HASH, c.publisherSet);
  assert.ok(!p.decodePriceUpdate(finalized(c, T0)[0]).signatures.some((s) => s.publisherIndex === 3));
  assert.ok(verified.message.price < 6_505_000_000_000n, "the outlier cannot move the median far");
});

test("the double-sign guard refuses a second header for the same tick", async () => {
  const c = makeCommittee(4);
  await c.runTick(T0);
  const store = c.nodes[1].store;
  assert.equal(store.reserveSignature(BigInt(T0), `0x${"01".repeat(32)}`), false);
  assert.equal(store.reserveSignature(BigInt(T0 + 5000), `0x${"01".repeat(32)}`), true);
  assert.equal(store.reserveSignature(BigInt(T0 + 5000), `0x${"01".repeat(32)}`), true);
  assert.equal(store.reserveSignature(BigInt(T0 + 5000), `0x${"02".repeat(32)}`), false);
});

test("a one-publisher committee works", async () => {
  const c = makeCommittee(1);
  await c.runTick(T0);
  assert.ok(p.verifyPriceUpdate(finalized(c, T0)[0], BTC, SET_TYPE_HASH, c.publisherSet));
});
