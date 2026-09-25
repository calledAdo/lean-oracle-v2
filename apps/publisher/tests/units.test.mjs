import assert from "node:assert/strict";
import { test } from "node:test";

import { emaTauMs, nextEma, withinTolerance } from "../dist/aggregate.js";
import { median, parseDecimal, toExpo } from "../dist/fixed.js";

test("fixed-point parsing, rounding and medians", () => {
  assert.equal(parseDecimal("65000.12345678"), 65000123456780000000000n);
  assert.throws(() => parseDecimal("1e5"));
  assert.equal(toExpo(parseDecimal("0.0012716"), -10), 12_716_000n);
  assert.equal(toExpo(parseDecimal("65000.123456785"), -8), 6_500_012_345_679n);
  assert.equal(median([5n, 1n, 3n, 9n]), 4n);
  assert.equal(median([5n, 1n, 4n, 9n]), 4n, "floor of the mean of the middle two");
  assert.equal(median([-5n, -2n]), -4n, "floor, not truncation, for negatives");
  assert.equal(median([7n]), 7n);
});

test("integer EMA and tolerance", () => {
  const tau = emaTauMs(3_600_000);
  assert.equal(tau, 5_193_703n);
  assert.equal(nextEma(undefined, 100n, 0n, tau), 100n);
  assert.equal(nextEma(1_000_000n, 2_000_000n, tau, tau), 1_500_000n);
  assert.equal(nextEma(1_000_000n, 2_000_000n, 1000n, tau), 1_000_192n);
  assert.ok(withinTolerance(10_050n, 10_000n, 50));
  assert.ok(!withinTolerance(10_051n, 10_000n, 50));
});
