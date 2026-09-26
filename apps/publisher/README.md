# lean-oracle-publisher

The Lean Oracle publisher service, distributed **only as a Docker image**. Each committee operator
runs one. It records exchange data over websockets and signs an observation every tick. It takes
its turn as leader, and co-signs the committee's price update. Protocol details are in
[docs/oracle-design.md](../../docs/oracle-design.md) sections 3–5.

## Run

```sh
docker build -f apps/publisher/Dockerfile -t lean-oracle-publisher .
docker run -d --name publisher \
  -v $PWD/operator:/config:ro \
  -v publisher-data:/data \
  -p 7700:7700 -p 127.0.0.1:7701:7701 \
  lean-oracle-publisher
```

`/config` holds:
- `publisher.json`: the operator config (below);
- the key file;
- the committee cell data;
- the signed committee config.

`/data` holds the SQLite database: the double-sign guard and the finalized-update archive.
**It must persist across restarts and never be shared between publishers.**

## Operator config (`publisher.json`)

```json
{
  "key": { "type": "file", "path": "publisher.key" },
  "dataDir": "/data",
  "listen": { "host": "0.0.0.0", "port": 7700 },
  "api": { "host": "0.0.0.0", "port": 7701 },
  "peers": [{ "pubkey": "0x02…", "url": "wss://publisher-b.example.org" }],
  "committee": {
    "publisherSetTypeHash": "0x…",
    "chain": { "rpcUrl": "https://ckb-rpc.example.org", "typeScript": { "codeHash": "0x…", "hashType": "data2", "args": "0x…" } },
    "configDir": "configs"
  }
}
```

Paths are relative to the config file.

- **`key`.** Where the publisher key lives. `{ "type": "file", "path" }` points to a file holding a
  0x-hex private key. `{ "type": "aws-kms", "keyId", "region" }` uses an AWS KMS key with key spec
  `ECC_SECG_P256K1`, and the key never leaves KMS. The container needs AWS credentials in the usual
  way (environment variables or an instance role).
- **`committee.chain`.** The committee cell is read from CKB and re-checked every 15 s. On rotation or
  pause the publisher exits with code 3, so run the container with `--restart unless-stopped`.
  `publisherSetFile` (0x-hex cell data) replaces `chain` for development without a chain.
- **`committee.configDir`.** One JSON file per approved committee-config version:
  `{ "config", "signatures": [{ "publisherIndex", "signature" }] }`.
  - It is re-read every 15 s, so a new version can be dropped in ahead of its activation tick.
  - Each version applies from its `activationTickMs`. New markets are subscribed as soon as the
    version is loaded.
  - A version is accepted only if a quorum of the current set approved it and it follows the
    previous version in both number and activation.

- **`network.dns`** (optional). `{ "mode": "doh" }` resolves exchange hosts over DNS-over-HTTPS
  (default `https://1.1.1.1/dns-query`, which needs no DNS itself), with a timeout and a cache.
  - Use it when your ISP's resolvers block exchange domains. Blocked lookups otherwise hang, and
    also delay every other lookup in the process.
  - It applies only to exchange connections; peers and the CKB RPC use the system resolver.

Port 7700 is the peer WebSocket, which peers must be able to reach. Port 7701 is the HTTP API:
- `/health`: includes the active and known config versions;
- `/v1/finalized/latest`;
- `/v1/finalized/{tickMs}`;
- `/v1/finalized?after={tickMs}`.

## Commands

| Command | Purpose |
|---|---|
| `run --config publisher.json` | Run the publisher (the image default). |
| `keygen` | Print a new private key and its public key. |
| `pubkey --key <file>` | Print a key file's public key. |
| `sign-config --config <config.json> --key <file> --set <publisher-set.hex>` | Print this publisher's approval of a committee config. Append it to the config file's `signatures` list. |
| `fetch-set`, `next-set`, `show-set`, `sign-rotation`, `sign-pop`, `merge-signatures`, `add-approval`, `rotation-status` | Committee rotation; see below. |

## Shadow mode

Run the full publisher without being in the committee and without signing anything. It records every
exchange, prices every feed each tick, and compares its prices with the committee's signed updates
from a mirror. A prospective publisher runs it before joining.

Add to `publisher.json` (the key need not be in the committee; `peers` are ignored):

```json
"shadow": { "referenceUrl": "https://64-227-40-35.sslip.io" }
```

Shadow mode also verifies every update it fetches against the committee's current key set and keeps
it in `/data`, and every publisher remembers each key set it has run under. **Keep the same `/data`
volume when you switch from shadow to member**: you join with the committee's finalized history, which
the proposer order and the EMA depend on, and sync the rest from your peers.

