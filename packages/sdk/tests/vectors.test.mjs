// Asserts the SDK reproduces vectors/protocol.json (generated from the Rust codecs) byte for byte.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import * as p from "lean-oracle-sdk/protocol";
import * as pub from "lean-oracle-sdk/publisher";

const v = JSON.parse(readFileSync(new URL("../../../vectors/protocol.json", import.meta.url), "utf8"));
const hex = (bytes) => p.bytesToHex(bytes);

const committee = {
  networkId: v.committee.networkId,
  governanceNonce: BigInt(v.committee.governanceNonce),
  governanceFlags: v.committee.governanceFlags,
  minRotationIntervalS: BigInt(v.committee.minRotationIntervalS),
  current: { setIndex: v.committee.setIndex, pubkeys: v.committee.pubkeys },
};
const committeeHash = v.rotation.committeeTypeHash;
const message = (m) => ({
  feedId: m.feedId,
  price: BigInt(m.price),
  conf: BigInt(m.conf),
  expo: m.expo,
  prevPublishTimeMs: BigInt(m.prevPublishTimeMs),
  emaPrice: BigInt(m.emaPrice),
  emaConf: BigInt(m.emaConf),
  sourceTimeMs: BigInt(m.sourceTimeMs),
  numPublishers: m.numPublishers,
});

test("feed ids and Type ID seed", () => {
  for (const { symbol, feedId } of v.feedIds) assert.equal(p.feedId(symbol), feedId);
  assert.equal(p.typeIdSeed(v.typeId.firstInput, v.typeId.outputIndex), v.typeId.typeId);
});

test("committee cell codec, hashes and keys", () => {
  assert.equal(hex(p.encodePublisherSetData(committee)), v.committee.bytes);
  assert.deepEqual(p.decodePublisherSetData(v.committee.bytes), committee);
  assert.equal(p.publisherSetStateHash(committee), v.committee.stateHash);
  assert.equal(p.quorum(committee.current), v.committee.quorum);
  assert.deepEqual(v.committee.privateKeys.map(pub.publicKeyOf), v.committee.pubkeys);
});

test("rotation authorization and proof of possession match Rust signatures", () => {
  const next = p.decodePublisherSetData(v.rotation.nextBytes);
  assert.equal(next.previous.untilMs, BigInt(v.rotation.previousUntilMs));
  assert.equal(p.transitionError(committee, next, p.OP_ROTATE), undefined);
  assert.equal(p.publisherSetUpdateHash(committee, next, p.OP_ROTATE, committeeHash), v.rotation.updateHash);
  assert.equal(p.publisherSetPopHash(next, committeeHash), v.rotation.popHash);
  const auth = v.update.signers.map((i) => pub.signGovernance(committee, next, p.OP_ROTATE, committeeHash, v.committee.privateKeys[i], i));
  assert.equal(hex(p.encodeSignatureBundle(auth)), v.rotation.authorizationBundle);
  assert.ok(p.verifyThreshold(auth, v.rotation.updateHash, committee.current));
  const pop = v.rotation.nextPrivateKeys.map((key, i) => pub.signProofOfPossession(next, committeeHash, key, i));
  assert.equal(hex(p.encodeSignatureBundle(pop)), v.rotation.popBundle);
  assert.ok(p.verifyAll(pop, v.rotation.popHash, next.current));
});

