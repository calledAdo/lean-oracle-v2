# Threshold Price Oracle

A pull price oracle for CKB. Committees of permissioned publishers sign one Merkle-batched price
update per tick, a public mirror serves the signed updates, and any project forward-updates its own
price feed cells with them. The full design is in [docs/oracle-design.md](docs/oracle-design.md).

## Layout

- `contracts/common` (`lean-oracle-common`): shared protocol code — PublisherSet, signature bundles, price update
  header/leaf codecs, Merkle proofs, `verify_price_update`, feed cell data.
- `contracts/publisher_set_type`: committee cell (keys, derived quorum, rotation).
- `contracts/price_feed_type`: Type ID-unique feed cells that only move forward in time.
- `tests`: host and `ckb-testtool` tests; generates `vectors/protocol.json`.
- `vectors/protocol.json`: cross-language test vectors shared by the Rust and TypeScript tests.
- `packages/sdk` (`lean-oracle-sdk`): TypeScript SDK ([design](docs/sdk-design.md)): root, `/protocol`,
  `/publisher`, `/mirror`, `/ckb`, `/tx`, `/presets`.
- `apps/publisher` (`lean-oracle-publisher`): the publisher service, distributed as a Docker image
  ([operator guide](apps/publisher/README.md)).
- `apps/mirror` (`lean-oracle-mirror`): the public read API; ingests and verifies finalized updates
  from publishers and serves them. Docker image ([README](apps/mirror/README.md)).
- `apps/deploy` (`lean-oracle-deploy`): contract deployment, committee bootstrap/rotation, and the
  devnet end-to-end test ([README](apps/deploy/README.md)).
- `examples/price_trigger_lock` + `examples/price-trigger-ts`: a reference consumer. An on-chain lock
  that releases funds when a Lean Oracle price crosses a strike, and a script that runs the full
  flow on testnet ([README](examples/price-trigger-ts/README.md)).
- `deployments/<network>.json`: deployment records written by `lean-oracle-deploy`.

## Build and test

Contracts are pinned to Rust 1.92 because Rust 1.98 emits unsupported atomics for this CKB target.
They are built **reproducibly** inside a pinned Docker image, so anyone can rebuild them and get the
deployed code hashes ([`contracts/checksums.txt`](contracts/checksums.txt)). Build the contracts
before running the tests, which load the RISC-V binaries.

```sh
scripts/build-contracts.sh
cargo test --workspace --target aarch64-apple-darwin
npm install && npm test
```

After changing contract code, record the new hashes with `scripts/build-contracts.sh --update`.

After an intentional format change, regenerate the vectors with
`LEAN_WRITE_VECTORS=1 cargo test -p tests --target aarch64-apple-darwin vectors`.
