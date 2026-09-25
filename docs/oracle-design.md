# Threshold Price Oracle — Design

Status: **final (2026-09-24)**. This is the first version of the protocol; nothing has been
deployed before it.

## 1. Summary

A **pull oracle** for any CKB project, modelled on Pyth + Hermes and on the on-chain flow of
`lean-oracle`:

- A **committee** of permissioned publishers signs a canonical **price update** for its asset
  basket once per **tick** (for example every 1 s).
- Every update carries its signing timestamp (`publish_time_ms`). Each feed's entry also carries
  `prev_publish_time_ms` and `source_time_ms`.
- Updates are Merkle-batched. One quorum signature over one root covers every feed in the tick.
- Finalized updates are archived and served by a public **mirror API** (the Hermes equivalent).
  Anyone can run one, because updates verify themselves.
- Users fetch an update (latest, or first at/after a timestamp) and submit it on-chain. It
  forward-updates a **price feed cell**, exactly like lean-oracle's oracle cell.
- There are **no public or canonical cells.** Each project creates its own Type ID-unique feed
  cells under any lock it chooses, and updates them itself.
- **Freshness is the consumer's responsibility.** The oracle guarantees authenticity and
  monotonicity only. Snapshot and settlement policy also stays with the consumer.

## 2. Principles

1. **Authenticity + monotonicity only.** The cell holds the last authenticated price and its
   timestamp. Staleness limits, deviation bounds and snapshot rules belong to consumers.
2. **Mirror lean-oracle on-chain.** It uses the same create/update/burn shapes, the same
   zeroed-at-creation rule, and strictly increasing timestamps. Unlike lean-oracle, every cell
   is Type ID-unique and there is no shared public cell or bind lock.
3. **Current-set-only.** Only updates signed by the active PublisherSet are accepted. A retired
   set can never authorize anything, including history.
4. **No trusted gateway.** Signed updates are self-verifying. Mirrors, CDNs and caches are
   untrusted transport.

## 3. Committees

A committee is one PublisherSet cell (existing `publisher_set_type`, quorum
`floor(2n/3)+1`) plus off-chain parameters that it publishes. Committees isolate risk, cadence
and methodology from each other.

| | `majors` | `ckb` |
|---|---|---|
| Feeds (initial) | BTC, ETH, SOL each in /USD, /USDT and /USDC; USDT/USD | CKB/USDT, CKB/USDC |
| Tick period | 1000 ms (500 ms possible later) | 2000 ms |
| Venues | /USD: Coinbase, Kraken, Bitstamp. /USDT: Binance, OKX, Bybit, Gate, Bitget, KuCoin, MEXC. /USDC: Binance, OKX, Bybit, Kraken, Bitget, KuCoin, MEXC, Gate | /USDT: Binance, Gate, Bitget, KuCoin, MEXC. /USDC: Binance, Gate, MEXC |
| Publishers | 1–9 (target 7) | 1–9 (target 4) |

`feed_id = ckb_hash("LEAN/FEED/V1" || symbol)` with Pyth-style canonical symbols such as
`Crypto.BTC/USDT`. **Every feed is a native pair:** it is priced only from markets that trade exactly
that pair, and publishers never convert between currencies. Consumers derive other pairs by
combining feeds, e.g. BTC/USD ÷ USDT/USD. A pair becomes a feed only if enough independent venues
trade it (section 3.1 rules). Feed IDs are permanent. Routine methodology changes (venues, windows,
tolerances) are versioned committee settings and keep the ID. Only a change of meaning gets a new
symbol, for example `Crypto.CKB/USDT.TWAP60`. The committee is not part of the ID: it is recorded in
every cell as `publisher_set_type_hash`, and consumers pin it.

Each feed has one fixed exponent, recorded in the feed registry: `-8` for majors and stablecoins,
`-10` for CKB pairs. Publishers always sign with the registered exponent.

### 3.1 Committee config

Everything except the publisher keys lives in a versioned, off-chain **committee config**:

