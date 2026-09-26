# Architecture review and gstack plan (2026-09-26)

Reviewer: Claude Opus 5.5 (session 008). Scope: the whole repo at `c4dd045` plus the live testnet.
Premise from the user: nothing is public yet, so backward compatibility does not constrain any
recommendation. That includes the on-chain formats, the testnet deployment and `lean-oracle-sdk@1.0.0`
on npm.

## 1. What the project is

A **pull price oracle for Nervos CKB**, called Lean Oracle. The repo, design doc and binary magics
still say "Threshold Price Oracle" (`TPOU`, `TPOB`).

```
 exchanges (9 venues, WS/REST)
        │  top of book + trades
        ▼
 ┌─────────────── committee (1–9 publishers, quorum ⌊2n/3⌋+1) ───────────────┐
 │ apps/publisher: recorder → methodology (median, outlier pass, dust filter) │
 │   → signed observation → rotating leader proposes → each re-derives,      │
 │     checks tolerance + double-sign guard (SQLite) → header signature      │
 │   → local finalization with a quorum; peers sync history over WS          │
 └───────────────────────────────┬───────────────────────────────────────────┘
                                 │ WS /v1/stream + GET /v1/finalized (private)
                                 ▼
 apps/mirror: re-verifies every update against the committee cell read from CKB,
              stores full history (SQLite), records equivocation, public REST/WS
                                 │
                                 ▼
 consumer (lean-oracle-sdk)  ── fetch blob ─→ tx: feed cell 1→1 + witness(blob)
                                                    │
 on CKB:  publisher_set_type  (committee cell: keys, set_index, flags; rotate op only)
          price_feed_type     (Type ID-unique feed cell, forward-only, verifies quorum sig
                               + Merkle proof against the committee cell as a cell dep)
          consumer scripts read the feed cell as a cell dep (lean_oracle_common::consumer)
```

| Part | Size | State |
|---|---|---|
| `contracts/common` (`lean-oracle-common`) | ~900 LOC Rust | Codecs, Merkle, `verify_price_update`, consumer helpers |
| `contracts/price_feed_type` | 153 LOC | create / update / burn; 24M cycles at 3-of-4, 56M at 7-of-9 |
| `contracts/publisher_set_type` | 108 LOC | create + `OP_ROTATE` with quorum auth and all-key PoP |
| `packages/sdk` | ~50 files, npm 1.0.0 | protocol, publisher, mirror, ckb, tx, presets, client facade |
| `apps/publisher` | ~40 files | full consensus node, 9 venue adapters, shadow mode, rotation CLI, Docker |
| `apps/mirror` | 15 files | verified ingest, equivocation evidence, rate limits, Docker |
| `apps/watchdog`, `ops/testnet` | small | Telegram alerts, nightly gzip SQLite backups |
| `apps/deploy` | 13 files | deploy-code, bootstrap/rotate, devnet e2e + onboarding drill |
| `apps/web` | Next.js 16 + Fumadocs | landing page + 62-page docs, GitHub Pages |
| `examples/` | Rust lock + TS script | price-triggered release, end to end on testnet |

**Verified today:** `cargo test --workspace` (23 Rust tests incl. 19 ckb-testtool), `npm test`
(SDK 18, publisher 31, mirror 4, watchdog 2). All pass. Testnet mirror is live: 601 BTC/USDT updates
in the last 10 minutes, no gaps; all 5 compose services up for ~22 h.

## 2. What is strong

- **Small, auditable on-chain surface.** Two type scripts of ~100–150 lines over one shared crate;
  strict decoders (exact lengths, no trailing bytes, low-S, strictly increasing indexes, proof depth
  cap). Immutable `data2` code with reproducible builds and checksums.
- **The trust model is coherent.** Updates self-verify, so mirrors/CDNs are untrusted transport;
  the mirror itself re-verifies and keeps equivocation evidence.
- **The consensus design is thought through.** Anchor-seeded leader order, backup ranks that
  re-propose the best proposal seen, persisted double-sign guard, uniqueness argument
  (`2q − n ≥ f + 1`), median safety under `f < n/3`.
- **Cross-language determinism.** `vectors/protocol.json` generated from Rust and checked
  byte-for-byte in TS, including signatures.
- **Operator path exists end to end.** Shadow mode, rotation CLI, config approvals across
  rotations, and a devnet drill that exercises them on a real node.

## 3. Findings, ranked

### P0: operational, now