test("every governance operation: next state, transition rules and digest match Rust", () => {
  const rotated = p.decodePublisherSetData(v.rotation.nextBytes);
  const paused = p.decodePublisherSetData(v.governance.pause.nextBytes);
  const cases = [
    [committee, v.governance.rotateRevoke, p.OP_ROTATE_REVOKE],
    [committee, v.governance.pause, p.OP_PAUSE],
    [paused, v.governance.unpause, p.OP_UNPAUSE],
    [rotated, v.governance.revokePrevious, p.OP_REVOKE_PREVIOUS],
  ];
  for (const [from, g, op] of cases) {
    const next = p.decodePublisherSetData(g.nextBytes);
    assert.equal(hex(p.encodePublisherSetData(next)), g.nextBytes);
    assert.equal(p.transitionError(from, next, op), undefined, `op ${op}`);
    assert.equal(p.publisherSetUpdateHash(from, next, op, committeeHash), g.updateHash);
  }
  // Digests are bound to the committee: another cell gets another digest.
  assert.notEqual(p.publisherSetUpdateHash(committee, paused, p.OP_PAUSE, `0x${"55".repeat(32)}`), v.governance.pause.updateHash);
  // Wrong operation for a state change is refused.
  assert.ok(p.transitionError(committee, paused, p.OP_UNPAUSE));
  assert.ok(p.transitionError(committee, rotated, p.OP_ROTATE_REVOKE));
  assert.ok(p.needsProofOfPossession(p.OP_ROTATE_REVOKE) && !p.needsProofOfPossession(p.OP_PAUSE));
  assert.ok(p.needsRotationInterval(p.OP_ROTATE) && !p.needsRotationInterval(p.OP_ROTATE_REVOKE));
});

test("price update: messages, Merkle, header, signatures and blob", () => {
  const messages = v.update.messages.map(message);
  messages.forEach((m, i) => {
    assert.equal(hex(p.encodePriceMessage(m)), v.update.messages[i].bytes);
    assert.equal(p.leafHash(p.encodePriceMessage(m)), v.update.messages[i].leafHash);
  });
  const { header, entries } = p.assemblePriceUpdate({
    publisherSetTypeHash: v.update.publisherSetTypeHash,
    setIndex: v.update.setIndex,
    publishTimeMs: BigInt(v.update.publishTimeMs),
    tickPeriodMs: v.update.tickPeriodMs,
    configHash: v.update.configHash,
    messages: [...messages].reverse(),
  });
  assert.equal(header.merkleRoot, v.update.merkleRoot);
  assert.deepEqual(entries.map((e) => e.proof), v.update.proofs);
  assert.equal(hex(p.encodePriceUpdateHeader(header)), v.update.headerBytes);
  assert.equal(p.priceUpdateSigningHash(header), v.update.signingHash);

  const signatures = pub.toSignatureBundle(
    v.update.signers.map((i) => pub.signPriceUpdateHeader(header, v.committee.privateKeys[i], i)).reverse(),
  );
  assert.equal(hex(p.encodeSignatureBundle(signatures)), v.update.signatureBundle);
  const update = { header, signatures, entries };
  assert.equal(hex(p.encodePriceUpdate(update)), v.update.blob);
  assert.deepEqual(p.decodePriceUpdate(v.update.blob), update);
  const btc = p.feedId("Crypto.BTC/USD");
  assert.equal(hex(p.encodePriceUpdate(p.selectFeeds(update, [btc]))), v.update.btcOnlyBlob);
});

test("verification and feed cell data", () => {
  const btc = p.feedId("Crypto.BTC/USD");
  for (const m of v.update.messages) {
    assert.equal(p.verifyPriceUpdate(v.update.blob, m.feedId, v.update.publisherSetTypeHash, committee).message.feedId, m.feedId);
  }
  const verified = p.verifyPriceUpdate(v.update.btcOnlyBlob, btc, v.update.publisherSetTypeHash, committee);
  const empty = p.uninitializedPriceFeed(btc, v.update.publisherSetTypeHash);
  assert.equal(hex(p.encodePriceFeedData(empty)), v.feedCell.uninitialized);
  assert.equal(p.isInitialized(empty), false);
  const after = p.applyVerifiedPrice(empty, verified);
  assert.equal(hex(p.encodePriceFeedData(after)), v.feedCell.afterBtcUpdate);
  assert.deepEqual(p.decodePriceFeedData(v.feedCell.afterBtcUpdate), after);
});
