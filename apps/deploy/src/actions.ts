//! Deployment actions. Every action is a dry run unless broadcasting is enabled; a dry run builds
//! the complete transaction (inputs, fee, change) and reports what it would spend.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { ccc } from "@ckb-ccc/core";
import { findCommitteeCell } from "lean-oracle-sdk/ckb";
import type { ContractName, DeploymentRecord } from "lean-oracle-sdk/presets";
import { decodePublisherSetData, isValidPublisherSetData, needsProofOfPossession, OP_PAUSE, OP_REVOKE_PREVIOUS, OP_ROTATE, OP_ROTATE_REVOKE, OP_UNPAUSE, type Hex, type IndexedSignature } from "lean-oracle-sdk/protocol";
import { toSignatureBundle } from "lean-oracle-sdk/publisher";
import { bootstrapCommittee, completeFee, DEFAULT_MIN_ROTATION_INTERVAL_S, governCommittee, occupiedCapacity } from "lean-oracle-sdk/tx";

import { loadConfig, REPO_ROOT, type Context } from "./context.js";

const CONTRACTS: ContractName[] = ["priceFeedType", "publisherSetType"];
const ckb = (shannons: bigint) => `${ccc.fixedPointToString(shannons)} CKB`;
const now = () => new Date().toISOString();
export const log = (event: string, detail: Record<string, unknown> = {}) =>
  process.stdout.write(`${JSON.stringify({ event, ...detail }, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n`);

/** Complete fees and send, or report the plan on a dry run. Returns the tx hash when sent. */
async function send(ctx: Context, tx: ccc.Transaction, what: string): Promise<Hex | undefined> {
  const result = await completeFee(tx, ctx.signer, { feeRate: ctx.feeRate });
  if (result.status === "insufficient") throw new Error(`${what}: the deployer needs ${ckb(result.shortfall)} more`);
  const locked = tx.outputs.slice(0, tx.outputs.length - (result.changeAdded ? 1 : 0)).reduce((sum, o) => sum + o.capacity, 0n);
  if (!ctx.broadcast) {
    log("dry_run", { what, locks: ckb(locked), fee: ckb(result.fee), inputs: tx.inputs.length });
    return undefined;
  }
  const hash = (await ctx.signer.sendTransaction(tx)) as Hex;
  log("sent", { what, txHash: hash, locks: ckb(locked), fee: ckb(result.fee) });
  await ctx.client.waitTransaction(hash, 0, 300_000);
  log("committed", { what, txHash: hash });
  return hash;
}

async function balance(ctx: Context): Promise<bigint> {
  return ctx.signer.getBalance();
}

/**
 * Build the contracts reproducibly (pinned container, scripts/build-contracts.sh) and check them
 * against contracts/checksums.txt, so every deployed code hash can be rebuilt from source.
 */
export function buildContracts(ctx: Context): void {
  log("build", { script: "scripts/build-contracts.sh" });
  execFileSync(resolve(REPO_ROOT, "scripts/build-contracts.sh"), [], { cwd: REPO_ROOT, stdio: ["ignore", "inherit", "inherit"] });
  for (const contract of CONTRACTS) {
    const path = resolve(REPO_ROOT, ctx.config.binaries[contract]);
    if (!existsSync(path) || statSync(path).size === 0) throw new Error(`build output missing: ${path}`);
  }
}

/** Code hashes from contracts/checksums.txt (the reproducible build). */
function canonicalHashes(): Map<string, Hex> {
  const lines = readFileSync(resolve(REPO_ROOT, "contracts/checksums.txt"), "utf8").split("\n").filter((l) => l && !l.startsWith("#"));
  return new Map(lines.map((l) => l.split(" ") as [string, Hex]).map(([name, hash]) => [name, hash]));
}

const BINARY_NAMES: Record<ContractName, string> = { priceFeedType: "price_feed_type", publisherSetType: "publisher_set_type" };