- the feed registry: symbol, `feed_id`, and exponent;
- each feed's venue allowlist and `min_venues`;
- the methodology settings (section 4);
- `tick_period_ms`, `observation_deadline_ms` and `max_signing_lag_ms`.

To change it:
1. Someone proposes a new version, including an `activation_tick`.
2. Publishers sign `ckb_hash("LEAN/COMMITTEE_CONFIG/V1" || canonical JSON)`. Canonical JSON has sorted
   object keys, no whitespace, and integers only (64-bit values as decimal strings). The config file
   carries the approvals as a list of `{ publisherIndex, signature }`, which each operator appends to.
3. With ⌊2n/3⌋+1 signatures from the current set it is approved.
4. All publishers switch at `activation_tick`.

Every signed update carries the active config's hash (`config_hash`, section 6.1), and mirrors
publish every approved config with its signatures.

Changes need no transaction or deployment:
- **Adding a feed:** a new Merkle leaf. Existing IDs and proofs are unaffected.
- **Removing a feed:** it is no longer included. Its ID is never reused.
- **Sharing a feed:** a `feed_id` may be served by several committees.
- **Size:** there is no protocol cap on basket size (`leaf_count` is a u16). Split committees by
  trust, cadence or methodology, not by size.

**Config rules.** `validateCommitteeConfig` rejects a config, and `sign-config` refuses to sign it,
unless every feed has:
- a `quote` equal to its symbol's suffix, and markets that each trade exactly that pair;
- `minVenues ≥ 2`, so no single exchange can set a price;
- at least `minVenues + 1` markets, so one exchange failing does not stop the feed;
- each venue at most once.

`sign-config --probe <s>` also watches every listed market live and warns about silent ones. It
only warns, because a market may be unreachable from one operator's network alone.

**Venues.** Publishers use only a feed's allowlisted venues:
- They may skip a venue they cannot reach, and may locally exclude a venue that is plainly broken
  (stale, crossed, or an outlier) until the config removes it.
- **Admission criteria:** a public spot API (REST + websocket), genuine volume and depth, no
  persistent anomaly flags, and reachable by at least a quorum of publishers.
- **Terms of use:** operators check each venue's market-data terms before mainnet.

## 4. Price methodology (per publisher, per tick)

Each publisher runs a **recorder**: live connections to every venue (top of book with sizes, trades),
plus per-venue **liveness** (the last time the connection delivered anything, heartbeats included).
At tick `t` it computes one observation per feed.

1. **Venue price.** A book state counts only if all of these hold:
   - the venue's connection was alive within `maxQuoteAgeMs` of `t`. This is liveness, not price
     change: a quiet book on a live connection is still valid;
   - the book state is at most `maxBookAgeMs` old (default 60 s);
   - it is not crossed, and its spread is at most `maxSpreadBps`;
   - its top of book is at least `minTopNotional` on each side, in the feed's quote currency, where
     the venue reports sizes (the dust filter).

   From those states, the venue price is:
   - `mid`: the median of midpoints sampled every 100 ms over `min(windowMs, maxQuoteAgeMs)`;
   - `vwap`: the trade VWAP over `windowMs`, or the `mid` rule if the venue had no trades.
2. **Cross-venue price.**
   - The **median** is the middle value, or the floor of the mean of the two middle values for even
     counts.
   - With `maxDeviationBps` set, venues further than that from a first median are dropped, and the
     median is taken again.
   - At least `minVenues` must remain.
   - `conf = max(median half-spread, median absolute deviation)`, and `source_time_ms` is the median
     data time.
3. **EMA.** `ema_price` and `ema_conf` are computed from the committee's finalized history, not per
   publisher, in integer arithmetic:
   - `ema' = ema + (price − ema) × Δt / (Δt + τ)`, truncating toward zero;
   - `Δt` is the time since the feed's previous finalized tick, and `τ = half_life × 10^6 / 693147`
     ms;
   - the first finalized price initializes it.

Launch defaults are in `apps/publisher/configs/{majors,ckb}.template.json`:

