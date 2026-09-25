// Every VerifyError reason, mirroring the Rust verifier's failure modes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import * as p from "lean-oracle-sdk/protocol";

const v = JSON.parse(readFileSync(new URL("../../../vectors/protocol.json", import.meta.url), "utf8"));
const committee = p.decodePublisherSetData(v.committee.bytes);
const setHash = v.update.publisherSetTypeHash;
const btc = p.feedId("Crypto.BTC/USD");
const reason = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof p.VerifyError, String(error));
    return error.reason;
  }
  assert.fail("expected VerifyError");
};

test("rejects every failure mode", () => {
  const update = p.decodePriceUpdate(v.update.blob);
  assert.equal(reason(() => p.verifyPriceUpdate("0x00", btc, setHash, committee)), "Malformed");
  assert.equal(reason(() => p.verifyPriceUpdate(update, p.feedId("Crypto.DOGE/USD"), setHash, committee)), "FeedNotFound");
  const btcEntry = update.entries.find((e) => e.message.feedId === btc);
  assert.equal(reason(() => p.verifyPriceUpdate({ ...update, entries: [btcEntry, btcEntry] }, btc, setHash, committee)), "DuplicateFeed");
  const forged = { ...btcEntry, message: { ...btcEntry.message, price: btcEntry.message.price + 1n } };
  assert.equal(reason(() => p.verifyPriceUpdate({ ...update, entries: [forged] }, btc, setHash, committee)), "Proof");
  assert.equal(reason(() => p.verifyPriceUpdate(update, btc, `0x${"11".repeat(32)}`, committee)), "PublisherSet");
  assert.equal(reason(() => p.verifyPriceUpdate(update, btc, setHash, { ...committee, governanceFlags: p.GOVERNANCE_PAUSED })), "Paused");
  const rotated = { ...committee, current: { ...committee.current, setIndex: committee.current.setIndex + 1 } };
  assert.equal(reason(() => p.verifyPriceUpdate(update, btc, setHash, rotated)), "SetIndex");
  assert.equal(reason(() => p.verifyPriceUpdate({ ...update, signatures: update.signatures.slice(0, 2) }, btc, setHash, committee)), "Signature");
  const retimed = { ...update, header: { ...update.header, publishTimeMs: update.header.publishTimeMs + 1000n } };
  assert.equal(reason(() => p.verifyPriceUpdate(retimed, btc, setHash, committee)), "Signature");
});

test("decoders reject trailing bytes and bad shapes", () => {
  assert.throws(() => p.decodePriceUpdate(v.update.blob + "00"), p.DecodeError);
  assert.throws(() => p.decodePublisherSetData(v.committee.bytes + "00"), p.DecodeError);
  assert.throws(() => p.decodePriceFeedData(v.feedCell.afterBtcUpdate.slice(0, -2)), p.DecodeError);
  assert.equal(p.contractErrorName(83), "FEED_NOT_FORWARD");
});