/** Build, then deploy each contract whose binary differs from the current version (appends a version). */
export async function deployCode(ctx: Context, options: { build?: boolean } = {}): Promise<void> {
  if (options.build ?? true) buildContracts(ctx);
  const lock = (await ctx.signer.getRecommendedAddressObj()).script;
  let needed = 0n;
  for (const contract of CONTRACTS) {
    const binary = readFileSync(resolve(REPO_ROOT, ctx.config.binaries[contract]));
    const codeHash = ccc.hashCkb(binary) as Hex;
    // Public networks only get binaries anyone can rebuild from source.
    const canonical = canonicalHashes().get(BINARY_NAMES[contract]);
    if (ctx.network !== "devnet" && codeHash !== canonical) {
      throw new Error(`${contract}: binary ${codeHash} is not the reproducible build ${canonical} (contracts/checksums.txt); run scripts/build-contracts.sh`);
    }
    const current = ctx.record.current(contract);
    if (current?.code.codeHash === codeHash && (await ctx.client.getCellLive(current.code.cellDep.outPoint, false))) {
      log("unchanged", { contract, version: current.version, codeHash });
      continue;
    }
    const dataHex = ccc.hexFrom(binary) as Hex;
    const capacity = occupiedCapacity(lock as never, undefined, dataHex);
    needed += capacity;
    const tx = ccc.Transaction.from({});
    tx.addOutput({ lock, capacity }, dataHex);
    const txHash = await send(ctx, tx, `${contract} code (${binary.length} bytes)`);
    if (!txHash) continue;
    const version = ctx.record.appendCodeVersion(
      contract,
      { codeHash, hashType: "data2", cellDep: { outPoint: { txHash, index: 0 }, depType: "code" }, bytes: binary.length, capacity: capacity.toString(), deployedAt: now() },
      txHash,
    );
    log("deployed", { contract, version, codeHash, txHash });
    publishToSdk(ctx);
  }
  if (!ctx.broadcast && needed > 0n) {
    const have = await balance(ctx);
    log("plan", { locksInTotal: ckb(needed), balance: ckb(have), enough: have > needed + 100_000_000n, next: "rerun with BROADCAST=true (or --broadcast) to send" });
  }
}

/** Create a committee cell from `config.committees[name]`. */
export async function deployCommittee(ctx: Context, name: string): Promise<void> {
  const intent = ctx.config.committees[name];
  if (!intent) throw new Error(`config/${ctx.network}.json has no committee ${name}`);
  if (ctx.record.read().committees[name]) throw new Error(`committee ${name} already exists; use govern:committee to change its keys`);
  const deployment = ctx.record.deployment();
  const pubkeys = [...new Set(intent.pubkeys.map((k) => k.toLowerCase() as Hex))].sort();
  const networkId = intent.networkId ?? ((await ctx.client.getHeaderByNumber(0))!.hash as Hex);
  const minRotationIntervalS = intent.minRotationIntervalS !== undefined ? BigInt(intent.minRotationIntervalS) : DEFAULT_MIN_ROTATION_INTERVAL_S;
  const data = { networkId, governanceNonce: 0n, governanceFlags: 0, minRotationIntervalS, current: { setIndex: 0, pubkeys } };
  if (!isValidPublisherSetData(data)) throw new Error(`committee ${name}: needs 1 to 9 distinct compressed public keys and a positive minRotationIntervalS`);
  const { tx, typeScript, typeHash } = await bootstrapCommittee({ signer: ctx.signer, deployment, data });
  log("committee", { name, typeHash, publishers: pubkeys.length, quorum: Math.floor((2 * pubkeys.length) / 3) + 1, networkId, minRotationIntervalS: minRotationIntervalS.toString() });
  const txHash = await send(ctx, tx, `committee ${name}`);
  if (!txHash) return;
  ctx.record.addCommittee(name, {
    typeScript,
    typeHash,
    codeVersion: ctx.record.current("publisherSetType")!.version,
    createdTx: txHash,
    createdAt: now(),
    publishers: pubkeys.length,
    rotations: [],
  });
  log("deployed", { name, typeHash, txHash });
  publishToSdk(ctx);
}

/**
 * Abandon a committee in the record. A committee cell cannot be destroyed on chain (its capacity
 * stays locked); this only stops tools and the SDK from using it, and frees its name.
 */
