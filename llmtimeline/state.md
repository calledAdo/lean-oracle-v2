> llmtimeline · cross-agent work record. state.md is the live snapshot — rewrite it in place. sessions/ is append-only history — never edit past files. Any agent: read this file and the newest sessions/ entries before starting.

# Project State — updated 2026-09-30T08:51Z by codex (session 010)

## Goal
Operate the testnet oracle reliably and complete the recorded-data evaluation of manipulation-resistant pricing (T6), then activate a reviewed candidate configuration (T7).

## Tasks
- [x] Session 010: September 30 archive sync complete; 74 hourly files through 08 UTC, no missing filenames, 72 pass gzip validation.
- [x] Contract freeze T1–T11, testnet v3, SDK 2.0.0 release (session 008).
- [x] Storage retention and pricing recorder T1–T5 landed in main through 3dc4302.
- [x] Verify interrupted recorder fix: PR #4 already existed; add late-response shutdown guard in 61bc298 and pass all 86 JS tests.
- [x] Refresh /Users/adokiye/lean-recordings through current hour 2026-09-29T12; check 54 gzip files.
- [x] Read resource log and verify deployed image.
- [ ] Check remaining CI for PR #4, merge and deploy the reviewed fix when authorized.
- [ ] Preserve recordings daily; T6 needs 3+ days, available after approximately 2026-09-30T08:00Z.
- [ ] T6: assess data gaps/fidelity, compare v1/candidate, omissions, confidence and publisher divergence; then T7 config activation.
- [ ] Investigate sustained server load; compare matched periods before attributing overhead to recording.
- [ ] Backlog: TWAP60, depth filter/venue caps, COST1PCT, additional publishers/mainnet readiness. See session 008 and design docs.

## Summary
September 30 update: rsync completed successfully after two network interruptions. Local ~/lean-recordings now contains 74 hourly files from September 27 07 UTC through September 30 08 UTC, totaling 2,674,099,913 bytes. No missing hourly filenames. All 72 closed files other than the known damaged September 27 12 UTC file pass gzip validation; current September 30 08 UTC file is incomplete as expected. This validates archive files, not event-level continuity. T6 time target has now passed; analysis remains pending.

The interrupted agent had committed and pushed 83a6603 and opened https://github.com/calledAdo/lean-oracle-v2/pull/4; all original CI checks passed. Review reproduced a late depth response reopening a recorder after close. Commit 61bc298 makes close terminal for recording while preserving market-data forwarding, with a regression test. Full local JS suite passes (SDK 20, publisher 58, mirror 6, watchdog 2). Updated PR JS CI passes; contract and devnet CI were running at last check.

Droplet services still run sha-3dc4302 as independently verified September 29. No deployment or merge performed. Resource log: 288 samples through 12:40Z; disk 10.75/24.88 GB (43%); mirror 2.06 GB; publisher excluding recordings 0.399 GB; recordings 1.882 GB; backups 0.962 GB. Recordings grew 877 MB/day over ~48 h, implying ~2.45 days under 2 GiB and threshold reached in ~7 h at that rate. Last-24h five-minute load median 2.82; available memory minimum 237 MB; swap maximum 496 MB. Sampled CPU cannot establish recorder causation.

Local archive refreshed successfully: 54 files, September 27 hour 07 through September 29 hour 12. Standard gzip validation finds only the known broken September 27 hour 12 and the still-open September 29 hour 12; all other files pass. Original compressed files preserved. Recovery reader supports the known truncated concatenated-member case; this does not prove uninterrupted data or exact replay fidelity.

## Next
Review PR #4 CI for head 61bc298. Merge/deploy needs a distinct live-change step; no live changes made this session. Refresh the existing archive with rsync (without --delete) daily, including previously partial hours. After September 30 08:00Z evaluate coverage and run T6 per docs/designs/manipulation-resistant-pricing.md; do not load three days blindly into the current in-memory replay without assessing memory needs. The 2 GiB recorder threshold is enforced at hourly rotation, so it is not a strict instantaneous disk ceiling.

## Notes
- Build: `CC_riscv64imac_unknown_none_elf=riscv64-elf-gcc cargo build --release`; test: `cargo test --workspace --target aarch64-apple-darwin` (tests load the RISC-V binaries, so build first). Rust pinned to 1.92 (1.98 emits unsupported atomics).
- tests/ pins ckb-testtool =1.0.1 and the ckb 1.1.0 crate family (newer ckb crates need rustc 1.95), same as lean-oracle; it is excluded from workspace default-members.
- All contracts use hash_type data2, immutable, no upgrade key.
- This machine's ISP DNS resolvers (2c0f:f5c0:…, 10.116.10.22) do not answer for exchange domains, and Kraken/OKX/KuCoin IPs are blocked; use `network.dns: { mode: "doh" }` / probe `--doh`. Sandboxed shells have no DNS at all — live network checks need dangerouslyDisableSandbox.
- Docker CLI works on this machine (symlink fixed by the user on 2026-09-24; Docker Desktop 4.91, engine 29.8, arm64).
- Devnet e2e: offckb devnet on 127.0.0.1:8114, `deploy-code` done, image lean-oracle-publisher:dev built, then `LEAN_DEVNET=1 node --test apps/deploy/tests/`. Uses offckb genesis keys #0 (deployer) and #1 (project).
- JS tests: `npm test` at repo root (SDK then publisher). Local committee: apps/publisher/README.md.
- SDK tests: `npm test` (builds, then node --test packages/sdk/tests). Regenerate vectors: `LEAN_WRITE_VECTORS=1 cargo test -p tests --target aarch64-apple-darwin vectors`.
- A pre-cleanup snapshot of the repo was saved in session 004's scratchpad (temporary; not durable).