| Setting | `majors` | USDT/USD | `ckb` |
|---|---|---|---|
| Tick / `observationDeadlineMs` | 1000 / 400 | 1000 / 400 | 2000 / 800 |
| Venue price | `mid`, 1 s window | `mid`, 1 s window | 60 s `vwap`, else `mid` |
| `maxQuoteAgeMs` (liveness) | 2 s | 2 s | 60 s |
| `maxSpreadBps` | 50 | 10 | 300 |
| `minTopNotional` | 100 | 1000 | 20 |
| `maxDeviationBps` | 100 | 30 | 300 |
| `minVenues` / markets | /USD 2 of 3; /USDT 3 of 7; /USDC 3 of 8 | 2 of 3 | /USDT 3 of 5; /USDC 2 of 3 |
| `tolerance_bps` | 50 | 20 | 200 |
| EMA half-life | 1 h | 1 h | 1 h |

No currency conversion happens anywhere in the pipeline. A consumer that needs another pair divides
feeds itself, e.g. CKB/USD = CKB/USDT × USDT/USD (the two come from different committees, so the
consumer chooses how close their timestamps must be). USDC/USD is not a launch feed: only Kraken and
Bitstamp trade it natively, one short of the rules above.

## 5. Off-chain signing protocol (one canonical update per tick)

The rule to guarantee: **at most one valid update exists per (committee, tick)**. Without it,
"first price at or after T" could be cherry-picked.

**Transport.**
- Publishers connect over WebSockets and exchange binary frames (`type u8 | payload`).
- A connection is authenticated once: the server sends a 32-byte challenge, and the client answers
  with its index and a signature over
  `ckb_hash("LEAN/PEER_HELLO/V1" || challenge || server pubkey || index)`.
- Frames then need no per-message signature. Observations, proposals and header signatures carry
  their own signatures, so they can be relayed by any peer.

**Leader order.**
- The anchor for tick `t` is the latest finalized update at or before `t − 2 × tick_period`.
- Publishers are ordered by `ckb_hash("LEAN/LEADER_ORDER/V1" || t || anchor header hash || index)`.
- Ranks `0..f` (`f = n − quorum`) may propose. The order is unpredictable until about two ticks
  ahead, and every synced publisher computes it identically.

**Per tick:**
1. **Observe.** At `t` each publisher signs an observation (`LEAN/OBSERVATION/V1`) and sends it to
   **every** publisher. Layout (little-endian): `magic "TPOB" | version u8 |
   publisher_set_type_hash [32] | set_index u32 | tick_ms u64 | config_hash [32] | publisher_index u8 |
   entry_count u8 | entries`, each entry `feed_id [32] | price i64 | conf u64 | source_time_ms u64`,
   strictly ascending by feed id; the 65-byte signature follows.
2. **Propose.**
   - **Rank 0** proposes as soon as it holds all `n` observations, or a quorum after a 100 ms grace.
   - **Rank r ≥ 1** may propose from `t + r × observation_deadline_ms`. It first asks its peers for
     the tick's observations and best proposal (`tick_request`). After 100 ms it **re-proposes the
     best-ranked proposal it has seen**, or else its own.
   - A proposal is `rank | proposer | tick | anchor tick | anchor hash | prev finalized tick | chosen
     observations (index, hash)…`, signed by the proposer over `LEAN/PROPOSAL/V1`.
3. **Sign.** Each publisher checks the proposal:
   - the anchor matches; if the proposer's anchor is newer, it syncs from the proposer and abstains;
   - the proposer holds that rank, and the rank's slot is open;
   - the tick is inside the signing window;
   - the previous finalized tick matches; if it is behind, it syncs and abstains;
   - the observations are valid, distinct and at least a quorum. Missing ones are requested at once.

   It then derives the messages itself:
   - `price`, `conf` and `source_time_ms` are the medians of the chosen observations (for even
     counts, the floor of the mean of the middle two);
   - EMA and `prev_publish_time_ms` come from its finalized history;
   - `num_publishers` is the observation count;
   - it builds the Merkle tree and the header.

   It signs the header hash only if each feed is within `tolerance_bps` of its own observation and it
   has never signed a different header for the tick (persisted before release). The 65-byte
   signature goes to **every** publisher.