export async function retireCommittee(ctx: Context, name: string, reason: string): Promise<void> {
  const committee = ctx.record.read().committees[name];
  if (!committee) throw new Error(`unknown committee ${name}`);
  log("retire_committee", { name, typeHash: committee.typeHash, reason, note: "the committee cell stays on chain; its capacity is not recoverable" });
  if (!ctx.broadcast) {
    log("dry_run", { what: `retire committee ${name} (record only)` });
    return;
  }
  ctx.record.retireCommittee(name, reason, now());
  publishToSdk(ctx);
}

/**
 * Consume an old code cell and recover its capacity. Cells created under that version can no longer
 * move (their script's code is gone), so committees on it must be retired first; feed cells on it
 * should be burned by their owners first.
 */
export async function retireCode(ctx: Context, contract: ContractName, version: number, allowCurrent = false): Promise<void> {
  const record = ctx.record.read();
  const code = record.contracts[contract]?.versions[String(version)];
  if (!code) throw new Error(`${contract} v${version} is not in the record`);
  if (code.retired) throw new Error(`${contract} v${version} is already retired`);
  if (record.contracts[contract]!.current === version && !allowCurrent) {
    throw new Error(`${contract} v${version} is current; deploy a newer version first, or pass --allow-current (the network has no usable version until deploy:code runs)`);
  }
  if (contract === "publisherSetType") {
    const users = Object.entries(record.committees).filter(([, c]) => c.codeVersion === version).map(([n]) => n);
    if (users.length) throw new Error(`committees ${users.join(", ")} use ${contract} v${version}; retire them first`);
  }
  const live = await ctx.client.getCellLive(code.cellDep.outPoint, false);
  if (!live) throw new Error(`${contract} v${version} code cell is not live`);
  const tx = ccc.Transaction.from({});
  tx.addInput({ previousOutput: code.cellDep.outPoint });
  const txHash = await send(ctx, tx, `retire ${contract} v${version} (recovers ${ckb(live.cellOutput.capacity)})`);
  if (!txHash) return;
  ctx.record.retireCode(contract, version, txHash, now(), allowCurrent);
  log("retired", { contract, version, txHash });
  publishToSdk(ctx);
}

const OPERATIONS: Record<string, number> = {
  rotate: OP_ROTATE,
  "rotate-revoke": OP_ROTATE_REVOKE,
  pause: OP_PAUSE,
  unpause: OP_UNPAUSE,
  "revoke-previous": OP_REVOKE_PREVIOUS,
};

/**
 * One governance operation on a committee: `next` (hex committee data) with the current quorum's
 * authorization, plus proofs of possession for rotations. A routine rotation is only accepted once
 * the committee cell is `minRotationIntervalS` old.
 */
export async function govern(ctx: Context, name: string, opName: string, nextFile: string, authFile: string, popFile?: string): Promise<void> {
  const operation = OPERATIONS[opName];
  if (operation === undefined) throw new Error(`--op must be one of ${Object.keys(OPERATIONS).join(", ")}`);
  const deployment = ctx.record.deployment();
  const committee = deployment.committees[name];
  if (!committee) throw new Error(`unknown committee ${name}`);
  const next = decodePublisherSetData(readFileSync(nextFile, "utf8").trim() as Hex);
  const bundle = (f: string) => toSignatureBundle(JSON.parse(readFileSync(f, "utf8")) as IndexedSignature[]);
  if (needsProofOfPossession(operation) && !popFile) throw new Error(`${opName} requires --pop`);
  const tx = await governCommittee({
    client: ctx.client,
    deployment,
    committee: committee.typeScript,
    operation,
    next,
    authorization: bundle(authFile),
    ...(needsProofOfPossession(operation) ? { proofOfPossession: bundle(popFile!) } : {}),
  });
  const txHash = await send(ctx, tx, `${opName} ${name}`);
  if (!txHash) return;
  if (needsProofOfPossession(operation)) ctx.record.addRotation(name, { setIndex: next.current.setIndex, publishers: next.current.pubkeys.length, txHash, at: now() });
  publishToSdk(ctx);
}

