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

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { bytesToHex, committeeConfigHash, validateCommitteeConfig, decodePublisherSetData, encodePublisherSetData, type CommitteeConfig, type Hex, type PublisherSetData } from "lean-oracle-sdk/protocol";
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

const log = (event: string, detail: Record<string, unknown> = {}) =>
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...detail })}\n`);

async function run(configPath: string): Promise<void> {
  const c = await loadConfig(configPath);
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

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({ args: rest, options: { config: { type: "string" }, key: { type: "string" }, set: { type: "string" }, probe: { type: "string" }, doh: { type: "boolean" } } });
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
    default:
      process.stderr.write("usage: lean-oracle-publisher <run|keygen|pubkey|sign-config> [options]\n");
      process.exit(2);
  }
}

main();