4. **Finalize.** Each publisher finalizes **locally** once a quorum has signed the header it derived.
   - Publishers may hold different quorum subsets of signatures for the same header. The header hash
     identifies the update.
   - A publisher that has finalized a tick sends the update to any peer still working on it.
   - Finalization is monotonic: once a later tick is finalized, earlier unfinalized ticks are
     abandoned.

**Properties:**
- **Uniqueness.** Two different finalized headers for one tick would need `2q − n ≥ f + 1` common
  signers, so at least one honest publisher would have to double-sign.
- **Median safety.** With `q = floor(2n/3)+1` and `f < n/3` faulty publishers, every median is
  bounded by honest observations.
- **Liveness.** A crashed or silent leader is replaced within the tick by the next rank. Because
  backups re-propose what they have seen, signatures already given still count.
- **Missing ticks** (no quorum at any rank) stay missing permanently.
- **Measured** on live exchanges with 4 local publishers: 100% of ticks finalized by every
  publisher, with the time from tick to finalized at p50 about 21 ms and p90 about 27 ms, excluding
  network delay between publishers.

## 6. Signed update format

All integers are little-endian. Hashes are `ckb_hash` (blake2b-256, personal
`ckb-default-hash`).

Every hashed or signed structure is domain-separated with a `LEAN/<NAME>/V<n>` tag:
`LEAN/FEED/V1`, `LEAN/PRICE_UPDATE/V1`, `LEAN/PRICE_LEAF/V1`, `LEAN/PRICE_NODE/V1`,
`LEAN/OBSERVATION/V1`, `LEAN/COMMITTEE_CONFIG/V1`, `LEAN/PROPOSAL/V1`, `LEAN/LEADER_ORDER/V1`,
`LEAN/PEER_HELLO/V1` (publisher connection authentication),
`LEAN/PUBLISHER_SET_STATE/V1`, `LEAN/PUBLISHER_SET_UPDATE/V1`, `LEAN/PUBLISHER_SET_POP/V1`.

### 6.1 Header (119 bytes, signed)

| Offset | Field | Type |
|---|---|---|
| 0 | magic `"TPOU"` | [u8; 4] |
| 4 | version = 1 | u8 |
| 5 | publisher_set_type_hash | [u8; 32] |
| 37 | set_index | u32 |
| 41 | publish_time_ms (the tick) | u64 |
| 49 | tick_period_ms | u32 |
| 53 | config_hash | [u8; 32] |
| 85 | leaf_count | u16 |
| 87 | merkle_root | [u8; 32] |

`signing_hash = ckb_hash("LEAN/PRICE_UPDATE/V1" || header)`. Signatures use the existing
`SignatureBundle` (recoverable low-S secp256k1, strictly increasing publisher index).

### 6.2 Leaf / price message (86 bytes)

| Offset | Field | Type |
|---|---|---|
| 0 | message_type = 0 (price) | u8 |
| 1 | feed_id | [u8; 32] |
| 33 | price | i64 |
| 41 | conf | u64 |
| 49 | expo | i32 |
| 53 | prev_publish_time_ms | u64 |
| 61 | ema_price | i64 |
| 69 | ema_conf | u64 |
| 77 | source_time_ms | u64 |
| 85 | num_publishers | u8 |

The feed's `publish_time_ms` is the header's `publish_time_ms`.

### 6.3 Merkle tree

- `leaf_hash = ckb_hash("LEAN/PRICE_LEAF/V1" || leaf)`
- `node_hash = ckb_hash("LEAN/PRICE_NODE/V1" || min(a,b) || max(a,b))` (sorted pair, so proofs
  need no left/right bits, as in Pyth)
- Leaves are ordered by ascending `feed_id`, with each `feed_id` appearing once. An odd node at
  any level is promoted unchanged.
- A proof has at most `ceil(log2(leaf_count))` siblings.

### 6.4 Update blob (what the API serves and what goes in the witness)

```
header (119) | SignatureBundle | entry_count u8 | entry_count × { leaf (86) | proof_len u8 | proof_len × [u8; 32] }
```

