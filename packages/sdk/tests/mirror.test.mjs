// MirrorClient: values come from the blob, updates are verified, requests fail over.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { MirrorClient, mirrorUpdateJson, MirrorError } from "lean-oracle-sdk/mirror";
import * as p from "lean-oracle-sdk/protocol";

const v = JSON.parse(readFileSync(new URL("../../../vectors/protocol.json", import.meta.url), "utf8"));
const committeeData = p.decodePublisherSetData(v.committee.bytes);
const update = p.decodePriceUpdate(v.update.blob);
const feed = update.entries[0].message.feedId;
const json = mirrorUpdateJson(update, [feed]);

const respond = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

test("decodes and verifies; failover past a broken mirror", async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    return url.startsWith("http://down") ? respond(503, { error: "down" }) : respond(200, { updates: [json], missing: [] });
  };
  const client = new MirrorClient({ urls: ["http://down", "http://up"], fetch, committees: { [v.update.publisherSetTypeHash]: committeeData } });
  const [got] = await client.latest([feed]);
  assert.equal(calls.length, 2);
  assert.equal(got.publishTimeMs, update.header.publishTimeMs);
  assert.deepEqual(got.prices[0].price, update.entries[0].message.price);
  assert.equal(p.decodePriceUpdate(got.blob).entries.length, 1, "blob carries just the requested feed");
});

test("ignores the JSON price fields and rejects unverifiable or unrequested data", async () => {
  const lying = { ...json, prices: [{ ...json.prices[0], price: "1" }] };
  const client = (body, committees) => new MirrorClient({ urls: "http://m", fetch: async () => respond(200, body), committees });
  const [got] = await client({ updates: [lying] }).latest([feed]);
  assert.equal(got.prices[0].price, update.entries[0].message.price, "values are decoded from the signed blob");

  const other = `0x${"11".repeat(32)}`;
  await assert.rejects(client({ updates: [json] }, { [other]: committeeData }).latest([feed]), MirrorError, "unexpected committee");
  const paused = { ...committeeData, governanceFlags: p.GOVERNANCE_PAUSED };
  await assert.rejects(client({ updates: [json] }, { [v.update.publisherSetTypeHash]: paused }).latest([feed]), p.VerifyError);
  await assert.rejects(client({ updates: [json] }).latest([p.feedId("Crypto.OTHER/USD")]), /not requested/);
});

test("client errors are not retried on other mirrors", async () => {
  let calls = 0;
  const client = new MirrorClient({ urls: ["http://a", "http://b"], fetch: async () => (calls++, respond(400, { error: "bad" })) });
  await assert.rejects(client.at("abc", [feed]), (e) => e instanceof MirrorError && e.status === 400);
  assert.equal(calls, 1);
});
