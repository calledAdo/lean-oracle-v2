# Changelog

## 1.0.0

First stable release of the Lean Oracle SDK; same code as 1.0.0-beta.1.

- Replaces `lean-oracle-sdk` 0.x (Pyth/Hermes-based), which is deprecated. There is no
  compatibility with 0.x; see "Migrating from 0.x" in the README.
- Testnet: reproducible contracts (v2), committees `majors` and `ckb`, public mirror. Mainnet is not
  deployed yet; `LeanOracleMainnetClient` throws until it is.
- Reference consumer: `examples/price_trigger_lock` and `examples/price-trigger-ts` in the repository.

## 1.0.0-beta.1

- Testnet preset points to the v2 deployment: reproducible contracts (`contracts/checksums.txt`,
  `scripts/build-contracts.sh`) and new `majors` / `ckb` committees. The v1 contracts were retired;
  feed cells created under v1 no longer move — create new ones.
- Deployment records mark retired contract versions and committees; the SDK ignores them.

## 1.0.0-beta.0

First release of the Lean Oracle committee oracle. Replaces the Pyth/Hermes-based 0.x, which is a
different protocol with no compatibility.

- Committee-signed, Merkle-batched price updates (`/protocol`), with verification matching the
  on-chain scripts and shared test vectors.
- `LeanOracleClient` with testnet and mainnet presets (`/client`).
- `MirrorClient` for the public mirror API (`/mirror`): latest, at-time, range, stream; failover;
  values taken only from signed updates.
- Transaction builders (`/tx`): feed cells (create, update, burn, `pullAndUpdate`), committees
  (bootstrap, rotate), greedy fee completion (`completeFee`).
- Testnet deployment embedded in `/presets`.