`GET /health` on the API port reports, per feed: ticks compared, how many were within the feed's
tolerance, the maximum deviation in basis points, and ticks either side missed. A summary is logged
every minute, and every tick outside tolerance is logged as `shadow.outside_tolerance`.

## Committee rotation

Adding or removing a publisher rotates the committee cell. The script requires a quorum of the
**current** set to authorize it and **every** key of the next set to prove possession. Each operator
signs on its own machine; one coordinator collects the files and sends the transaction.

| Command | Who | Output |
|---|---|---|
| `fetch-set --operator publisher.json > current.hex` | coordinator | the committee's current set, from CKB |
| `next-set --set current.hex --add <pubkey> [--remove <pubkey>] > next.hex` | coordinator | the proposed set; the change is printed to stderr |
| `show-set --set next.hex [--key <file>]` | everyone | the set, for review |
| `sign-rotation --set current.hex --next next.hex --key <file>` | current members (a quorum) | an authorization signature |
| `sign-pop --next next.hex --key <file>` | every next member | a proof of possession |
| `sign-config --config configs/vN.json --key <file> --set next.hex` | every next member | an approval of each active config by the next set |
| `merge-signatures a.json b.json … > merged.json` | coordinator | one sorted list |
| `add-approval --file configs/vN.json --set next.hex a.json b.json …` | coordinator | records the next set's config approval in the file |
| `rotation-status --set current.hex --next next.hex --authorization auth.json --pop pop.json` | coordinator | what is still missing |

`--operator publisher.json` can replace `--key` to sign with the operator's configured key, including
AWS KMS.

Then, before sending: distribute the updated config files (with the next set's approvals) to every
operator's `configDir`. Send with the deploy tool:

```sh
npm run rotate:committee -w apps/deploy -- --network testnet --name majors --next next.hex --authorization auth.json --pop pop.json --broadcast
```

Publishers see the new set within 15 s, exit with code 3 and restart under it; a new member starts
signing from then on. Publisher indexes change with the set (keys are sorted), which is why each
config needs the next set's approval before the rotation.

## Committee configs

[`configs/majors.template.json`](configs/majors.template.json) and
[`configs/ckb.template.json`](configs/ckb.template.json) hold the launch methodology. A committee
config adds `version`, `publisherSetTypeHash`, `activationTickMs` and each feed's `feedId`. It
needs signatures from a quorum of the current set before publishers accept it.

## Supported venues

- **WebSocket:** `binance`, `coinbase`, `kraken`, `bitstamp`, `okx`, `bybit`, `gate`, `bitget`,
  `upbit` and `kucoin`. KuCoin fetches a public connection token first.
- **REST polling (1 s):** `mexc`, whose websocket streams protobuf.

Check that your server can reach every venue before joining a committee:

```sh
docker run --rm --entrypoint node lean-oracle-publisher apps/publisher/scripts/probe-venues.mjs 20 [--doh]
```

It connects to every market in both committee templates and prints `OK`/`NONE` per market.
`--doh` resolves exchange hosts over DNS-over-HTTPS.

- Binance and Bybit refuse US IP addresses.
- **Live-verified (2026-09-24):** Binance, Coinbase, Bitstamp, Bybit, Upbit, Gate, Bitget and MEXC.
  Coinbase quotes come from its `level2_batch` book, because its `ticker` fires only on trades.
- **Not yet verified:** Kraken, OKX and KuCoin. Their parsers follow the venues' public API
  documentation; the network used for verification blocks their IPs.

## Local committee (development)

```sh
npm run build -w lean-oracle-sdk -w lean-oracle-publisher
node apps/publisher/scripts/local-committee.mjs --template apps/publisher/configs/majors.template.json --n 4 --out ./local --mock
for i in 0 1 2 3; do node apps/publisher/dist/main.js run --config ./local/publisher-$i/publisher.json & done
curl localhost:7701/v1/finalized/latest
```

`--mock` replaces the exchanges with synthetic quotes.

As containers (add `--docker`, then one container per publisher on a shared network):

```sh
docker build -f apps/publisher/Dockerfile -t lean-oracle-publisher:dev .
node apps/publisher/scripts/local-committee.mjs --template apps/publisher/configs/majors.template.json --n 4 --out ./local --mock --docker
docker network create lean-oracle
for i in 0 1 2 3; do
  docker run -d --name publisher-$i --network lean-oracle \
    -v $PWD/local/publisher-$i:/config:ro -v lean-oracle-data-$i:/data -p 1770$i:7701 lean-oracle-publisher:dev
done
curl localhost:17700/health
```

## Not yet implemented

- Multi-arch (amd64 + arm64) image publishing to GHCR.
- Automatic distribution of new config versions between publishers. Operators currently copy them
  into `configDir`.
