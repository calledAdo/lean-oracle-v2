// A local committee of in-process publishers wired through InMemoryHub.
import * as p from "lean-oracle-sdk/protocol";
import * as pub from "lean-oracle-sdk/publisher";

import { parseDecimal } from "../dist/fixed.js";
import { MarketData } from "../dist/marketData.js";
import { ConfigSchedule } from "../dist/configSchedule.js";
import { PublisherNode } from "../dist/node.js";
import { emitMockQuotes, mockMarketsFor } from "../dist/sources/mock.js";
import { PublisherStore } from "../dist/store.js";
import { InMemoryHub } from "../dist/transport.js";

export const SET_TYPE_HASH = `0x${"5e".repeat(32)}`;
export const T0 = 1_700_000_000_000;

const markets = (list) => list.map(([venue, market]) => ({ venue, market }));
const method = { method: "mid", windowMs: 2000, maxQuoteAgeMs: 2000, maxSpreadBps: 50 };

export function committeeConfig() {
  const feeds = [
    ["Crypto.BTC/USD", [["coinbase", "BTC-USD"], ["kraken", "BTC/USD"], ["bitstamp", "btcusd"]]],
    ["Crypto.BTC/USDT", [["binance", "BTCUSDT"], ["okx", "BTC-USDT"], ["bybit", "BTCUSDT"]]],
    ["Crypto.USDT/USD", [["coinbase", "USDT-USD"], ["kraken", "USDT/USD"], ["bitstamp", "usdtusd"]]],
  ].map(([symbol, list]) => ({
    symbol, quote: symbol.split("/")[1], feedId: p.feedId(symbol), expo: -8, toleranceBps: 50, emaHalfLifeMs: 3_600_000, ...method,
    minVenues: 2, markets: markets(list),
  })).sort((a, b) => (a.feedId < b.feedId ? -1 : 1));
  return {
    version: 1, committee: "majors", publisherSetTypeHash: SET_TYPE_HASH, activationTickMs: String(T0),
    tickPeriodMs: 1000, observationDeadlineMs: 400, maxSigningLagMs: 3000,
    feeds,
  };
}

export const BASE = {
  "Crypto.BTC/USD": parseDecimal("65000"), "Crypto.BTC/USDT": parseDecimal("65020"), "Crypto.USDT/USD": parseDecimal("1.0001"),
};

/** In-memory signer with the KeySigner interface. */
export const memorySigner = (key) => ({ publicKey: pub.publicKeyOf(key), sign: async (digest) => pub.signDigest(digest, key) });

/** Every publisher approves `config` (a quorum is all that is needed; all is simplest). */
export const approve = (config, keysInOrder) => ({ config, signatures: pub.toSignatureBundle(keysInOrder.map((key, i) => pub.signCommitteeConfig(config, key, i))) });

export function makeCommittee(n, { skews = [], configs = [] } = {}) {
  const privateKeys = Array.from({ length: n }, (_, i) => `0x${(i + 1).toString(16).padStart(2, "0").repeat(32)}`);
  const ordered = privateKeys.map((key) => ({ key, pubkey: pub.publicKeyOf(key) })).sort((a, b) => (a.pubkey < b.pubkey ? -1 : 1));
  const publisherSet = { networkId: `0x${"aa".repeat(32)}`, governanceNonce: 0n, governanceFlags: 0, minRotationIntervalS: 86_400n, current: { setIndex: 0, pubkeys: ordered.map((o) => o.pubkey) } };
  const config = committeeConfig();
  const configHash = p.committeeConfigHash(config);
  const keysInOrder = ordered.map((o) => o.key);
  const hub = new InMemoryHub();
  const clock = { now: T0 };
  const events = [];
  const mocks = [config, ...configs].flatMap((c) => mockMarketsFor(c, BASE));
  const nodes = ordered.map(({ key }, index) => {
    const marketData = new MarketData();
    const store = new PublisherStore(":memory:", SET_TYPE_HASH);
    const schedule = new ConfigSchedule(SET_TYPE_HASH, publisherSet.current);
    for (const c of [config, ...configs]) schedule.add(approve(c, keysInOrder));
    const node = new PublisherNode({
      index, signer: memorySigner(key), publisherSetTypeHash: SET_TYPE_HASH, publisherSet, schedule, store,
      transport: hub.transport(index), marketData, now: () => clock.now,
      log: (event, detail) => events.push({ index, event, ...detail }),
    });
    return { node, store, marketData, skew: skews[index] ?? 0 };
  });

  async function runTick(tickMs, { down = [] } = {}) {
    for (let i = 0; i < n; i++) hub.setDown(i, down.includes(i));
    const live = nodes.filter((_, i) => !down.includes(i));
    clock.now = tickMs;
    for (const x of live) emitMockQuotes(x.marketData, mocks, tickMs - 100, x.skew);
    await Promise.all(live.map((x) => x.node.observe(BigInt(tickMs))));
    await hub.settle();
    clock.now = tickMs + 100;
    await Promise.all(live.map((x) => x.node.maybePropose(BigInt(tickMs))));
    await hub.settle();
    for (let rank = 1; rank <= nodes[0].node.maxRank; rank++) {
      clock.now = tickMs + rank * config.observationDeadlineMs;
      for (let call = 0; call < 2; call++) {
        await Promise.all(live.map((x) => x.node.maybePropose(BigInt(tickMs))));
        await hub.settle();
      }
    }
  }

  return { nodes, publisherSet, config, configHash, keysInOrder, hub, clock, events, runTick };
}
