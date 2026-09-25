# lean-oracle-deploy

Deploys the Lean Oracle contracts and committee cells. Same flow as lean-oracle 0.x:
**build → deploy → record → SDK presets**.

- `config/<network>.json` (checked in): RPC, fee rate, binary paths, and each committee's intended
  publisher keys.
- `.env` (git-ignored, see `.env.example`): the deployer key (`<NET>_DEPLOYER_PRIVATE_KEY` or
  `<NET>_DEPLOYER_KEY_FILE`) and optional `<NET>_CKB_RPC_URL`.
- `deployments/<network>.json` (repository root): the **append-only** record. Every contract
  version, every committee (with the contract version it was created under), every rotation, and a
  history of every broadcast. Nothing is overwritten: a new binary becomes version `n + 1` and
  `current` moves to it.
- After every broadcast on testnet or mainnet, the record is embedded into the SDK
  (`packages/sdk/src/presets/deployments.generated.ts`), so the next SDK build's
  `LeanOracleTestnetClient` uses it.

## Commands

Every action is a **dry run** that builds the full transaction and reports what it would lock and
pay. Add `--broadcast` (or `BROADCAST=true`) to send.

```bash
npm run build -w lean-oracle-sdk -w lean-oracle-deploy
```

```bash
npm run validate:config -w lean-oracle-deploy -- deploy:code --network testnet
```

```bash
npm run deploy:code -w lean-oracle-deploy -- --network testnet --broadcast
```

```bash
npm run deploy:committee -w lean-oracle-deploy -- --network testnet --name majors --broadcast
```

```bash
npm run show -w lean-oracle-deploy -- --network testnet
```

- `deploy:code` builds the contracts first (`--skip-build` to reuse), then deploys only the
  contracts whose binary differs from the current live version.
- `deploy:committee` creates a committee from `config.committees[name]` (1–9 keys; quorum
  `floor(2n/3)+1`; `networkId` defaults to the chain's genesis hash). A committee is created once;
  change its keys with `rotate:committee`.
- `rotate:committee --next <set.hex> --authorization <sigs.json> --pop <sigs.json>`: `sigs.json` is a
  list of `{ publisherIndex, signature }` (`signRotation` from the current quorum;
  `signProofOfPossession` from every next key).
- `sync:presets` re-embeds the public records into the SDK by hand.

Contracts are deployed as plain code cells referenced by `data2`: immutable, with no upgrade key. A
fix is a new version with a new code hash; existing cells keep the version they were created with,
and the SDK picks the matching code dep automatically.

## Devnet end-to-end test

Requirements:
- `offckb` devnet running on `127.0.0.1:8114`;
- `npm run deploy:code -- --network devnet --broadcast` done (with `DEVNET_DEPLOYER_PRIVATE_KEY`);
- the publisher image built: `docker build -f apps/publisher/Dockerfile -t lean-oracle-publisher:dev .`.

```sh
LEAN_DEVNET=1 node --test apps/deploy/tests/
```

The test performs these steps:
1. Bootstraps a fresh committee of 4 keys and runs 4 publisher containers (mock markets), which
   read the committee cell from the chain.
2. A project (offckb account #1) creates its own BTC/USD feed cell and moves it forward twice.
3. It checks that the contracts reject a stale update (`FEED_NOT_FORWARD`, 83) and a tampered
   output (`UPDATE_MISMATCH`, 91).
4. It initializes a fresh cell from a past update.
5. It rotates the committee, then checks that old-set updates are rejected (`UPDATE_SET`, 89).
6. It burns a cell.

It uses offckb's well-known genesis keys, which are public and valid on devnet only.
