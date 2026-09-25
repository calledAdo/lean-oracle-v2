// Lean Oracle example: a price-triggered release, end to end on CKB testnet.
//
//   1. deploy the example lock (`examples/price_trigger_lock`) once; its cell dep is cached in
//      deployment.testnet.json
//   2. a feed cell for BTC/USDT (created once, reused; `feed.testnet.json`)
//   3. lock 250 CKB: "release to the beneficiary once BTC/USDT >= strike" (strike = 1% below now)
//   4. move the feed cell to a fresh signed price from the mirror (published after step 3)
//   5. a keeper (not the owner) releases the funds: feed cell as a cell dep, and the header of the
//      block that created the locked cell as a header dep, so the lock can prove the price is newer
//
// Usage: LEAN_KEY_FILE=<funded testnet key> node index.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

import { ccc } from "@ckb-ccc/core";
import { LeanOracleTestnetClient } from "lean-oracle-sdk/client";
import { feedId } from "lean-oracle-sdk/protocol";
import { completeFeeAndChange } from "lean-oracle-sdk/tx";

const FEED = "Crypto.BTC/USDT";
const LOCKED = ccc.fixedPointFrom(250); // the lock args make the cell occupy 214 CKB
const here = (f) => new URL(f, import.meta.url);
const log = (step, detail) => console.log(`[${step}]`, detail);

const oracle = new LeanOracleTestnetClient();
const client = oracle.cccClient;
const keeper = new ccc.SignerCkbPrivateKey(client, readFileSync(process.env.LEAN_KEY_FILE, "utf8").trim());
// Owner and beneficiary are fresh keys: the keeper holds neither, so it can only use the price path.
const owner = new ccc.SignerCkbPrivateKey(client, ccc.hexFrom(randomBytes(32)));
const beneficiary = new ccc.SignerCkbPrivateKey(client, ccc.hexFrom(randomBytes(32)));

async function send(tx, step) {
  await completeFeeAndChange(tx, keeper, { feeRate: 1000n });
  const hash = await keeper.sendTransaction(tx);
  await client.waitTransaction(hash, 1, 300_000);
  log(step, hash);
  return hash;
}

// 1. Example lock code.
let code = existsSync(here("deployment.testnet.json")) && JSON.parse(readFileSync(here("deployment.testnet.json"), "utf8"));
if (!code || !(await client.getCellLive(code.cellDep.outPoint, false))) {
  const binary = readFileSync(here("../../target/riscv64imac-unknown-none-elf/release/price_trigger_lock"));
  const lock = (await keeper.getRecommendedAddressObj()).script;
  const tx = ccc.Transaction.from({ outputs: [{ lock }], outputsData: [ccc.hexFrom(binary)] });
  tx.outputs[0].capacity = ccc.fixedPointFrom(tx.outputs[0].occupiedSize + binary.length);
  const txHash = await send(tx, "deploy lock code");
  code = { codeHash: ccc.hashCkb(binary), hashType: "data2", cellDep: { outPoint: { txHash, index: 0 }, depType: "code" } };
  writeFileSync(here("deployment.testnet.json"), `${JSON.stringify(code, null, 2)}\n`);
}
log("lock code", code.codeHash);

// 2. Our feed cell.
let feedType = existsSync(here("feed.testnet.json")) && JSON.parse(readFileSync(here("feed.testnet.json"), "utf8"));
if (!feedType || !(await oracle.getFeedCell(feedType))) {
  const created = await oracle.createFeedCell({ signer: keeper, feed: FEED, committee: "majors" });
  await send(created.tx, "create feed cell");
  feedType = created.typeScript;
  writeFileSync(here("feed.testnet.json"), `${JSON.stringify(feedType, null, 2)}\n`);
}
const feedTypeHash = ccc.Script.from(feedType).hash();

// 3. Lock 250 CKB: release when BTC/USDT >= 99% of the current price (so this run triggers).
const [now] = await oracle.latestPrices([FEED], "majors");
const strike = (now.price * 99n) / 100n;
const le = (value, bytes) => { const b = new Uint8Array(bytes); new DataView(b.buffer).setBigInt64(0, BigInt(value), true); return b.slice(0, bytes); };
const i32 = (value) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, value, true); return b; };
const ownerLock = (await owner.getRecommendedAddressObj()).script;
const beneficiaryLock = (await beneficiary.getRecommendedAddressObj()).script;
const args = ccc.bytesConcat(
  feedTypeHash, oracle.committee("majors").typeHash, feedId(FEED),
  le(strike, 8), i32(now.expo), Uint8Array.of(0), ownerLock.hash(), beneficiaryLock.hash(),
);
const triggerLock = ccc.Script.from({ codeHash: code.codeHash, hashType: "data2", args: ccc.hexFrom(args) });
const lockTx = ccc.Transaction.from({ outputs: [{ lock: triggerLock, capacity: LOCKED }], outputsData: ["0x"] });
const lockHash = await send(lockTx, `lock 250 CKB until ${FEED} >= ${Number(strike) / 1e8}`);
const lockBlock = (await client.getTransaction(lockHash)).blockHash;
const lockedAt = (await client.getHeaderByHash(lockBlock)).timestamp;

// 4. A fresh signed price (published after the lock's block).
let update;
for (;;) {
  update = await oracle.pullAndUpdate(feedType);
  if (update.after.publishTimeMs > lockedAt) break;
  await new Promise((r) => setTimeout(r, 1000));
}
await send(update.tx, `feed cell -> ${Number(update.after.price) / 1e8} at ${update.after.publishTimeMs} (lock block ${lockedAt})`);

// 5. The keeper releases the funds to the beneficiary.
const feedCell = await oracle.getFeedCell(feedType);
const release = ccc.Transaction.from({
  inputs: [{ previousOutput: { txHash: lockHash, index: 0 } }],
  outputs: [{ lock: beneficiaryLock, capacity: LOCKED }],
  outputsData: ["0x"],
  headerDeps: [lockBlock],
});
release.addCellDeps({ outPoint: code.cellDep.outPoint, depType: "code" }, { outPoint: feedCell.outPoint, depType: "code" });
await send(release, "released to beneficiary");
log("beneficiary balance", `${ccc.fixedPointToString(await beneficiary.getBalance())} CKB`);
process.exit(0);
