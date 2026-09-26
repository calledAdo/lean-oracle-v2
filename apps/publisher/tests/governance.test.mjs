import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { OP_ROTATE, bytesToHex, encodePublisherSetData, publisherSetUpdateHash, verifyThreshold } from "lean-oracle-sdk/protocol";
import { publicKeyOf } from "lean-oracle-sdk/publisher";

import { mergeSignatures, nextSet, rotationStatus, signProofOfPossession, signRotation } from "../dist/governance.js";
import { deviationBps, ShadowRunner } from "../dist/shadow.js";

const keyOf = (i) => `0x${(i + 1).toString(16).padStart(64, "0")}`;
const signer = (key) => ({ publicKey: publicKeyOf(key), sign: async (d) => (await import("lean-oracle-sdk/publisher")).signDigest(d, key) });
const keys = [0, 1, 2, 3, 4].map(keyOf);
const current = {
  networkId: `0x${"ab".repeat(32)}`,
  governanceNonce: 0n,
  governanceFlags: 0,
  current: { setIndex: 0, pubkeys: keys.slice(0, 4).map(publicKeyOf).sort() },
};

test("rotation: add a publisher with a current quorum and proofs from every next key", async () => {
  const next = nextSet(current, [publicKeyOf(keys[4])]);
  assert.equal(next.current.setIndex, 1);
  assert.equal(next.governanceNonce, 1n);
  assert.equal(next.current.pubkeys.length, 5);
  assert.deepEqual(next.current.pubkeys, [...next.current.pubkeys].sort());

  // Three of the four current members authorize; every next member proves possession.
  const auth = await Promise.all(keys.slice(0, 3).map((k) => signRotation(current, next, signer(k))));
  const pop = await Promise.all(keys.map((k) => signProofOfPossession(next, signer(k))));

  const partial = rotationStatus(current, next, auth.slice(0, 2), pop.slice(0, 4));
  assert.equal(partial.ready, false);
  assert.equal(partial.authorization.valid, false);
  assert.equal(partial.proofOfPossession.missing.length, 1);

  const merged = mergeSignatures([auth.slice(0, 2), auth[2], auth[0]]);
  assert.equal(merged.length, 3);
  const status = rotationStatus(current, next, merged, mergeSignatures([pop]));
  assert.equal(status.ready, true);
  assert.ok(verifyThreshold(merged, publisherSetUpdateHash(current, next, OP_ROTATE), current.current));
});

test("rotation: refuses bad inputs", async () => {
  assert.throws(() => nextSet(current, [current.current.pubkeys[0]]), /already in the set/);
  assert.throws(() => nextSet(current, [], [publicKeyOf(keys[4])]), /not in the current set/);
  assert.throws(() => nextSet(current, ["0x1234"]), /compressed/);
  const next = nextSet(current, [publicKeyOf(keys[4])]);
  await assert.rejects(signRotation(current, next, signer(keys[4])), /not in the current set/);
  await assert.rejects(signProofOfPossession(next, signer(keyOf(9))), /not in the next set/);
  const skipped = { ...next, current: { ...next.current, setIndex: 2 } };
  await assert.rejects(signRotation(current, skipped, signer(keys[0])), /index/);
  assert.throws(() => mergeSignatures([{ publisherIndex: 0, signature: "0x01" }, { publisherIndex: 0, signature: "0x02" }]), /conflicting/);
});

