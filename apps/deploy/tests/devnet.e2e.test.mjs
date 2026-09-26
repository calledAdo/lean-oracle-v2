// Devnet end-to-end: a committee of 4 publisher containers signs prices; a mirror container ingests
// and verifies them against the committee cell; a project creates its own feed cell and moves it
// forward with prices pulled from the mirror; the contracts reject stale, tampered and old-set updates.
//
// Requires: a running offckb devnet on 127.0.0.1:8114, deployed code (deployments/devnet.json),
// and the images lean-oracle-publisher:dev and lean-oracle-mirror:dev.
// Run: LEAN_DEVNET=1 node --test apps/deploy/tests/
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

import { ccc } from "@ckb-ccc/core";
import { createClient, createPrivateKeySigner, getFeedCell } from "lean-oracle-sdk/ckb";
import { MirrorClient } from "lean-oracle-sdk/mirror";
import { parseDeployment } from "lean-oracle-sdk/presets";
import * as p from "lean-oracle-sdk/protocol";
import * as pub from "lean-oracle-sdk/publisher";
import { bootstrapCommittee, burnFeedCell, completeFeeAndChange, createFeedCell, encodeFeedWitness, governCommittee, pullAndUpdate, updateFeedCell } from "lean-oracle-sdk/tx";

const enabled = process.env.LEAN_DEVNET === "1";
const repo = resolve(import.meta.dirname, "../../..");
const network = JSON.parse(readFileSync(join(repo, "apps/deploy/config/devnet.json"), "utf8"));
// offckb's well-known genesis accounts #0 (deployer) and #1 (a project). Devnet only.
const DEPLOYER = "0x6109170b275a09ad54877b82f7d9930f88cab5717d484fb4741ae9d1dd078cd6";
const PROJECT = "0x9f315d5a9618a39fdc487c7a67a8581d40b045bd7a42d83648ca80ef3b2cb4a1";
const BTC = p.feedId("Crypto.BTC/USD");
const FEE = { feeRate: 1000n };
const tag = `e2e${Date.now()}`;

const client = createClient("devnet", network.rpcUrl, network.secp256k1);
const deployer = createPrivateKeySigner(client, DEPLOYER);
const project = createPrivateKeySigner(client, PROJECT);
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {};

async function send(signer, tx) {
  await completeFeeAndChange(tx, signer, FEE);
  const hash = await signer.sendTransaction(tx);
  await client.waitTransaction(hash, 0, 120_000);
  return hash;
}

// Verifies every update against the committee as bootstrapped (set 0).
const mirror = new MirrorClient({ urls: "http://127.0.0.1:18800", committees: () => ({ [state.committee.typeHash]: state.committee.data }) });

/** The mirror's latest BTC update newer than `minTick` (a blob carrying just that feed). */
async function latestUpdate(minTick = 0n) {
  for (let i = 0; i < 60; i++) {
    const [update] = await mirror.latest([BTC]).catch(() => []);
    if (update && update.publishTimeMs > minTick) return p.decodePriceUpdate(update.blob);
    await sleep(1000);
  }
  throw new Error("no finalized update from the mirror");
}

/** An update transaction built by hand, skipping the SDK's local checks, to exercise the contract. */
async function rawUpdate(feedType, outputData, blob) {
  const feed = await getFeedCell(client, feedType);
  const tx = ccc.Transaction.from({});
  tx.addInput({ previousOutput: feed.cell.outPoint });
  tx.addOutput(feed.cell.cellOutput, ccc.hexFrom(p.encodePriceFeedData(outputData)));
  tx.addCellDeps(state.deployment.contracts.priceFeedType.cellDep, state.committeeCellDep());
  const witness = ccc.WitnessArgs.from({ inputType: ccc.hexFrom(encodeFeedWitness(blob)) });
  tx.setWitnessArgsAt(0, witness);
  return { tx, before: feed.data };
}

async function expectScriptError(signer, tx, code) {
  await completeFeeAndChange(tx, signer, FEE);
  await assert.rejects(signer.sendTransaction(tx), (error) => String(error.message ?? error).includes(`error code ${code}`), `expected script error ${code}`);
}