One blob may carry any subset of the tick's feeds. The witness wrapper mirrors lean-oracle:
`update_len u32 | update blob`, in `WitnessArgs.input_type` of the feed cell's group input 0.

## 7. On-chain: `price_feed_type` (mirrors lean-oracle `oracle_script`)

`type.args = feed_id || type_id` (64 bytes). `type_id = ckb_hash(first_input || output_index as
u64 LE)` is checked at creation (the same rule as `publisher_set_type`'s `validate_type_id_seed`).
No two cells can ever share a type hash, so a consumer pins exactly one cell by its type hash. A
burned cell's identity can never be recreated, which rules out rolling back its timestamps.

### 7.1 Cell data (125 bytes)

| Offset | Field | Type |
|---|---|---|
| 0 | feed_id | [u8; 32] |
| 32 | publisher_set_type_hash | [u8; 32] |
| 64 | price | i64 |
| 72 | conf | u64 |
| 80 | expo | i32 |
| 84 | publish_time_ms (last update) | u64 |
| 92 | prev_publish_time_ms | u64 |
| 100 | ema_price | i64 |
| 108 | ema_conf | u64 |
| 116 | source_time_ms | u64 |
| 124 | num_publishers | u8 |

`publish_time_ms` is the committee-signed time of the price currently stored. That is the "last
updated" timestamp. A consumer that also wants the on-chain inclusion time can load the header
of the block that created the cell.

### 7.2 Script group shapes

- **Create (0 → 1).**
  - `feed_id == args[0..32]`, and `args[32..64]` is the valid Type ID seed for this output.
  - Every price/time field is zero. As in lean-oracle v3, a nonzero `publish_time_ms` proves
    the cell has had at least one authenticated update.
  - Exactly one cell dep has type hash `publisher_set_type_hash`, and it decodes as a valid
    PublisherSet.
- **Update (1 → 1).**
  1. Decode old and new data. `new.feed_id == args[0..32]`. `feed_id` and `publisher_set_type_hash`
     are unchanged.
  2. `new.publish_time_ms > old.publish_time_ms` (strict: forward only).
  3. Parse the witness blob. Exactly one entry has `leaf.feed_id == feed_id`, and its Merkle
     proof verifies against `header.merkle_root`.
  4. `header.publisher_set_type_hash == new.publisher_set_type_hash`.
  5. Load the unique PublisherSet cell dep. It must not be `GOVERNANCE_PAUSED`, and
     `header.set_index` must equal the current `set_index`.
  6. `SignatureBundle.verify_threshold(signing_hash(header), current_set)`.
  7. The output must equal the authenticated message exactly: the leaf fields, plus
     `publish_time_ms = header.publish_time_ms`.
- **Burn (1 → 0).** Always allowed by the type script; the lock decides.

### 7.3 Lock

Any lock. The oracle ships no lock and deploys no public cells. The cell's creator chooses who may
update or burn it: a normal secp256k1 lock (only its keeper updates), a multisig, or a
permissionless lock of their own design. The type script alone guarantees that every update is
authentic and forward-only, whatever the lock.

### 7.4 Cost

Measured with `ckb-testtool` (full `price_feed_type` update, including parsing, Merkle proof
and PublisherSet load): **24.1M cycles at quorum 3 of 4** and **55.9M cycles at quorum 7 of 9**.
That is about 8M cycles per signature. Updating k feeds in one transaction re-verifies the signatures k times, as lean-oracle
does today. A shared verification cell is a possible later optimization.

## 8. Mirror API (Hermes equivalent)

The mirror (`apps/mirror`, Docker image `lean-oracle-mirror`) is a public read service between
publishers and consumers. Publishers stay on a private network and serve only the mirror.

**Ingestion.** For each committee the mirror follows several publishers:
- `WS /v1/stream` on each publisher's API pushes every newly finalized update;
- `GET /v1/finalized?after=` backfills at start, on every reconnect and every 60 s.

Every update is verified before it is stored: committee type hash, known set index, a quorum of
signatures, `leaf_count` entries each with a valid Merkle proof. The committee cell is re-read from
the chain every 30 s. A set that has been rotated out is accepted only for ticks before the mirror
first saw the newer set.

**Identity and equivocation.** An update is identified by its header hash; publishers may hold the
same update with different quorum subsets of signatures, which are duplicates. A second valid header
for the same `(committee, tick)` is equivocation: the first copy stays canonical, both are kept and
served as evidence, and the mirror logs `ingest.equivocation`.

**Endpoints.** `ids` are feed IDs or symbols (e.g. `Crypto.BTC/USDT`), comma-separated, at most 64.
`committee` (a type hash) optionally restricts results to one committee.

| Endpoint | Returns |
|---|---|
| `GET /v1/updates/latest?ids=` | The newest update containing each feed |
| `GET /v1/updates/at?t=&ids=` | For each feed, the first update with `publish_time_ms ≥ t` |
| `GET /v1/updates/range?id=&from=&to=&limit=` | One feed's updates in `[from, to]`, oldest first, at most 1000 |
| `GET /v1/feeds` | Feeds seen, with committee and latest tick |
| `GET /v1/equivocations` | Conflicting valid updates, as evidence |
| `WS /v1/stream?ids=` | Each new update containing any of the feeds |
| `GET /health` | Per committee: latest tick, connected publishers |

Response shape: `{ "updates": [{ "committee", "publishTimeMs", "blob", "prices": [...] }], "missing": [...] }`.
- Requested feeds that share a tick share one entry. Its `blob` carries only those feeds, each with
  its proof, ready for a feed cell witness.
- `prices` (decimal strings) is a convenience. The SDK's `MirrorClient` takes every value from the
  decoded blob and, given the committee cell data, verifies each update before returning it.
- Caching: an `at` answer whose ticks equal `t` exactly never changes and is served with
  `immutable`; other answers are cacheable for 1 s at most.

**Rate limits.** A token bucket per API key (`x-api-key` header or `apiKey` query) or, without a
key, per IP (`trustProxy` reads `X-Forwarded-For` behind a trusted proxy). Defaults: 10 requests/s,
bursts of 20, 2 streams per anonymous client. Unknown keys get 401, exhausted buckets 429 with
`Retry-After`. `/health` is not limited. Heavy users should run their own mirror: it needs no
trust, only publisher URLs and the committee cell.

Full history is retained (about 50 MB/day per committee at 1 s ticks). Not yet built: serving
approved committee configs (`/v1/configs`).

## 9. Consumer guidance

- **Own your cells.** Create your feed cells yourself and pin them by type hash (unique through
  Type ID). If you ever read someone else's cell, check its `publisher_set_type_hash`, because
  anyone can anchor a cell with the same `feed_id` to their own PublisherSet.
- **Contention is yours to size.** A cell can be consumed once per block. A project with many
  concurrent users can create several cells for the same feed, or verify updates inside its own
  transactions.
- **Authenticity check.** `publish_time_ms != 0`.
- **Freshness is yours.** CKB scripts cannot read the current time. Useful patterns:
  - compare `publish_time_ms` against a header dep's timestamp (proves an update is *not
    from the future*);
  - keep your own monotonic state;
  - rely on your own feed cell's forward-only rule, which stops anyone reusing older prices
    against it.