test("rotation CLI: next-set, sign-rotation, sign-pop, merge-signatures, rotation-status", () => {
  const dir = mkdtempSync(join(tmpdir(), "lean-rotation-"));
  const cli = (...args) => execFileSync("node", [new URL("../dist/main.js", import.meta.url).pathname, ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  writeFileSync(join(dir, "current.hex"), bytesToHex(encodePublisherSetData(current)));
  keys.forEach((k, i) => writeFileSync(join(dir, `k${i}.key`), k));
  writeFileSync(join(dir, "next.hex"), cli("next-set", "--set", "current.hex", "--add", publicKeyOf(keys[4])));
  assert.equal(JSON.parse(cli("show-set", "--set", "next.hex")).publishers, 5);
  for (const i of [0, 1, 2]) writeFileSync(join(dir, `auth${i}.json`), cli("sign-rotation", "--set", "current.hex", "--next", "next.hex", "--key", `k${i}.key`));
  for (const i of [0, 1, 2, 3, 4]) writeFileSync(join(dir, `pop${i}.json`), cli("sign-pop", "--next", "next.hex", "--key", `k${i}.key`));
  writeFileSync(join(dir, "auth.json"), cli("merge-signatures", "auth0.json", "auth1.json", "auth2.json"));
  writeFileSync(join(dir, "pop.json"), cli("merge-signatures", ...[0, 1, 2, 3, 4].map((i) => `pop${i}.json`)));
  const status = JSON.parse(cli("rotation-status", "--set", "current.hex", "--next", "next.hex", "--authorization", "auth.json", "--pop", "pop.json"));
  assert.equal(status.ready, true);
});

test("shadow: deviation and comparison against the committee's update", async () => {
  assert.equal(deviationBps(10_050n, 10_000n), 50);
  assert.equal(deviationBps(9_950n, 10_000n), 50);
  assert.equal(deviationBps(10_001n, 10_000n), 1, "rounded up");

  const feeds = [
    { feedId: "0xaa", symbol: "A", toleranceBps: 50 },
    { feedId: "0xbb", symbol: "B", toleranceBps: 50 },
    { feedId: "0xcc", symbol: "C", toleranceBps: 50 },
  ];
  const logs = [];
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ updates: [{ publishTimeMs: "1000", prices: [{ feedId: "0xaa", price: "10000" }, { feedId: "0xbb", price: "10000" }] }] }),
  });
  const shadow = new ShadowRunner({ schedule: null, marketData: null, publisherSetTypeHash: "0x00", referenceUrl: "http://mirror", api: { host: "127.0.0.1", port: 0 }, log: (e, d) => logs.push([e, d]), fetch: fakeFetch });
  await shadow.compare(1000n, [{ feedId: "0xaa", price: 10_020n }, { feedId: "0xbb", price: 10_200n }, { feedId: "0xcc", price: 1n }], feeds);
  const byName = Object.fromEntries(shadow.report().map((s) => [s.symbol, s]));
  assert.equal(byName.A.withinTolerance, 1);
  assert.equal(byName.B.withinTolerance, 0);
  assert.equal(byName.B.maxDeviationBps, 200);
  assert.equal(byName.C.missedByCommittee, 1);
  assert.ok(logs.some(([e]) => e === "shadow.outside_tolerance"));
});

test("configs stay valid across a rotation once the next set has approved them", async () => {
  const { committeeConfig, SET_TYPE_HASH } = await import("./helpers.mjs");
  const pub = await import("lean-oracle-sdk/publisher");
  const { ConfigSchedule } = await import("../dist/configSchedule.js");
  const { loadConfigDir } = await import("../dist/config.js");
  const { mkdirSync } = await import("node:fs");

  const config = committeeConfig();
  const setKeys = (set) => set.current.pubkeys.map((p) => keys.find((k) => publicKeyOf(k) === p));
  const next = nextSet(current, [publicKeyOf(keys[4])]);
  const dir = mkdtempSync(join(tmpdir(), "lean-configs-"));
  mkdirSync(join(dir, "configs"));
  const sign = (set) => setKeys(set).map((k, i) => pub.signCommitteeConfig(config, k, i));
  writeFileSync(join(dir, "configs", "v1.json"), JSON.stringify({ config, signatures: sign(current) }));
  writeFileSync(join(dir, "next.hex"), bytesToHex(encodePublisherSetData(next)));
  sign(next).forEach((s, i) => writeFileSync(join(dir, `a${i}.json`), JSON.stringify(s)));

  // Under the new set, the original signatures no longer verify (indexes moved).
  const before = new ConfigSchedule(SET_TYPE_HASH, next.current);
  const rejected = [];
  loadConfigDir(join(dir, "configs"), before, (e) => rejected.push(e));
  assert.deepEqual(rejected, ["config.rejected"]);

  execFileSync("node", [new URL("../dist/main.js", import.meta.url).pathname, "add-approval", "--file", "configs/v1.json", "--set", "next.hex", ...[0, 1, 2, 3, 4].map((i) => `a${i}.json`)], { cwd: dir, stdio: "ignore" });
  const after = new ConfigSchedule(SET_TYPE_HASH, next.current);
  assert.deepEqual(loadConfigDir(join(dir, "configs"), after), [config.version]);
  // The current set still loads it from `signatures`.
  assert.deepEqual(loadConfigDir(join(dir, "configs"), new ConfigSchedule(SET_TYPE_HASH, current.current)), [config.version]);
});
