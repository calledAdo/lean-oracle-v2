// Generate a complete local committee: keys, committee cell data, a committee config approved by
// every publisher, and one operator config per publisher.
//
//   node scripts/local-committee.mjs --template configs/majors.template.json --n 4 --out ./local [--mock]
//   node dist/main.js run --config ./local/publisher-0/publisher.json
//
// With --docker, each publisher-<i> directory is mounted at /config in a container named
// publisher-<i> on a shared Docker network (see README).
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

import * as p from "lean-oracle-sdk/protocol";
import * as pub from "lean-oracle-sdk/publisher";

const { values } = parseArgs({
  options: {
    template: { type: "string" }, n: { type: "string", default: "4" }, out: { type: "string", default: "./local" },
    mock: { type: "boolean", default: false }, docker: { type: "boolean", default: false }, doh: { type: "boolean", default: false },
    // Use existing keys and a deployed committee instead of generating them:
    keys: { type: "string" }, "key-file": { type: "string" }, "publisher-set-type-hash": { type: "string" },
    // Read the committee cell from CKB: node RPC URL and the committee type script as JSON.
    "chain-rpc": { type: "string" }, "committee-type-script": { type: "string" }, "base-port": { type: "string", default: "7700" }, host: { type: "string", default: "127.0.0.1" },
  },
});
const template = JSON.parse(readFileSync(values.template, "utf8"));
// --key-file: comma-separated key files (keeps keys off the command line).
if (values["key-file"]) values.keys = values["key-file"].split(",").map((f) => readFileSync(f, "utf8").trim()).join(",");
const n = values.keys ? values.keys.split(",").length : Number(values.n);
const basePort = Number(values["base-port"]);

const keys = (values.keys ? values.keys.split(",") : Array.from({ length: n }, () => p.bytesToHex(randomBytes(32))))
  .map((key) => ({ key, pubkey: pub.publicKeyOf(key) }))
  .sort((a, b) => (a.pubkey < b.pubkey ? -1 : 1));
const publisherSet = { networkId: `0x${"00".repeat(32)}`, governanceNonce: 0n, governanceFlags: 0, current: { setIndex: 0, pubkeys: keys.map((k) => k.pubkey) } };
// Until the committee cell is deployed, a placeholder committee id stands in for its type hash.
const publisherSetTypeHash = (values["publisher-set-type-hash"] ?? p.bytesToHex(randomBytes(32))).toLowerCase();
const chain = values["chain-rpc"] ? { rpcUrl: values["chain-rpc"], typeScript: JSON.parse(values["committee-type-script"]) } : undefined;

const period = template.tickPeriodMs;
const config = {
  version: 1,
  publisherSetTypeHash,
  activationTickMs: String(Math.floor(Date.now() / period) * period),
  ...template,
  feeds: template.feeds.map((f) => ({ ...f, feedId: p.feedId(f.symbol) })).sort((a, b) => (a.feedId < b.feedId ? -1 : 1)),
};
const problems = p.validateCommitteeConfig(config);
if (problems.length) throw new Error(problems.join("; "));
const signatures = keys.map(({ key }, i) => pub.signCommitteeConfig(config, key, i));

mkdirSync(values.out, { recursive: true });
writeFileSync(join(values.out, "publisher-set.hex"), `${p.bytesToHex(p.encodePublisherSetData(publisherSet))}\n`);
mkdirSync(join(values.out, "configs"), { recursive: true });
writeFileSync(join(values.out, "configs", `v${config.version}.json`), `${JSON.stringify({ config, signatures }, null, 2)}\n`);

const mockPrices = {
  "Crypto.BTC/USD": "65000", "Crypto.BTC/USDT": "65020", "Crypto.BTC/USDC": "65010",
  "Crypto.ETH/USD": "3200", "Crypto.ETH/USDT": "3201", "Crypto.ETH/USDC": "3200.5",
  "Crypto.SOL/USD": "150", "Crypto.SOL/USDT": "150.05", "Crypto.SOL/USDC": "150.02",
  "Crypto.USDT/USD": "0.9998",
  "Crypto.CKB/USDT": "0.001271", "Crypto.CKB/USDC": "0.001270",
};
keys.forEach(({ key }, i) => {
  const dir = join(values.out, `publisher-${i}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "publisher.key"), `${key}\n`, { mode: values.docker ? 0o644 : 0o600 });
  if (values.docker) {
    writeFileSync(join(dir, "publisher-set.hex"), `${p.bytesToHex(p.encodePublisherSetData(publisherSet))}\n`);
    mkdirSync(join(dir, "configs"), { recursive: true });
    writeFileSync(join(dir, "configs", `v${config.version}.json`), `${JSON.stringify({ config, signatures }, null, 2)}\n`);
  }
  const network = values.docker
    ? {
        dataDir: "/data",
        listen: { host: "0.0.0.0", port: 7700 },
        api: { host: "0.0.0.0", port: 7701 },
        peers: keys.map((k, j) => ({ pubkey: k.pubkey, url: `ws://publisher-${j}:7700` })).filter((_, j) => j !== i),
        committee: { publisherSetTypeHash, ...(chain ? { chain } : { publisherSetFile: "publisher-set.hex" }), configDir: "configs" },
      }
    : {
        dataDir: "data",
        listen: { host: values.host, port: basePort + i * 10 },
        api: { host: values.host, port: basePort + i * 10 + 1 },
        peers: keys.map((k, j) => ({ pubkey: k.pubkey, url: `ws://${values.host}:${basePort + j * 10}` })).filter((_, j) => j !== i),
        committee: {
          publisherSetTypeHash,
          publisherSetFile: relative(dir, join(values.out, "publisher-set.hex")),
          configDir: relative(dir, join(values.out, "configs")),
        },
      };
  const operator = {
    key: { type: "file", path: "publisher.key" },
    ...network,
    ...(values.doh ? { network: { dns: { mode: "doh" } } } : {}),
    ...(values.mock ? { mockSource: { skewBps: [0, 3, -3, 5, -5, 2, -2, 4, -4][i], prices: mockPrices } } : {}),
  };
  writeFileSync(join(dir, "publisher.json"), `${JSON.stringify(operator, null, 2)}\n`);
});
console.log(JSON.stringify({ out: values.out, publishers: n, publisherSetTypeHash, configHash: p.committeeConfigHash(config) }, null, 2));