- **Historical prices / snapshots.** Fetch `/v1/updates/{T}`. Then either:
  - create a personal feed cell (it starts at `publish_time_ms = 0`, so any authentic update is
    a forward update) and apply the update; or
  - verify the blob inside your own script with the common crate.

  Both work only while the signing set is still current. How and when to snapshot is the
  consumer's decision.
- **Helpers.** `lean_oracle_common::consumer` decodes and checks a feed cell (feed, committee,
  authenticity), checks freshness against a provable time, and rescales exponents. The reference
  consumer [`examples/price_trigger_lock`](../examples/price_trigger_lock/src/main.rs) uses them:
  about 38,000 cycles to read and check a price.
- **In-transaction verification.** `lean-oracle-common` exports
  `verify_price_update(blob, feed_id, publisher_set) -> PriceMessage` for consumer scripts.

## 10. Components and deployment

| Component | Role |
|---|---|
| `contracts/publisher_set_type` | Committee cell: publisher keys, derived quorum `floor(2n/3)+1`, quorum-authorized rotation with proof of possession. |
| `contracts/price_feed_type` | Feed cells (section 7). |
| `contracts/common` (`lean-oracle-common`) | Shared codecs, Merkle, `verify_price_update`; usable by consumer scripts. |
| `apps/publisher` | Publisher service (Docker image): recorder, observer, rotating leader, signer. |
| `apps/deploy` | Contract deployment and committee bootstrap/rotation; devnet end-to-end test. |
| `apps/mirror` (`lean-oracle-mirror`) | Verified archive and public read API (section 8). Docker image. |
| `lean-oracle-sdk` ([design](sdk-design.md)) | Codecs, Merkle, blob verification, feed-cell create/update builders, mirror client. |

