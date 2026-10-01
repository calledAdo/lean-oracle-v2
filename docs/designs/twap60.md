# Design: TWAP60 feeds

Status: APPROVED by /plan-eng-review (2026-10-01, decisions D1–D8 below)
Date: 2026-10-01
Origin: docs/designs/v1-contract-freeze.md, item 6 (deferred out of the freeze, D1, R15).
Evidence: the T6 results in docs/designs/manipulation-resistant-pricing.md.

## Problem

T6 measured that Gate, Bitget and KuCoin show a median 79% of a Binance move within 5 s. A brief
push on the most liquid venue therefore moves the 1 s price, and the CKB/USDT median moves for
about $10.9k of buying for one tick. Anything that settles at an instant pays the cheapest attack:
up/down rounds, liquidations, option expiry. A price averaged over a window forces the attacker to
hold the move against arbitrage for the whole window.

## Proposal (as decided)

For a source feed `S` (for example `Crypto.CKB/USDT`), add a derived feed `S.TWAP60` with its own
feed ID, `ckb_hash("LEAN/FEED/V1" || "Crypto.CKB/USDT.TWAP60")`. There is one for each of the 12
source feeds (D3).

1. **Schedule.** A TWAP leaf exists only at boundary ticks: `tickMs % everyMs == 0`. `everyMs` and
   `windowMs` are configurable, 60 000 by default (D6).
2. **Window (D2).** At boundary `t`, the window holds the `S` entries in the publisher's own store of
   **finalized** updates with `t − windowMs − 2·tickPeriodMs < publishTimeMs ≤ t − 2·tickPeriodMs`:
   60 ticks, from `t − 61 s` to `t − 2 s`. This is the same two-tick lag as the EMA anchor
   (`node.ts` `anchor()`), because ticks `t` and `t − 1 s` are not yet finalized when `t` is
   observed. The TWAP labelled 12:05:00 covers 12:03:59 to 12:04:58.
3. **When a publisher observes a TWAP (D7, hardened by D8).** It needs both:
   - at least `minTicks` (45) entries in the window;
   - **no known gap**: its latest finalized tick is at or after the window end. A missing window
     tick counts against `minTicks`, but it does not by itself block the TWAP.

   Otherwise it observes no TWAP at `t`, and it does not check one as a signer, since signers only
   check feeds they observed (`node.ts:346-348`).
4. **Value.**
   - **Price (D5):** `floor(sum / count)` of the window's prices, equal weight per finalized tick,
     missing ticks skipped. Prices are positive integers; the sum is a bigint.
   - **conf (D4):** `max(floor(mean of the window's confs), MAD of the window's prices around their
     median)`. This is the same max(precision, dispersion) shape as spot conf.
   - **sourceTimeMs:** the newest tick in the window.
5. **Path into the update (D8 = A).** The TWAP entry rides in the publisher's observation for `t`
   (entries in ascending feed ID). The leader takes the median of the observations that carry it,
   and includes it when a quorum of the chosen observations does (`aggregate.ts`, unchanged). Each
   signer checks the median within `toleranceBps` of its own TWAP. The EMA is per TWAP feed, one
   step per boundary; the first boundary starts it fresh (`prevPublishTimeMs` = 0).
6. **Known limit (documented for integrators).** A leader that chooses a quorum set in which fewer
   than a quorum of observations carry the TWAP leaves that boundary without a TWAP leaf. That
   boundary is VOID, and consumers may fall back to the next boundary under their own rules. Spot
   prices are never affected, because the TWAP never enters the shared derive step (D8 rejected
   option B: one history hole there would fail the whole tick).
7. **Config transitions.** The window takes the `S` ticks finalized under any config version. A
   methodology change of `S` (such as the v2 clamp) mixes into one window. All of those are signed
   committee prices, so this is accepted. If `tickPeriodMs` changes, the window holds fewer ticks
   and may VOID until it refills.
8. **On-chain and mirror: nothing changes.** Consumers settle on "the `S.TWAP60` update with
   `publishTimeMs == boundary`".

## Config shape (committee config, SDK `FeedConfig`)

A derived feed has no markets:

```json
{ "symbol": "Crypto.CKB/USDT.TWAP60", "quote": "USDT", "feedId": "0x…", "expo": -10,
  "toleranceBps": 200, "emaHalfLifeMs": 3600000,
  "twap": { "source": "Crypto.CKB/USDT", "windowMs": 60000, "everyMs": 60000, "minTicks": 45 } }
```

Validation:
- the `source` exists in the same config and is not itself a TWAP;
- `symbol == source + ".TWAP" + windowMs/1000`, and `quote` and `expo` equal the source's;
- `everyMs` divides evenly into ticks (`everyMs % tickPeriodMs == 0`);
- `0 < minTicks ≤ windowMs / tickPeriodMs`.

The method fields (`method`, `markets`, `minVenues`, ...) are absent for TWAP feeds.

## Open questions for the review (resolved; see the decision ledger)

1. **Which feeds:** all 12 sources, or a subset?
2. **conf of a TWAP:** the mean of the window's confs, or a wider rule reflecting dispersion or
   missing ticks?
3. **Weighting:** equal weight per finalized tick (proposed), or by how long each price stood?
4. **Schedule:** a fixed 60 s, or a configurable `everyMs` (proposed configurable, default 60 s)?
5. **Publisher gaps:** a publisher that was offline holds fewer finalized ticks. The 45-tick rule
   applies to its own history; is that enough, or should it also require its history to be
   synced up to `t − tickPeriodMs`?
