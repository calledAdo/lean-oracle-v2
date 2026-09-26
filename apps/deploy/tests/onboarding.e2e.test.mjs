// Devnet drill: onboarding a second publisher with the operator tooling, end to end.
//
//   1. A one-publisher committee (like testnet today) signs prices; a mirror serves them.
//   2. A newcomer runs the publisher in shadow mode against the mirror and matches the committee.
//   3. The rotation is built only from `lean-oracle-publisher` CLI output: fetch-set, next-set,
//      sign-rotation, sign-pop, sign-config --set next, merge-signatures, add-approval, rotation-status.
//   4. The rotation is sent; the old publisher restarts under the new set, the newcomer leaves shadow
//      mode, and updates signed 2-of-2 by the new set move a feed cell on chain.
//
// Requires: a running offckb devnet on 127.0.0.1:8114, deployed code (deployments/devnet.json), and
// the images lean-oracle-publisher:dev and lean-oracle-mirror:dev built from this checkout.
// Run: LEAN_DEVNET=1 node --test apps/deploy/tests/onboarding.e2e.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

import { createClient, createPrivateKeySigner, findCommitteeCell, getFeedCell } from "lean-oracle-sdk/ckb";
import { MirrorClient } from "lean-oracle-sdk/mirror";
import { parseDeployment } from "lean-oracle-sdk/presets";
import * as p from "lean-oracle-sdk/protocol";
import * as pub from "lean-oracle-sdk/publisher";
import { bootstrapCommittee, completeFeeAndChange, createFeedCell, rotateCommittee, updateFeedCell } from "lean-oracle-sdk/tx";

const enabled = process.env.LEAN_DEVNET === "1";
const repo = resolve(import.meta.dirname, "../../..");
const network = JSON.parse(readFileSync(join(repo, "apps/deploy/config/devnet.json"), "utf8"));
// offckb's well-known genesis accounts #0 (deployer) and #1 (a project). Devnet only.
const DEPLOYER = "0x6109170b275a09ad54877b82f7d9930f88cab5717d484fb4741ae9d1dd078cd6";
const PROJECT = "0x9f315d5a9618a39fdc487c7a67a8581d40b045bd7a42d83648ca80ef3b2cb4a1";
const BTC = p.feedId("Crypto.BTC/USD");
const FEE = { feeRate: 1000n };
const tag = `onb${Date.now()}`;
const MIRROR_PORT = 18900;
const SHADOW_PORT = 18911;

const client = createClient("devnet", network.rpcUrl, network.secp256k1);
const deployer = createPrivateKeySigner(client, DEPLOYER);
const project = createPrivateKeySigner(client, PROJECT);
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = {};

