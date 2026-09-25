# Example: price-triggered release

An end-to-end Lean Oracle consumer on CKB testnet, with the on-chain lock in
[`examples/price_trigger_lock`](../price_trigger_lock/src/main.rs).

The lock holds CKB for a beneficiary until a Lean Oracle price crosses a strike; the owner can take
it back at any time. Anyone (a keeper) can release it once the condition holds, by putting the
pinned feed cell in the cell deps. It shows the consumer patterns from
[spec section 9](../../docs/oracle-design.md):

- pin **your own feed cell** by type hash, and check its committee;
- prove freshness without a clock: the price must be **published after the block that created the
  locked cell** (loaded through a header dep);
- compare at the strike's exponent (`lean_oracle_common::consumer::price_at_expo`).

Reading the price costs about 38,000 cycles; the quorum signatures are verified once, when the feed
cell is updated.

```bash
npm install
```

```bash
LEAN_KEY_FILE=../../secrets/testnet-deployer.key node index.mjs
```

The first run deploys the lock code (about 28,700 CKB) and a feed cell, and caches both in
`deployment.testnet.json` and `feed.testnet.json`. Each run then locks 250 CKB with a strike 1%
below the current BTC/USDT price, updates the feed cell and releases the funds.
