#!/usr/bin/env node
//! lean-oracle-publisher
//!   run --config <publisher.json>                 run the publisher
//!   keygen                                         print a new private key and its public key
//!   pubkey --key <file>                            print the public key of a key file
//!   sign-config --config <committee-config.json> --key <file> --set <publisher-set.hex> [--probe <s>] [--doh]
//!                                                  validate the config (refuses an invalid one), optionally watch every
//!                                                  listed market live for <s> seconds and warn about silent ones, then
//!                                                  print this publisher's approval ({ publisherIndex, signature });
//!                                                  append it to the config file's `signatures` list
//!
//! Committee rotation (each operator runs these on its own machine; see governance.ts):
//!   fetch-set --operator <publisher.json>          print the committee cell's current set (0x-hex) from CKB
//!   show-set --set <set.hex> [--key <file>]        print a set for review
//!   next-set --set <current.hex> [--add <pubkey>]... [--remove <pubkey>]...
//!                                                  print the next set (0x-hex); the change goes to stderr
//!   sign-rotation --set <current.hex> --next <next.hex> (--key <file> | --operator <publisher.json>)
//!                                                  a current member's authorization of the rotation
//!   sign-pop --next <next.hex> (--key <file> | --operator <publisher.json>)
//!                                                  a next-set member's proof of possession of its key
//!   merge-signatures <file>...                     merge operators' signatures into one list
//!   add-approval --file <configs/vN.json> --set <next.hex> <signature file>...
//!                                                  record the next set's approval of a config (sign it with
//!                                                  sign-config --set <next.hex>) so it stays valid after rotation
//!   rotation-status --set <current.hex> --next <next.hex> --authorization <file> --pop <file>
//!                                                  which signatures are still missing

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { bytesToHex, committeeConfigHash, validateCommitteeConfig, verifyCommitteeConfig, decodePublisherSetData, encodePublisherSetData, type CommitteeConfig, type Hex, type PublisherSetData } from "lean-oracle-sdk/protocol";
import { publicKeyOf, signCommitteeConfig } from "lean-oracle-sdk/publisher";

import { startApi } from "./api.js";
import { fetchCommitteeData } from "./chain.js";
import { loadConfig, loadConfigDir } from "./config.js";
import { parseDecimal } from "./fixed.js";
import { MarketData } from "./marketData.js";
import { PublisherNode } from "./node.js";
import { TickScheduler } from "./scheduler.js";
import { emitMockQuotes, mockMarketsFor } from "./sources/mock.js";
import { exchangeLookup } from "./net/resolver.js";
import { SourceManager } from "./sources/manager.js";
import { PublisherStore } from "./store.js";
import { WsTransport } from "./wsTransport.js";
import { FileKeySigner, createKeySigner, type KeySigner } from "./keySigner.js";
import { describeSet, diffSets, mergeSignatures, nextSet, rotationStatus, signProofOfPossession, signRotation } from "./governance.js";
import { ShadowRunner } from "./shadow.js";
import type { ConfigFile, OperatorConfig } from "./config.js";
import type { IndexedSignature } from "lean-oracle-sdk/protocol";
import { dirname, resolve } from "node:path";