/** The record, checked against the chain. */
export async function show(ctx: Context): Promise<void> {
  const record = ctx.record.read();
  log("deployer", { address: await ctx.signer.getRecommendedAddress(), balance: ckb(await balance(ctx)) });
  for (const contract of CONTRACTS) {
    const entry = record.contracts[contract];
    if (!entry) {
      log("contract", { contract, deployed: false });
      continue;
    }
    for (const [version, code] of Object.entries(entry.versions)) {
      const live = Boolean(await ctx.client.getCellLive(code.cellDep.outPoint, false));
      log("contract", { contract, version: Number(version), current: Number(version) === entry.current, codeHash: code.codeHash, live });
    }
  }
  for (const [name, c] of Object.entries(record.committees)) {
    const cell = await findCommitteeCell(ctx.client, c.typeScript);
    log("committee", { name, typeHash: c.typeHash, live: cell?.outPoint ?? null, setIndex: cell?.data.current.setIndex, pubkeys: cell?.data.current.pubkeys });
  }
}

/** Preflight for an action: config, key, binaries, record prerequisites, balance. */
export async function validate(network: string, target: string, name: string | undefined, contextOf: () => Context): Promise<boolean> {
  const lines: [boolean, string][] = [];
  const check = (ok: boolean, message: string) => lines.push([ok, message]);
  let ctx: Context | undefined;
  try {
    loadConfig(network);
    check(true, `config/${network}.json`);
    ctx = contextOf();
    check(true, `deployer key (${await ctx.signer.getRecommendedAddress()})`);
  } catch (error) {
    check(false, error instanceof Error ? error.message : String(error));
  }
  if (ctx) {
    if (target === "deploy:code") {
      for (const contract of CONTRACTS) check(existsSync(resolve(REPO_ROOT, ctx.config.binaries[contract])), `binary ${ctx.config.binaries[contract]}`);
    }
    if (target === "deploy:committee" || target === "rotate:committee") {
      const record: DeploymentRecord = ctx.record.read();
      check(Boolean(record.contracts.priceFeedType && record.contracts.publisherSetType), "contracts deployed");
      if (name) {
        const intent = ctx.config.committees[name];
        check(Boolean(intent), `committee ${name} in config`);
        if (target === "deploy:committee") {
          check(!record.committees[name], `committee ${name} not deployed yet`);
          check(Boolean(intent && intent.pubkeys.length >= 1 && intent.pubkeys.length <= 9), `committee ${name}: 1 to 9 public keys`);
        }
      } else check(false, "--name is required");
    }
    try {
      const have = await balance(ctx);
      check(have > 0n, `balance ${ckb(have)}`);
    } catch (error) {
      check(false, `RPC ${ctx.config.rpcUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const [ok, message] of lines) process.stdout.write(`${ok ? "OK  " : "FAIL"} ${message}\n`);
  return lines.every(([ok]) => ok);
}

/** After a broadcast on a public network, refresh the SDK presets so the next SDK build carries it. */
function publishToSdk(ctx: Context): void {
  if (ctx.network === "devnet") return;
  try {
    ctx.record.deployment();
  } catch (error) {
    log("sync_skipped", { reason: error instanceof Error ? error.message : String(error) });
    return;
  }
  syncPresets();
}

/** Embed public deployment records (testnet, mainnet) into the SDK presets. */
export function syncPresets(): void {
  const records: Record<string, DeploymentRecord> = {};
  for (const network of ["testnet", "mainnet"]) {
    const path = resolve(REPO_ROOT, "deployments", `${network}.json`);
    if (existsSync(path)) records[network] = JSON.parse(readFileSync(path, "utf8")) as DeploymentRecord;
  }
  const out = resolve(REPO_ROOT, "packages/sdk/src/presets/deployments.generated.ts");
  writeFileSync(
    out,
    `// Generated by \`npm run sync:presets -w lean-oracle-deploy\` from deployments/<network>.json.
// Do not edit by hand.
import type { DeploymentRecord } from "./deployment.js";

export const DEPLOYMENT_RECORDS: Partial<Record<"testnet" | "mainnet", DeploymentRecord>> = ${JSON.stringify(records, null, 2)};
`,
  );
  log("synced", { networks: Object.keys(records), file: out });
}