/** The publisher CLI, as an operator runs it (same code as the image's entrypoint). */
function cli(cwd, ...args) {
  return execFileSync("node", [join(repo, "apps/publisher/dist/main.js"), ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function send(signer, tx) {
  await completeFeeAndChange(tx, signer, FEE);
  const hash = await signer.sendTransaction(tx);
  await client.waitTransaction(hash, 0, 120_000);
  return hash;
}

async function waitFor(what, fn, seconds = 90) {
  for (let i = 0; i < seconds; i++) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const editJson = (file, edit) => writeFileSync(file, `${JSON.stringify(edit(JSON.parse(readFileSync(file, "utf8"))), null, 2)}\n`);

before(async () => {
  if (!enabled) return;
  const base = parseDeployment(JSON.parse(readFileSync(join(repo, "deployments/devnet.json"), "utf8")));
  const k0 = p.bytesToHex(randomBytes(32));
  const k1 = p.bytesToHex(randomBytes(32));
  const data = { networkId: `0x${"00".repeat(32)}`, governanceNonce: 0n, governanceFlags: 0, current: { setIndex: 0, pubkeys: [pub.publicKeyOf(k0)] } };
  const { tx, typeScript, typeHash } = await bootstrapCommittee({ signer: deployer, deployment: base, data });
  await send(deployer, tx);
  Object.assign(state, { k0, k1, typeScript, typeHash, deployment: { ...base, committees: { [tag]: { typeScript, typeHash } } } });

  // The existing single publisher.
  const out = mkdtempSync(join(tmpdir(), "lean-onboarding-"));
  state.out = out;
  execFileSync("node", [
    join(repo, "apps/publisher/scripts/local-committee.mjs"), "--template", join(repo, "apps/publisher/configs/majors.template.json"),
    "--out", out, "--mock", "--docker", "--keys", k0, "--publisher-set-type-hash", typeHash,
    "--chain-rpc", "http://host.docker.internal:8114", "--committee-type-script", JSON.stringify(typeScript),
  ], { cwd: join(repo, "apps/publisher") });
  docker("network", "create", tag);
  docker("run", "-d", "--name", `${tag}-publisher-0`, "--network", tag, "--network-alias", "publisher-0", "--restart", "unless-stopped",
    "-v", `${out}/publisher-0:/config`, "lean-oracle-publisher:dev");

  // The mirror follows both publishers (the newcomer serves nothing until it joins).
  const mirrorDir = join(out, "mirror");
  mkdirSync(mirrorDir);
  writeFileSync(join(mirrorDir, "mirror.json"), JSON.stringify({
    http: { host: "0.0.0.0", port: 7800 },
    dataPath: "/data/mirror.db",
    committees: [{ name: "majors", publisherSetTypeHash: typeHash, chain: { rpcUrl: "http://host.docker.internal:8114", typeScript, refreshMs: 5000 }, publishers: ["http://publisher-0:7701", "http://publisher-1:7701"] }],
    rateLimit: { anonymous: { rps: 1000, burst: 1000, maxStreams: 10 } },
  }));
  docker("run", "-d", "--name", `${tag}-mirror`, "--network", tag, "--network-alias", "mirror", "-v", `${mirrorDir}:/config:ro`, "-p", `${MIRROR_PORT}:7800`, "lean-oracle-mirror:dev");

  // The newcomer: its own key, the committee's current configs, and shadow mode pointed at the mirror.
  const newcomer = join(out, "publisher-1");
  cpSync(join(out, "publisher-0"), newcomer, { recursive: true });
  writeFileSync(join(newcomer, "publisher.key"), `${k1}\n`, { mode: 0o644 });
  editJson(join(newcomer, "publisher.json"), (c) => ({ ...c, peers: [], mockSource: { ...c.mockSource, skewBps: 3 }, shadow: { referenceUrl: "http://mirror:7800" } }));
  docker("run", "-d", "--name", `${tag}-publisher-1`, "--network", tag, "--network-alias", "publisher-1", "--restart", "unless-stopped",
    "-v", `${newcomer}:/config`, "-p", `${SHADOW_PORT}:7701`, "lean-oracle-publisher:dev");
});

after(() => {
  if (!enabled || process.env.LEAN_KEEP === "1") return;
  for (const name of [`${tag}-publisher-0`, `${tag}-publisher-1`, `${tag}-mirror`]) try { docker("rm", "-f", name); } catch {}
  try { docker("network", "rm", tag); } catch {}
});

test("the newcomer's shadow run matches the committee", { skip: !enabled }, async () => {
  const report = await waitFor("a shadow report with comparisons", async () => {
    const r = await (await fetch(`http://127.0.0.1:${SHADOW_PORT}/health`)).json();
    const btc = r.feeds.find((f) => f.symbol === "Crypto.BTC/USD");
    return btc && btc.compared >= 10 ? r : undefined;
  });
  for (const f of report.feeds) {
    assert.equal(f.withinTolerance, f.compared, `${f.symbol} within tolerance`);
  }
  console.log(`shadow: ${report.feeds.length} feeds, e.g. BTC/USD ${JSON.stringify(report.feeds.find((f) => f.symbol === "Crypto.BTC/USD"))}`);
});

test("a rotation built with the operator CLI adds the newcomer on chain", { skip: !enabled }, async () => {
  const work = join(state.out, "rotation");
  mkdirSync(work);
  writeFileSync(join(work, "k0.key"), state.k0);
  writeFileSync(join(work, "k1.key"), state.k1);
  writeFileSync(join(work, "operator.json"), JSON.stringify({ committee: { chain: { rpcUrl: network.rpcUrl, typeScript: state.typeScript } } }));

  // Coordinator: read the live set and propose the next one.
  writeFileSync(join(work, "current.hex"), cli(work, "fetch-set", "--operator", "operator.json"));
  writeFileSync(join(work, "next.hex"), cli(work, "next-set", "--set", "current.hex", "--add", pub.publicKeyOf(state.k1)));
  assert.equal(JSON.parse(cli(work, "show-set", "--set", "next.hex")).quorum, 2);

  // Each operator on its own: authorization (current member), proofs of possession and config approvals (next set).
  writeFileSync(join(work, "auth-0.json"), cli(work, "sign-rotation", "--set", "current.hex", "--next", "next.hex", "--key", "k0.key"));
  const configFile = readdirSync(join(state.out, "publisher-0", "configs")).find((f) => f.endsWith(".json"));
  for (const k of ["k0", "k1"]) {
    writeFileSync(join(work, `pop-${k}.json`), cli(work, "sign-pop", "--next", "next.hex", "--key", `${k}.key`));
    writeFileSync(join(work, `appr-${k}.json`), cli(work, "sign-config", "--config", join(state.out, "publisher-0", "configs", configFile), "--key", `${k}.key`, "--set", "next.hex"));
  }

  // Coordinator: merge, record the config approvals for every operator, check, send.
  writeFileSync(join(work, "auth.json"), cli(work, "merge-signatures", "auth-0.json"));
  writeFileSync(join(work, "pop.json"), cli(work, "merge-signatures", "pop-k0.json", "pop-k1.json"));
  for (const dir of ["publisher-0", "publisher-1"]) {
    cli(work, "add-approval", "--file", join(state.out, dir, "configs", configFile), "--set", "next.hex", "appr-k0.json", "appr-k1.json");
  }
  const status = JSON.parse(cli(work, "rotation-status", "--set", "current.hex", "--next", "next.hex", "--authorization", "auth.json", "--pop", "pop.json"));
  assert.equal(status.ready, true, JSON.stringify(status));

  // Peers for the two-publisher committee, ready before the restart.
  const pk = (k) => pub.publicKeyOf(k);
  editJson(join(state.out, "publisher-0", "publisher.json"), (c) => ({ ...c, peers: [{ pubkey: pk(state.k1), url: "ws://publisher-1:7700" }] }));

  // The same call `rotate:committee` makes with these files.
  const read = (f) => readFileSync(join(work, f), "utf8");
  const next = p.decodePublisherSetData(read("next.hex").trim());
  const tx = await rotateCommittee({
    client, deployment: state.deployment, committee: state.typeScript, next,
    authorization: pub.toSignatureBundle(JSON.parse(read("auth.json"))),
    proofOfPossession: pub.toSignatureBundle(JSON.parse(read("pop.json"))),
  });
  state.rotationTx = await send(deployer, tx);
  const rotated = await findCommitteeCell(client, state.typeScript);
  assert.equal(rotated.data.current.setIndex, 1);
  assert.equal(rotated.data.current.pubkeys.length, 2);
  state.rotated = rotated.data;
  console.log(`rotation ${state.rotationTx}: set 1, 2 publishers`);
});

test("after the rotation both publishers sign, and their updates move a feed cell", { skip: !enabled }, async () => {
  // The newcomer leaves shadow mode and joins as a peer.
  editJson(join(state.out, "publisher-1", "publisher.json"), (c) => {
    const { shadow, ...rest } = c;
    return { ...rest, peers: [{ pubkey: pub.publicKeyOf(state.k0), url: "ws://publisher-0:7700" }] };
  });
  docker("restart", `${tag}-publisher-1`);

  const mirror = new MirrorClient({ urls: `http://127.0.0.1:${MIRROR_PORT}`, committees: () => ({ [state.typeHash]: state.rotated }) });
  const update = await waitFor("an update signed by the new set", async () => {
    const [u] = await mirror.latest([BTC]);
    const decoded = u && p.decodePriceUpdate(u.blob);
    return decoded && decoded.header.setIndex === 1 ? decoded : undefined;
  }, 120);
  assert.equal(update.signatures.length, 2, "both publishers signed");
  assert.equal(update.entries[0].message.numPublishers, 2);

  const { tx, typeScript } = await createFeedCell({ signer: project, deployment: state.deployment, feedId: BTC, committee: state.typeScript });
  await send(project, tx);
  const u = await updateFeedCell({ client, deployment: state.deployment, feedType: typeScript, update });
  await send(project, u.tx);
  const cell = await getFeedCell(client, typeScript);
  assert.equal(cell.data.publishTimeMs, update.header.publishTimeMs);
  assert.equal(cell.data.numPublishers, 2);
  console.log(`feed cell moved with a 2-of-2 update at tick ${update.header.publishTimeMs}`);
});