before(async () => {
  if (!enabled) return;
  const base = parseDeployment(JSON.parse(readFileSync(join(repo, "deployments/devnet.json"), "utf8")));
  const keys = Array.from({ length: 4 }, () => p.bytesToHex(randomBytes(32)));
  const data = { networkId: `0x${"00".repeat(32)}`, governanceNonce: 0n, governanceFlags: 0, minRotationIntervalS: 1n, current: { setIndex: 0, pubkeys: keys.map(pub.publicKeyOf).sort() } };
  const { tx, typeScript, typeHash } = await bootstrapCommittee({ signer: deployer, deployment: base, data });
  await send(deployer, tx);
  state.deployment = { ...base, committees: { [tag]: { typeScript, typeHash } } };
  state.committee = { typeScript, typeHash, keys, data };
  const { findCommitteeCell } = await import("lean-oracle-sdk/ckb");
  state.committeeCellDep = () => state.currentCommitteeDep;
  state.currentCommitteeDep = (await findCommitteeCell(client, typeScript)).cellDep;

  const out = mkdtempSync(join(tmpdir(), "lean-e2e-"));
  execFileSync("node", [
    join(repo, "apps/publisher/scripts/local-committee.mjs"), "--template", join(repo, "apps/publisher/configs/majors.template.json"),
    "--out", out, "--mock", "--docker", "--keys", keys.join(","), "--publisher-set-type-hash", typeHash,
    "--chain-rpc", "http://host.docker.internal:8114", "--committee-type-script", JSON.stringify(typeScript),
  ], { cwd: join(repo, "apps/publisher") });
  docker("network", "create", tag);
  for (let i = 0; i < 4; i++) {
    docker("run", "-d", "--name", `${tag}-publisher-${i}`, "--network", tag, "--network-alias", `publisher-${i}`,
      "-v", `${out}/publisher-${i}:/config:ro`, "-p", `${18700 + i * 10}:7701`, "lean-oracle-publisher:dev");
  }
  const mirrorDir = join(out, "mirror");
  mkdirSync(mirrorDir);
  writeFileSync(join(mirrorDir, "mirror.json"), JSON.stringify({
    http: { host: "0.0.0.0", port: 7800 },
    dataPath: "/data/mirror.db",
    committees: [{
      name: "majors", publisherSetTypeHash: typeHash,
      chain: { rpcUrl: "http://host.docker.internal:8114", typeScript, refreshMs: 5000 },
      publishers: [0, 1, 2, 3].map((i) => `http://publisher-${i}:7701`),
    }],
  }));
  docker("run", "-d", "--name", `${tag}-mirror`, "--network", tag, "-v", `${mirrorDir}:/config:ro`, "-p", "18800:7800", "lean-oracle-mirror:dev");
});

after(() => {
  if (!enabled) return;
  for (const name of [0, 1, 2, 3].map((i) => `${tag}-publisher-${i}`).concat(`${tag}-mirror`)) try { docker("rm", "-f", name); } catch {}
  try { docker("network", "rm", tag); } catch {}
});

test("project creates a feed cell and moves it forward with committee prices", { skip: !enabled }, async () => {
  const { tx, typeScript } = await createFeedCell({ signer: project, deployment: state.deployment, feedId: BTC, committee: state.committee.typeScript });
  await send(project, tx);
  state.feedType = typeScript;
  const created = await getFeedCell(client, typeScript);
  assert.equal(created.data.publishTimeMs, 0n);
  assert.equal(created.data.publisherSetTypeHash, state.committee.typeHash);

  const first = await latestUpdate();
  const u1 = await updateFeedCell({ client, deployment: state.deployment, feedType: typeScript, update: first });
  await send(project, u1.tx);
  const afterFirst = await getFeedCell(client, typeScript);
  assert.deepEqual(afterFirst.data, u1.after);
  assert.equal(afterFirst.data.publishTimeMs, first.header.publishTimeMs);
  state.first = first;

  await latestUpdate(first.header.publishTimeMs);
  const u2 = await pullAndUpdate({ client, deployment: state.deployment, feedType: typeScript, mirror });
  await send(project, u2.tx);
  const [pulled] = await mirror.at(u2.verified.header.publishTimeMs, [BTC]);
  const second = p.decodePriceUpdate(pulled.blob);
  assert.equal((await getFeedCell(client, typeScript)).data.publishTimeMs, second.header.publishTimeMs);
  state.second = second;
  console.log(`BTC/USD on chain: ${Number(u2.after.price) / 1e8} at tick ${second.header.publishTimeMs} (${u2.after.numPublishers} publishers)`);
});

