//! Hex and byte helpers. Browser-safe: no `Buffer`.

import type { Hex } from "../types.js";

export function isHex(value: unknown): value is Hex {
  return typeof value === "string" && /^0x([0-9a-fA-F]{2})*$/.test(value);
}

export function hexToBytes(hex: string): Uint8Array {
  if (!isHex(hex)) throw new TypeError(`invalid 0x-prefixed hex: ${hex}`);
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

/** Decode hex and assert it is exactly `length` bytes. */
export function hexToFixed(hex: string, length: number, field: string): Uint8Array {
  const bytes = hexToBytes(hex);
  if (bytes.length !== length) throw new TypeError(`${field} must be ${length} bytes, got ${bytes.length}`);
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): Hex {
  let out = "0x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out as Hex;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Lexicographic byte order, as Rust compares `[u8; N]`. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

export type BytesLike = Hex | Uint8Array;

export function toBytes(value: BytesLike): Uint8Array {
  return typeof value === "string" ? hexToBytes(value) : value;
}
