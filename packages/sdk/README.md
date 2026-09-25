# lean-oracle-sdk

TypeScript SDK for **Lean Oracle**, a pull price oracle for [Nervos CKB](https://www.nervos.org/).

A committee of publishers signs prices every tick (1 s for majors, 2 s for CKB). Prices are
Merkle-batched and quorum-signed, and served by public mirrors. Any project moves its **own** feed
cell forward with a signed update; the on-chain script verifies the committee's signatures, so no
one has to be trusted to relay prices.

> **1.x replaces 0.x.** `lean-oracle-sdk` 0.x (Pyth/Hermes-based) is a different protocol and is not
> compatible. See [Migrating from 0.x](#migrating-from-0x).

## Install

```bash
npm install lean-oracle-sdk @ckb-ccc/core
```

`@ckb-ccc/core` is an optional peer dependency. It is only needed for the chain-facing entry points
(`/client`, `/ckb`, `/tx`). Reading and verifying prices (`/mirror`, `/protocol`) works without it,
in browsers and Node ≥ 20.

## Quick start (testnet)

```ts
import { LeanOracleTestnetClient } from "lean-oracle-sdk/client";

const oracle = new LeanOracleTestnetClient();

// Latest prices from the mirror, verified against the live committee cell.
const prices = await oracle.latestPrices(["Crypto.BTC/USDT", "Crypto.ETH/USDT"], "majors");
for (const p of prices) console.log(p.feedId, p.price, p.expo, p.publishTimeMs);
```

Put a price on chain with your own feed cell:

```ts
import { ccc } from "@ckb-ccc/core";
import { LeanOracleTestnetClient } from "lean-oracle-sdk/client";

const oracle = new LeanOracleTestnetClient();
const signer = new ccc.SignerCkbPrivateKey(oracle.cccClient, privateKey);
const send = async (tx: ccc.Transaction) => {
  const result = await oracle.completeFee(tx, signer); // largest plain cells first, exact fee
  if (result.status === "insufficient") throw new Error(`need ${result.shortfall} more shannons`);
  return signer.sendTransaction(tx);
};

// Once: create a feed cell you own (Type ID unique; keep `typeScript`).
const { tx, typeScript } = await oracle.createFeedCell({ signer, feed: "Crypto.BTC/USDT", committee: "majors" });
await send(tx);

// Any time: move it forward to the latest signed price (or `{ atMs, exact: true }` for a settlement tick).
const update = await oracle.pullAndUpdate(typeScript);
await send(update.tx);
console.log(update.after.price, update.after.publishTimeMs);
```

Your contract reads the feed cell as a cell dep and checks `publish_time_ms` against its own
freshness rule. The oracle never decides freshness for you.

## Entry points

| Import | Contents | Needs CCC |
|---|---|---|
| `lean-oracle-sdk` | Consumer essentials: `feedId`, `verifyPriceUpdate`, decoders, `MirrorClient`, errors | no |
| `lean-oracle-sdk/client` | `LeanOracleClient`, `LeanOracleTestnetClient`, `LeanOracleMainnetClient`, network presets | yes |
| `lean-oracle-sdk/mirror` | `MirrorClient`: `latest`, `at`, `range`, `feeds`, `stream`; failover and verification | no |
| `lean-oracle-sdk/tx` | Unsigned transaction builders: feed cells, committees, `pullAndUpdate`, `completeFee` | yes |
| `lean-oracle-sdk/ckb` | Cell reads (`getFeedCell`, `findFeedCells`, `findCommitteeCell`), scripts, clients | yes |
| `lean-oracle-sdk/protocol` | Wire formats, hashing, Merkle proofs, signature checks | no |
| `lean-oracle-sdk/publisher` | Signing helpers for publishers | no |
| `lean-oracle-sdk/presets` | Deployment records, feed registry, network presets | no |

## Feeds

A feed ID is `ckb_hash("LEAN/FEED/V1" || symbol)`. Pass symbols or IDs anywhere a feed is expected.
Every feed is a **native pair**, priced only from markets that trade exactly that pair; derive other
pairs by combining feeds (for example CKB/USD = CKB/USDT × USDT/USD).

| Committee | Feeds | Exponent |
|---|---|---|
| `majors` (1 s) | BTC, ETH, SOL × /USD, /USDT, /USDC; USDT/USD | -8 |
| `ckb` (2 s) | CKB/USDT, CKB/USDC | -10 |

Each price carries `conf`, an EMA, `sourceTimeMs` and the number of publishers.

## Trust model

- Mirrors are **untrusted**. `MirrorClient` decodes every value from the signed update, never from
  the JSON convenience fields. With committee data (automatic in `LeanOracleClient`), it verifies
  the quorum signatures and Merkle proof before returning.
- The on-chain `price_feed_type` script repeats the same checks and only lets a feed cell move
  forward in time.
- A committee's keys can change only through a quorum-signed rotation of its committee cell.

## Networks

| Network | Status |
|---|---|
| testnet | Deployed. Mirror: `https://64-227-40-35.sslip.io`. Record: [`deployments/testnet.json`](https://github.com/calledAdo/lean-oracle-v2/blob/main/deployments/testnet.json) |
| mainnet | Not yet deployed |

## Migrating from 0.x

0.x relayed Pyth prices (Hermes, Wormhole guardian sets) into shared oracle cells. 1.x has its own
publisher committees and per-project feed cells. There is no drop-in upgrade path:

- `LeanOracleTestnetClient` still exists, now with `latestPrices`, `createFeedCell` and `pullAndUpdate`.
- Feed IDs are Lean Oracle IDs (`Crypto.BTC/USDT`), not Pyth IDs.
- Hermes and Wormhole modules are gone; use `/mirror`.
- Fee completion (`completeFee`) keeps the 0.x greedy strategy (largest plain cells first) and
  returns the shortfall instead of throwing.

## License

MIT