const log = (event: string, detail: Record<string, unknown> = {}) =>
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...detail })}\n`);

async function run(configPath: string): Promise<void> {
  const c = await loadConfig(configPath);
  if (c.operator.shadow) return runShadow(c);
  const store = new PublisherStore(join(c.operator.dataDir, "publisher.sqlite"), c.operator.committee.publisherSetTypeHash);
  const marketData = new MarketData();
  const transport = new WsTransport({
    selfIndex: c.index,
    signer: c.signer,
    set: c.publisherSet.current,
    host: c.operator.listen.host,
    port: c.operator.listen.port,
    peers: c.peers,
    log,
  });
  const node = new PublisherNode({
    index: c.index,
    signer: c.signer,
    publisherSetTypeHash: c.operator.committee.publisherSetTypeHash,
    publisherSet: c.publisherSet,
    schedule: c.schedule,
    store,
    transport,
    marketData,
    log,
  });

  const stops: (() => void)[] = [];
  startSources(c, marketData, stops);

  const scheduler = new TickScheduler(node, c.schedule);
  scheduler.start();
  const api = startApi(c.operator.api.host, c.operator.api.port, store, () => ({
    publisherIndex: c.index,
    setIndex: c.publisherSet.current.setIndex,
    activeConfig: c.schedule.at(BigInt(Date.now()))?.config.version ?? null,
    configVersions: c.schedule.all().map((v) => ({ version: v.config.version, activationTickMs: v.config.activationTickMs, hash: v.hash })),
    connectedPeers: transport.connectedPeers(),
  }));
  log("publisher.started", { index: c.index, publicKey: c.signer.publicKey, publishers: c.publisherSet.current.pubkeys.length, configVersions: c.schedule.all().map((v) => v.config.version) });

  // Re-read the committee cell: on rotation or pause, exit so the container restarts with the new set.
  const chain = c.operator.committee.chain;
  if (chain) {
    const current = encodeSet(c.publisherSet);
    const timer = setInterval(async () => {
      try {
        const { data } = await fetchCommitteeData(chain.rpcUrl, chain.typeScript);
        if (encodeSet(data) !== current) {
          log("committee.changed", { setIndex: data.current.setIndex, flags: data.governanceFlags });
          await shutdown(3);
        }
      } catch (error) {
        log("committee.read_failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }, 15_000);
    stops.push(() => clearInterval(timer));
  }

  const shutdown = async (code = 0) => {
    log("publisher.stopping");
    scheduler.stop();
    for (const stop of stops) stop();
    api.close();
    await transport.close();
    store.close();
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}


type Loaded = Awaited<ReturnType<typeof loadConfig>>;

/** Exchange connections (or mock quotes) for every held config version, and pick-up of new versions. */
function startSources(c: Loaded, marketData: MarketData, stops: (() => void)[]): void {
  const allConfigs = () => c.schedule.all().map((v) => v.config);
  if (c.operator.mockSource) {
    const prices = Object.fromEntries(Object.entries(c.operator.mockSource.prices).map(([k, v]) => [k, parseDecimal(v)]));
    const timer = setInterval(() => {
      const markets = allConfigs().flatMap((config) => mockMarketsFor(config, prices));
      emitMockQuotes(marketData, markets, Date.now(), c.operator.mockSource!.skewBps);
    }, 250);
    stops.push(() => clearInterval(timer));
    log("source.mock");
  } else {
    const sources = new SourceManager(marketData, log, exchangeLookup(c.operator.network?.dns));
    sources.sync(allConfigs());
    stops.push(() => sources.stop());
    // Pick up newly approved config versions and subscribe to any new markets.
    const timer = setInterval(() => {
      const added = loadConfigDir(c.operator.committee.configDir, c.schedule, log);
      if (added.length > 0) {
        log("config.added", { versions: added });
        sources.sync(allConfigs());
      }
    }, 15_000);
    stops.push(() => clearInterval(timer));
  }

}

/** Shadow mode: price every feed like a member, sign nothing, compare with the committee's updates. */
async function runShadow(c: Loaded): Promise<void> {
  const marketData = new MarketData();
  const stops: (() => void)[] = [];
  startSources(c, marketData, stops);
  const shadow = new ShadowRunner({
    schedule: c.schedule,
    marketData,
    publisherSetTypeHash: c.operator.committee.publisherSetTypeHash,
    referenceUrl: c.operator.shadow!.referenceUrl,
    api: c.operator.api,
    log,
  });
  shadow.start();
  log("shadow.started", {
    publicKey: c.signer.publicKey,
    member: c.index >= 0,
    reference: c.operator.shadow!.referenceUrl,
    configVersions: c.schedule.all().map((v) => v.config.version),
  });
  const shutdown = () => {
    log("shadow.stopping", { feeds: shadow.report() });
    shadow.stop();
    for (const stop of stops) stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const encodeSet = (data: PublisherSetData) => bytesToHex(encodePublisherSetData(data));

const readKey = (path: string) => readFileSync(path, "utf8").trim() as Hex;

/** Watch every market in `config` for `seconds`; return the ones that delivered no quote. */
async function probeMarkets(config: CommitteeConfig, seconds: number, doh: boolean): Promise<string[]> {
  const heard = new Set<string>();
  const sink = { quote: (venue: string, market: string) => void heard.add(`${venue} ${market}`), trade: () => {}, alive: () => {} };
  const sources = new SourceManager(sink, () => {}, doh ? exchangeLookup({ mode: "doh" }) : undefined);
  sources.sync([config]);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  sources.stop();
  return config.feeds.flatMap((feed) => feed.markets.filter((m) => !heard.has(`${m.venue} ${m.market}`)).map((m) => `${feed.symbol}: ${m.venue} ${m.market}`));
}

async function signConfig(values: { config?: string; key?: string; set?: string; probe?: string; doh?: boolean }): Promise<void> {
  if (!values.config || !values.key || !values.set) throw new Error("sign-config requires --config, --key and --set");
  const config = JSON.parse(readFileSync(values.config, "utf8")) as CommitteeConfig;
  const problems = validateCommitteeConfig(config);
  if (problems.length > 0) throw new Error(`refusing to sign an invalid config:\n  ${problems.join("\n  ")}`);
  if (values.probe) {
    const silent = await probeMarkets(config, Number(values.probe), values.doh ?? false);
    // A warning, not a refusal: a market may be unreachable only from this operator's network.
    for (const market of silent) process.stderr.write(`warning: no data from ${market}\n`);
  }
  const key = readKey(values.key);
  const set = decodePublisherSetData(readFileSync(values.set, "utf8").trim() as Hex);
  const index = set.current.pubkeys.indexOf(publicKeyOf(key));
  if (index < 0) throw new Error("key is not in the publisher set");
  const signature = signCommitteeConfig(config, key, index);
  process.stdout.write(`${JSON.stringify({ configHash: committeeConfigHash(config), ...signature }, null, 2)}\n`);
}

const readSet = (path: string) => decodePublisherSetData(readFileSync(path, "utf8").trim() as Hex);
const readSignatures = (path: string): IndexedSignature[] => {
  const raw = JSON.parse(readFileSync(path, "utf8")) as IndexedSignature | IndexedSignature[] | { signatures: IndexedSignature[] };
  const list = Array.isArray(raw) ? raw : "signatures" in raw ? raw.signatures : [raw];
  return list.map((s) => ({ publisherIndex: s.publisherIndex, signature: s.signature }));
};
const json = (value: unknown) => `${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`;

function readOperator(path: string): { operator: OperatorConfig; base: string } {
  return { operator: JSON.parse(readFileSync(path, "utf8")) as OperatorConfig, base: dirname(resolve(path)) };
}

/** The signing key: a key file, or the operator config's key (file or AWS KMS). */
async function signerFrom(values: { key?: string; operator?: string }): Promise<KeySigner> {
  if (values.key) return new FileKeySigner(values.key);
  if (values.operator) {
    const { operator, base } = readOperator(values.operator);
    return createKeySigner(operator.key.type === "file" ? { ...operator.key, path: resolve(base, operator.key.path) } : operator.key);
  }
  throw new Error("pass --key <file> or --operator <publisher.json>");
}

type Values = { file?: string; set?: string; next?: string; key?: string; operator?: string; add?: string[]; remove?: string[]; authorization?: string; pop?: string };

async function governance(command: string, values: Values, positionals: string[]): Promise<void> {
  switch (command) {
    case "fetch-set": {
      if (!values.operator) throw new Error("fetch-set requires --operator <publisher.json>");
      const chain = readOperator(values.operator).operator.committee.chain;
      if (!chain) throw new Error("the operator config has no committee.chain");
      const { data } = await fetchCommitteeData(chain.rpcUrl, chain.typeScript);
      process.stderr.write(json(describeSet(data)));
      process.stdout.write(`${encodeSet(data)}\n`);
      return;
    }
    case "show-set": {
      if (!values.set) throw new Error("show-set requires --set");
      const self = values.key ? new FileKeySigner(values.key).publicKey : undefined;
      process.stdout.write(json(describeSet(readSet(values.set), self)));
      return;
    }
    case "next-set": {
      if (!values.set) throw new Error("next-set requires --set");
      const current = readSet(values.set);
      const next = nextSet(current, values.add, values.remove);
      process.stderr.write(json(diffSets(current, next)));
      process.stdout.write(`${encodeSet(next)}\n`);
      return;
    }
    case "sign-rotation": {
      if (!values.set || !values.next) throw new Error("sign-rotation requires --set and --next");
      const current = readSet(values.set);
      const next = readSet(values.next);
      process.stderr.write(json({ signing: "rotation", ...diffSets(current, next) }));
      process.stdout.write(json(await signRotation(current, next, await signerFrom(values))));
      return;
    }
    case "sign-pop": {
      if (!values.next) throw new Error("sign-pop requires --next");
      process.stdout.write(json(await signProofOfPossession(readSet(values.next), await signerFrom(values))));
      return;
    }
    case "merge-signatures": {
      if (positionals.length === 0) throw new Error("merge-signatures needs one or more signature files");
      process.stdout.write(json(mergeSignatures(positionals.map(readSignatures))));
      return;
    }
    case "add-approval": {
      if (!values.file || !values.set || positionals.length === 0) throw new Error("add-approval requires --file, --set and signature files");
      const set = readSet(values.set);
      const file = JSON.parse(readFileSync(values.file, "utf8")) as ConfigFile;
      const signatures = mergeSignatures(positionals.map(readSignatures));
      if (!verifyCommitteeConfig({ config: file.config, signatures }, set.current)) throw new Error(`these signatures are not a quorum of set ${set.current.setIndex} for config v${file.config.version}`);
      file.approvals = [...(file.approvals ?? []).filter((a) => a.setIndex !== set.current.setIndex), { setIndex: set.current.setIndex, signatures }];
      writeFileSync(values.file, json(file));
      process.stderr.write(`config v${file.config.version}: approval by set ${set.current.setIndex} recorded (${signatures.length} signatures)\n`);
      return;
    }
    case "rotation-status": {
      if (!values.set || !values.next) throw new Error("rotation-status requires --set and --next");
      const auth = values.authorization ? readSignatures(values.authorization) : [];
      const pop = values.pop ? readSignatures(values.pop) : [];
      process.stdout.write(json(rotationStatus(readSet(values.set), readSet(values.next), auth, pop)));
      return;
    }
  }
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      key: { type: "string" },
      set: { type: "string" },
      probe: { type: "string" },
      doh: { type: "boolean" },
      operator: { type: "string" },
      next: { type: "string" },
      add: { type: "string", multiple: true },
      remove: { type: "string", multiple: true },
      authorization: { type: "string" },
      pop: { type: "string" },
      file: { type: "string" },
    },
  });
  switch (command) {
    case "run":
      if (!values.config) throw new Error("run requires --config");
      return void run(values.config).catch((error) => {
        log("publisher.fatal", { error: error instanceof Error ? error.message : String(error) });
        process.exit(1);
      });
    case "keygen": {
      const key = bytesToHex(randomBytes(32));
      process.stdout.write(`${JSON.stringify({ privateKey: key, publicKey: publicKeyOf(key) }, null, 2)}\n`);
      return;
    }
    case "pubkey":
      if (!values.key) throw new Error("pubkey requires --key");
      process.stdout.write(`${publicKeyOf(readKey(values.key))}\n`);
      return;
    case "sign-config":
      return void signConfig(values).catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      });
    case "fetch-set":
    case "show-set":
    case "next-set":
    case "sign-rotation":
    case "sign-pop":
    case "merge-signatures":
    case "rotation-status":
    case "add-approval":
      return void governance(command, values, positionals).catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      });
    default:
      process.stderr.write("usage: lean-oracle-publisher <run|keygen|pubkey|sign-config|fetch-set|show-set|next-set|sign-rotation|sign-pop|merge-signatures|add-approval|rotation-status> [options]\n");
      process.exit(2);
  }
}

main();