All contracts are deployed with `hash_type = data2` (CKB-VM v2) in plain code cells, with no Type
ID and no upgrade key. A fix is a new deployment with a new code hash, listed per network in
`deployments/<network>.json` (written by `apps/deploy`, parsed by `lean-oracle-sdk/presets`).

Publishers hold every approved config version and apply each from its activation tick. The
scheduler lands exactly on activation ticks, and new versions are picked up from the operator's
config directory while running. The publisher key can stay in a file or in AWS KMS (secp256k1); KMS
signatures are converted to the recoverable low-S form.

Publishers read their committee cell from CKB (indexer `get_cells` on the committee type script)
and re-check it every 15 s. On rotation or pause they exit, and their container restarts with the
new set. The devnet end-to-end test (`apps/deploy/tests`) exercises the whole path on a real node.

### 10.1 Example consumer: `asset-up-down-pools` (decided)

- Each lane keeper owns one long-lived BTC/USD feed cell.
- In the same transaction as ACTIVATE or RESOLVE, the keeper moves that cell forward to the
  boundary tick.
- The pool contract requires a `price_feed_type` output with the pinned `publisher_set_type_hash`
  and `feed_id`, and `publish_time_ms == boundary × 1000`. It records the price in its own state.
- A missing tick falls through to the pool's timeout/VOID path.
- This work happens in the pools repository.

## 11. Decision log (2026-09-24)

| Topic | Decision |
|---|---|
| Model | Pull oracle; cells store the signed `publish_time_ms`; freshness and snapshots are the consumer's |
| On-chain flow | Mirrors lean-oracle: zeroed creation, strictly forward updates, lock-controlled burn |
| Batching | Merkle root per tick, blake2b sorted-pair nodes |
| Tick period | 1000 ms `majors`, 2000 ms `ckb` (400–500 ms `majors` later) |
| Quote and IDs | Native pairs only (/USD, /USDT, /USDC), no conversion by publishers; `feed_id = ckb_hash("LEAN/FEED/V1" \|\| symbol)`, permanent; fixed exponent (-8; CKB -10) |
| Domain tags | `LEAN/` prefix everywhere |
| Cells | No public cells; Type ID-unique `args = feed_id \|\| type_id`; any lock |
| Code | Immutable, `data2`, no upgrade key; versioned deployments |
| Launch basket | `majors`: BTC, ETH, SOL × /USD, /USDT, /USDC, plus USDT/USD; `ckb`: CKB/USDT, CKB/USDC |
| Config | Quorum-signed versions with activation tick; `config_hash` in header |
| Publishers | n ≤ 9 hard cap, no minimum; launch with available operators |
| Methodology | Section 4: liveness-based freshness, 100 ms mid sampling, dust filter, outlier pass, native pairs without conversion, config rules (minVenues ≥ 2, one spare market, one market per venue), even-count median = floor mean of middle two; EMA from finalized history |
| Protocol | Section 5: observations and signatures to all, signed proposals naming observations by hash, anchor-seeded leader order with backup slots and re-propose rule, local finalization, authenticated binary transport |
| Up/down pools | Keeper-owned lane feed cell, exact-tick settlement |
