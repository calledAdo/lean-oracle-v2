# lean-oracle-mirror

The public read API for Lean Oracle ([spec section 8](../../docs/oracle-design.md)). It follows
publishers' finalized updates, verifies each one against the committee cell, keeps full history in
SQLite and serves it with per-client rate limits. It needs no trust: anyone can run one.

## Run

Build from the repository root and run with a config mounted at `/config/mirror.json`
([example](configs/mirror.example.json)) and a volume for `/data`:

```bash
docker build -f apps/mirror/Dockerfile -t lean-oracle-mirror .
```

```bash
docker run -d --name mirror -p 7800:7800 -v $PWD/mirror-config:/config:ro -v mirror-data:/data lean-oracle-mirror
```

Config:
- `committees[]`: `publisherSetTypeHash`, the committee cell's `chain.typeScript` (or a
  `publisherSetFile` for development), and `publishers`: the publishers' API URLs
  (`http://host:7701`). List several; any one of them is enough.
- `rateLimit`: `anonymous` and per-key `{ rps, burst, maxStreams }`.
- `http.trustProxy`: only behind a proxy that sets `X-Forwarded-For`.

Publishers' APIs should be reachable only by mirrors. Put a CDN or reverse proxy in front of the
mirror for TLS and caching; exact-tick `at` answers are marked immutable.

## Use

```ts
import { MirrorClient } from "lean-oracle-sdk/mirror";
import { pullAndUpdate } from "lean-oracle-sdk/tx";

const mirror = new MirrorClient({ urls: ["https://mirror-a.example", "https://mirror-b.example"], committees: { [committeeTypeHash]: committeeCellData } });
const [update] = await mirror.latest(["Crypto.BTC/USDT"]);
const { tx } = await pullAndUpdate({ client, deployment, feedType, mirror });
```

## Test

```bash
npm test -w lean-oracle-mirror
```