6. **Config transitions:** a window that spans a config-version activation, where the source's
   methodology changed (for example the v2 clamp).

## Constraints

- The on-chain format is frozen, so a TWAP is only a new feed ID.
- Publishers stay deterministic: the TWAP comes only from finalized, signed history, which every
  honest publisher shares once it is synced.
- Committee config v3 activates it on testnet (signed like v2).

## Eng review (2026-10-01)

Target: docs/designs/twap60.md. Report file: this document.

### Scope record

feature answers: none cut; structure: D1 = B (new `apps/publisher/src/twap.ts`). Accepted scope:
- the SDK `FeedConfig` union and its validation (SDK 2.1);
- `twap.ts`, a pure function;
- a store window query;
- `node.ts` merging the entries;
- skips for TWAP feeds in `runner.ts`, `mock.ts`, `main.ts` (probe, recorder depth) and the web
  feed pages and generator;
- SDK feed presets;
- the 12 TWAP feeds in `majors.template.json`;
- docs, tests, and committee config v3 on testnet.

### Decision ledger

| ID | Choice | Answer |
|---|---|---|
| D1 | Code layout | B: a new `twap.ts` module |
| D2 | Window | t−61 s … t−2 s (two-tick lag, as the anchor) |
| D3 | Feeds | all 12 |
| D4 | conf | max(mean conf, MAD of prices) |
| D5 | Weighting | equal weight per finalized tick, gaps skipped |
| D6 | Schedule | configurable `windowMs`, `everyMs`, `minTicks`, validated; the symbol suffix must match `windowMs` |
| D7 | Gap rule | ≥ minTicks and synced through the window end |
| D8 | Path | A: observations, hardened (D7 freshness = no known gap). Signer refusal is already the derive rule; a stricter refusal is rejected because it lets one lagging publisher block honest ticks. Leader-omission limit documented. 4-publisher lag test required |

Approval readiness: PASS. D1–D8 all have explicit answers from this session.

### Outside voice (Claude Plan subagent; Codex unavailable earlier)

Seven findings:
1. The doc's window contradicted D2. Fixed above.
2. The freshness gate voided a boundary when tick t−2 s failed. Fixed: no-known-gap rule.
3. Finalization lag differs between publishers. Mitigated by the D2 two-tick lag; measure it in the
   4-publisher test, and shift the window to t−3 s if needed.
4. Leader omission. Decided in D8 and documented.
5. Config activation. Resolved as Proposal 7.
6. A 1-publisher testnet hides divergence. Covered by the 4-publisher lag test.
7. Alternative: derive-based TWAP. Rejected in D8.

### Tests (node:test)

```
twap.ts computeTwap(entries, t, cfg)
  [GAP] exactly 60 ticks -> floor mean; conf = max(mean conf, MAD)
  [GAP] 45 ticks (gaps) -> value; 44 -> none
  [GAP] latest finalized < window end -> none (D7)
  [GAP] window bounds exclude t-1 s and t, include t-61 s (D2)
  [GAP] non-boundary tick -> none
  [GAP] volatile window -> conf = MAD > mean conf
SDK validateCommitteeConfig
  [GAP] valid TWAP feed; missing or TWAP source; suffix != windowMs; everyMs not a tick multiple;
        minTicks out of range; quote/expo != source; markets present on a TWAP feed -> reject
node (in-process committee, 4 publishers, tests/helpers.mjs)
  [GAP] boundary update carries all TWAP leaves; non-boundary does not
  [GAP] one publisher lagging 2 ticks sits out; the other 3 reach quorum; TWAP present
  [GAP] tick t-2 s failed to finalize -> TWAP still produced from 59 ticks
  [GAP] signer TWAP outside tolerance -> refuses (existing rule, new feed)
  [GAP] REGRESSION: config without TWAP feeds -> byte-identical updates to today
sources/mock/probe/recorder: [GAP] TWAP feeds skipped (no markets)
replay on the 3-day archive: [GAP] TWAP vs spot smoothness; share of VOID boundaries
```

### Implementation tasks

- [ ] **T1 (P1, human ~1 day / CC ~40 min)**: SDK `FeedConfig` union and validation, presets for 12
  TWAP feeds, SDK 2.1 changelog.
- [ ] **T2 (P1, human ~1 day / CC ~30 min)**: `twap.ts`, a store window query, and `node.ts`
  merging (ascending feed IDs).
- [ ] **T3 (P1, human ~4 h / CC ~20 min)**: skips for market-less feeds in the runner, mock, probe,
  recorder and web pages.
- [ ] **T4 (P1, human ~1 day / CC ~40 min)**: tests above, including the 4-publisher lag test and
  the regression test.
- [ ] **T5 (P2, human ~4 h / CC ~20 min)**: replay TWAP over the archive (smoothness, VOID rate);
  measure finalization lag versus the window end.
- [ ] **T6 (P2, human ~2 h / CC ~15 min)**: `majors.template.json` gets the TWAP feeds; committee
  config v3 signed and activated on testnet; docs (spot vs TWAP, VOID, the leader limit).

Parallelization: T1 first (types). Then T2 and T3 in parallel, then T4, then T5, then T6.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | Claude Plan subagent (Codex unavailable) | Independent 2nd opinion | 1 | unavailable (native fallback completed) | 7 findings, 1 reopened choice (D8) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES OPEN (mapped to tasks) | 10 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** codex not attempted this run (it was unavailable earlier today). A native
  Claude Plan subagent completed; it gives no outside-model coverage.
- **VERDICT:** Eng review complete, all decisions answered, ready to implement (T1–T6).

NO UNRESOLVED DECISIONS