test("contract rejects a stale and a tampered update", { skip: !enabled }, async () => {
  const cell = await getFeedCell(client, state.feedType);
  const stale = p.verifyPriceUpdate(state.first, BTC, state.committee.typeHash, state.committee.data);
  const staleTx = await rawUpdate(state.feedType, p.applyVerifiedPrice(cell.data, stale), p.encodePriceUpdate(state.first));
  await expectScriptError(project, staleTx.tx, 83); // FEED_NOT_FORWARD

  const next = await latestUpdate(state.second.header.publishTimeMs);
  const good = p.verifyPriceUpdate(next, BTC, state.committee.typeHash, state.committee.data);
  const tampered = { ...p.applyVerifiedPrice(cell.data, good), price: good.message.price + 1n };
  const tamperedTx = await rawUpdate(state.feedType, tampered, p.encodePriceUpdate(next));
  await expectScriptError(project, tamperedTx.tx, 91); // UPDATE_MISMATCH
});

test("a past update initializes a fresh cell", { skip: !enabled }, async () => {
  const { tx, typeScript } = await createFeedCell({ signer: project, deployment: state.deployment, feedId: BTC, committee: state.committee.typeScript });
  await send(project, tx);
  const u = await updateFeedCell({ client, deployment: state.deployment, feedType: typeScript, update: state.first });
  await send(project, u.tx);
  assert.equal((await getFeedCell(client, typeScript)).data.publishTimeMs, state.first.header.publishTimeMs);
  state.historicalFeed = typeScript;
});

test("after an emergency (revoking) rotation, updates signed by the old set are rejected", { skip: !enabled }, async () => {
  const nextKeys = Array.from({ length: 4 }, () => p.bytesToHex(randomBytes(32)));
  const ordered = nextKeys.map((key) => ({ key, pubkey: pub.publicKeyOf(key) })).sort((a, b) => (a.pubkey < b.pubkey ? -1 : 1));
  const current = state.committee.data;
  const next = { ...current, governanceNonce: 1n, current: { setIndex: 1, pubkeys: ordered.map((o) => o.pubkey) } }; // no previous: revoked
  const currentOrdered = state.committee.keys.map((key) => ({ key, pubkey: pub.publicKeyOf(key) })).sort((a, b) => (a.pubkey < b.pubkey ? -1 : 1));
  const h = state.committee.typeHash;
  const authorization = pub.toSignatureBundle([0, 1, 2].map((i) => pub.signGovernance(current, next, p.OP_ROTATE_REVOKE, h, currentOrdered[i].key, i)));
  const proofOfPossession = ordered.map((o, i) => pub.signProofOfPossession(next, h, o.key, i));
  const tx = await governCommittee({ client, deployment: state.deployment, committee: state.committee.typeScript, operation: p.OP_ROTATE_REVOKE, next, authorization, proofOfPossession });
  await send(deployer, tx);
  const { findCommitteeCell } = await import("lean-oracle-sdk/ckb");
  const rotated = await findCommitteeCell(client, state.committee.typeScript);
  assert.equal(rotated.data.current.setIndex, 1);
  state.currentCommitteeDep = rotated.cellDep;

  const newest = await latestUpdate(state.second.header.publishTimeMs).catch(() => undefined);
  const old = newest ?? state.second;
  await assert.rejects(updateFeedCell({ client, deployment: state.deployment, feedType: state.historicalFeed, update: old }), p.VerifyError);
  const cell = await getFeedCell(client, state.historicalFeed);
  const verified = p.verifyPriceUpdate(old, BTC, state.committee.typeHash, current);
  const rawTx = await rawUpdate(state.historicalFeed, p.applyVerifiedPrice(cell.data, verified), p.encodePriceUpdate(old));
  await expectScriptError(project, rawTx.tx, 89); // UPDATE_SET
});

test("the owner burns a feed cell and recovers its capacity", { skip: !enabled }, async () => {
  const tx = await burnFeedCell(client, state.deployment, state.historicalFeed);
  await send(project, tx);
  assert.equal(await getFeedCell(client, state.historicalFeed), undefined);
});
