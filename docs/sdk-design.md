# lean-oracle-sdk — Design

`lean-oracle-sdk` 1.x is the single TypeScript SDK for the threshold price oracle
([oracle-design.md](oracle-design.md)). It replaces the Pyth-based `lean-oracle-sdk` 0.x, which
is deprecated. Frontends, projects, keepers, publishers, the mirror and deployment scripts all use
this one package, and each imports only the subpaths it needs. On-chain consumers use the Rust
crate `lean-oracle-common`, which has the same formats and rules.

## Principles

1. **Layered by dependency weight.** Each layer depends only on lower layers. Code that does not
   touch CKB never loads `@ckb-ccc/core`.
2. **One package, subpath exports.** The wire formats change together, so they ship together.
3. **A pure, portable protocol layer.** It depends only on `@noble/hashes` and `@noble/curves`, and
   runs in browsers, Node and workers.
4. **Mirrors the Rust crate.** It uses the same names, byte layouts and error reasons. Both
   languages are tested against one committed vector file, `vectors/protocol.json`.
5. **Never holds users' keys.** Transaction builders return unsigned CCC transactions. Only
   `/publisher` signs, and only with keys passed in explicitly.

## Subpaths

| Import | Contents | Depends on |
|---|---|---|
| `lean-oracle-sdk` | Curated consumer API: types, `feedId`, `MirrorClient`, `verifyPriceUpdate`, errors | protocol, mirror |
| `/protocol` | Codecs (PublisherSet, update header, message, blob, feed cell, observation, committee config), domain tags, `feedId`, Merkle, SignatureBundle, `verifyPriceUpdate` | noble |
| `/publisher` | Signing of headers, observations and configs; key helpers | protocol |
| `/mirror` | `MirrorClient`: `latest`, `at`, `range`, `feeds`, `stream`; values decoded from the blob, optional verification against committee data, failover across URLs; injectable fetch/WebSocket, AbortSignal | protocol |
| `/ckb` | Committee and feed cell reads, script builders, Type ID, network clients | protocol, CCC |
| `/tx` | Unsigned builders: create/update/burn feed cell, bootstrap/rotate committee, fees (`pullAndUpdate` with `/mirror`) | ckb |
| `/presets` | Per-network deployments, committees and the feed registry | protocol types |

Internal modules (`src/internal`) are not exported. The exports map blocks deep imports.

## Packaging

- ESM only, `"type": "module"`, Node ≥ 20, `sideEffects: false`.
- `exports` has one entry per subpath (`types` first) plus `./package.json`. `files` is `dist`,
  `README.md` and `LICENSE`.
- `@noble/hashes` and `@noble/curves` are dependencies. `@ckb-ccc/core` is an optional peer
  dependency.
- Compiler settings: `strict`, `NodeNext`, `verbatimModuleSyntax`, `isolatedModules`, `declaration`
  and `declarationMap`.
- Types:
  - `bigint` for 64-bit values;
  - `Uint8Array` internally;
  - branded `Hex` at the API edges;
  - `encodeX` / `decodeX` pairs;
  - typed `LeanOracleError` with codes.
- CI gates:
  - unit tests against `vectors/protocol.json`;
  - a layering test (protocol, publisher, mirror and root never import CCC);
  - a pack test that imports every subpath from the built tarball;
  - `publint` and `@arethetypeswrong/cli`.
- Semver. A change to any on-chain or wire format is a major version.