1. **Testnet storage grows ~1.3 GB/day with no retention.** After ~22 h: mirror volume 786 MB,
   majors publisher 375 MB, ckb 40 MB. The droplet has 15 GB free, and nightly backups (gzip, 7 days
   kept) add on top. At this rate the disk fills in roughly one to two weeks. The design doc's
   "about 50 MB/day per committee" (section 8) is off by ~8x: a 10-feed majors blob is ~2.3 KB,
   × 86,400 ticks/day, stored twice (publisher + mirror) plus the mirror's `feed_ticks` index.
   The watchdog has no disk check.
   - Publisher: keep only what consensus needs (anchor window, EMA state, sync window), e.g. prune
     `finalized` and `signed_ticks` older than N days.
   - Mirror: decide the retention product (full archive vs rolling window + cold storage). The
     `feed_ticks` index duplicates most of the row cost.
   - Watchdog: add a disk-free check. Fix the number in the design doc.

### P1: irreversible protocol decisions to settle before mainnet

Contracts are immutable with no upgrade key, so each of these is decided once. Nothing is public,
so now is the only cheap time.

2. **Every rotation erases all history for on-chain use (current-set-only).** Adding or replacing a
   publisher bumps `set_index`, and `price_feed_type` then rejects every update signed by an earlier
   set. For exact-tick settlement (the stated pools use case) any rotation between a boundary and
   its settlement forces the VOID path. For historical snapshots it means "only while the set is
   current". This is a deliberate choice (docs §2.3), but its product cost grows with how often you
   rotate, and step 4 (onboarding publishers) means rotating a lot at the start. Options: accept it
   and document rotation windows; or keep `previous set + first tick of the current set` in the
   committee cell so older ticks verify against the set that was current for them.
3. **There is no usable emergency pause.** `GOVERNANCE_PAUSED` is honored by `price_feed_type`
   and the publisher, but the only way to set it is a full `OP_ROTATE`: quorum authorization, proof
   of possession from **every** key, and a `set_index` bump (which also triggers finding 2). No CLI
   command sets the flag (`next-set` copies the current flags); only a hand-built rotation through
   the SDK could. Decide whether you want a cheap pause op (e.g. quorum-only, no
   `set_index` bump) or to drop the flag entirely and say so.
4. **The committee cell's lock can veto rotations.** `publisher_set_type` requires the lock hash to
   be unchanged, so whoever holds that lock (today the deployer key) must co-sign every rotation.
   It cannot forge one, but it can block one. Decide who holds it on mainnet (multisig of the
   publishers, or an always-success lock since the type script already enforces quorum).
5. **Multi-feed cost scales linearly.** Each feed cell update re-verifies the quorum signatures:
   ~8M cycles per signature, 56M per feed at 7-of-9. A consumer that needs CKB/USD
   (CKB/USDT × USDT/USD, two committees) pays twice. The doc lists a shared verification cell as
   "later"; later is a new code hash and a migration. Decide now if it is in or out of v1.
6. **Naming baked into formats.** Magics `TPOU`/`TPOB` and the repo/design name "Threshold Price
   Oracle" vs the product "Lean Oracle". Free to fix now, never after mainnet.

### P1: test coverage on the governance contract

7. **`publisher_set_type` has no ckb-testtool tests.** `tests/src` covers `price_feed_type`,
   `price_update` and the example lock. Rotation is only exercised by the devnet e2e happy path,
   which CI skips (`LEAN_DEVNET` is never set in `.github/workflows`). Missing negative cases: bad
   or short quorum auth, missing/extra PoP, lock change, nonce or set_index skip, clearing
   `GOVERNANCE_LOCKED`, network_id change, create with nonzero nonce, bad Type ID, burn attempt.

### P2: worth fixing, not blocking

8. **A publisher with no own observation signs without a tolerance check.** In `node.ts`
   `onProposal`, the tolerance loop runs only `if (state.own)` and skips feeds missing from its own
   observation. Median safety still holds (the price is a median of ≥ quorum signed
   observations), but "each signer checks tolerance against its own view" is weaker than the doc
   says. Either abstain without an own observation, or document it.
9. **Mirror loses old-set history on restart.** `Committee` only learns the current set at start;
   updates from an earlier set that arrive during backfill fail with `unknown set index`. A mirror
   that was down across a rotation keeps a permanent gap. Seed known sets from the deployment
   record or the chain history.
10. **Single droplet holds everything.** Both publisher keys, the mirror, Caddy and the backups on
    one 1 vCPU / 1 GB box (load avg ~2, 568 MB swap in use). Fine for a quorum-1 testnet; not a
    shape to carry forward. Backups do not leave the box.
11. **Workflow does not match gstack yet.** Work lands directly on `main`, with no PRs, no root
    `VERSION`/`CHANGELOG` (per-package versions: SDK 1.0.0, apps 1.0.0-alpha.0), no `CLAUDE.md`,
    no `TODOS.md`. `/review`, `/ship` and `/land-and-deploy` assume branches, PRs and those files.

