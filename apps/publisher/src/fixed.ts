//! 18-decimal fixed-point arithmetic on bigint. Exchange prices arrive as decimal strings and never
//! touch floating point.

export const ONE = 10n ** 18n;

/** Parse a non-negative decimal string (e.g. "63012.5", "1e-5" is rejected) to 18-decimal fixed point. */
export function parseDecimal(text: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) throw new Error(`invalid decimal: ${text}`);
  const fraction = (match[2] ?? "").slice(0, 18).padEnd(18, "0");
  return BigInt(match[1]!) * ONE + BigInt(fraction);
}

export function mul(a: bigint, b: bigint): bigint {
  return (a * b) / ONE;
}

export function div(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new RangeError("division by zero");
  return (a * ONE) / b;
}

export function abs(a: bigint): bigint {
  return a < 0n ? -a : a;
}

/** Median: the middle value, or the floor of the mean of the two middle values for even counts. Deterministic. */
export function median(values: bigint[]): bigint {
  if (values.length === 0) throw new RangeError("median of nothing");
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  const sum = sorted[mid - 1]! + sorted[mid]!;
  return sum >= 0n ? sum / 2n : -((-sum + 1n) / 2n);
}

/** Convert 18-decimal fixed point to an integer at `expo` (value × 10^-expo), rounding half up. */
export function toExpo(value: bigint, expo: number): bigint {
  const shift = 18 + expo;
  if (shift < 0) return value * 10n ** BigInt(-shift);
  const divisor = 10n ** BigInt(shift);
  const sign = value < 0n ? -1n : 1n;
  return sign * ((abs(value) * 2n + divisor) / (2n * divisor));
}
