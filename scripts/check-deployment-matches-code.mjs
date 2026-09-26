#!/usr/bin/env node
// Fails unless deployments/<network>.json's current contracts are the ones this source builds
// (contracts/checksums.txt). Run before publishing images or the SDK, so nothing built from a newer
// format ships while the network still runs older contracts.
//   node scripts/check-deployment-matches-code.mjs [network]   (default: testnet)
import { readFileSync } from "node:fs";

const network = process.argv[2] ?? "testnet";
const root = new URL("..", import.meta.url);
const record = JSON.parse(readFileSync(new URL(`deployments/${network}.json`, root), "utf8"));
const built = Object.fromEntries(
  readFileSync(new URL("contracts/checksums.txt", root), "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(/\s+/))
    .map(([name, hash]) => [name, hash.toLowerCase()]),
);
const pairs = { priceFeedType: "price_feed_type", publisherSetType: "publisher_set_type" };
let ok = true;
for (const [contract, binary] of Object.entries(pairs)) {
  const entry = record.contracts?.[contract];
  const deployed = entry?.versions?.[String(entry.current)]?.codeHash?.toLowerCase();
  const match = deployed === built[binary];
  ok &&= match;
  console.log(`${network} ${contract}: deployed ${deployed ?? "none"} / built ${built[binary]} ${match ? "OK" : "MISMATCH"}`);
}
if (!ok) {
  console.error(`${network} does not run the contracts this source builds: redeploy ${network} (and update deployments/${network}.json) before publishing.`);
  process.exit(1);
}