## 4. Approaching it with gstack

gstack's normal order is Think → Plan → Build → Review → Test → Ship → Reflect. You skipped Think and
Plan, but this code is still pre-release, so run them now against what exists. Their output
decides the P1 protocol questions above.

### Step 0: set up the repo for gstack (once, ~30 min)

- Create `CLAUDE.md`: build/test commands (from `llmtimeline/state.md` Notes), the contract rules
  (`scripts/build-contracts.sh --update` after contract changes, regenerate vectors after format
  changes), and gstack's routing block. Every gstack skill reads it.
- Pick one backlog. Keep `llmtimeline/` as the cross-agent record, and either add a `TODOS.md` for
  `/ship` and `/retro` or tell them in `CLAUDE.md` to use `llmtimeline/state.md`.
- Pick a versioning story for `/ship`: one root `VERSION` + `CHANGELOG.md` for protocol releases,
  with per-package versions derived from it. Or keep per-package versions and name the package in
  each `/ship`.
- Switch to branch + PR per change so `/review`, `/ship` and `/land-and-deploy` work.
- `/setup-deploy`: teach it the droplet flow (pin `sha-<commit>`, `docker compose pull && up -d`)
  and the health URL, so `/land-and-deploy` and `/canary` can drive it.

### Step 1: Think (the startup phase you skipped)

- **`/office-hours`** (startup mode). Pressure-test demand. Who on CKB needs a pull oracle this
  quarter, what did `lean-oracle` 0.x users actually use, and who is the first design partner now
  that the pools repo is out of scope? Also: where do publishers come from? Recruiting 4–7
  independent operators is the real bottleneck for anything beyond quorum 1.
- **`/plan-ceo-review`** on `docs/oracle-design.md`. Scope decisions: launch basket, whether
  mainnet waits for n ≥ 4, full archive vs retention, API-key product or not.

### Step 2: Plan (lock the irreversible parts)

- **`/plan-eng-review`** on `docs/oracle-design.md`, fed findings 2–6 as the agenda. Its output
  should be a short "v1 contract freeze" decision list. Run it interactively, not through
  `/autoplan`: contract choices should not be auto-decided.
- **`/codex`** (consult or challenge mode) on `contracts/` and `apps/publisher/src/node.ts` for a
  cross-model opinion on the same decisions and on the consensus code.
- **`/plan-devex-review`** on `packages/sdk` + `apps/web/content/docs`. The SDK is the product for
  consumers, so review time-to-first-price and the "create your own feed cell" step.
- **`/spec`** turns each accepted decision into an executable spec (for example "rotation-safe
  history", "retention", "pause op").

### Step 3: Audit what exists

- **`/cso`**: key custody on the droplet, publisher WS auth, mirror rate limiting and
  `trustProxy`, GitHub Actions (image push with `GITHUB_TOKEN`, npm OIDC release), supply chain.
- **`/health`**: baseline quality dashboard (types, lint, tests) to track over time.
- **`/devex-review`**: live, from the docs site's Quick start to a price on testnet.
- **`/qa`** or **`/design-review`** on the GitHub Pages site once Pages is enabled.

### Step 4: Build loop, per change

`branch → build → /review → /ship → /land-and-deploy → /canary → /document-release`

- **`/investigate`** for any bug (for example a missed-tick report from the watchdog).
- **`/careful`** or **`/guard`** for sessions that touch the droplet over SSH or `secrets/`.
- **`/freeze contracts/`** while working on off-chain code, so a session can't edit the immutable
  contracts by accident.
- **`/canary`** watches `https://64-227-40-35.sslip.io/health` after each image bump.

### Step 5: Reflect

`/retro` weekly, `/learn` to keep project quirks (DNS/DoH, Rust 1.92 pin, macOS `._*` files).
`llmtimeline/` stays the handoff record between Claude and Codex.

Not relevant here: the iOS skills, `/scrape`, `/skillify`, `/pair-agent`, `/benchmark-models`.

## 5. Suggested order for the next week

1. Retention + disk alert (P0). Small PR, done via `/review` → `/ship` as the first real use of the
   loop.
2. Step 0 setup (`CLAUDE.md`, backlog, versioning, PR flow, `/setup-deploy`).
3. `/office-hours` → `/plan-ceo-review` → `/plan-eng-review` (+ `/codex`) on the design doc.
   Output: the v1 contract freeze list.
4. `publisher_set_type` ckb-testtool suite (finding 7), whatever the freeze list decides.
5. Implement the freeze decisions, redeploy testnet as v3, bump the SDK major version.
6. `/cso`, then restart multi-publisher onboarding (step 4) on the frozen contracts.
