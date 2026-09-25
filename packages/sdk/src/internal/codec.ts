//! Little-endian writer/reader mirroring Rust `to_le_bytes` / `from_le_bytes`, with range checks.

import { DecodeError } from "../errors.js";

export class Writer {
  private readonly parts: Uint8Array[] = [];

  bytes(value: Uint8Array, length?: number): this {
    if (length !== undefined && value.length !== length) throw new RangeError(`expected ${length} bytes, got ${value.length}`);
    this.parts.push(value);
    return this;
  }

  u8(value: number): this { return this.int(value, 1, 0n, 0xffn); }
  u16(value: number): this { return this.int(value, 2, 0n, 0xffffn); }
  u32(value: number): this { return this.int(value, 4, 0n, 0xffffffffn); }
  i32(value: number): this { return this.int(value, 4, -(2n ** 31n), 2n ** 31n - 1n); }
  u64(value: bigint): this { return this.int(value, 8, 0n, 2n ** 64n - 1n); }
  i64(value: bigint): this { return this.int(value, 8, -(2n ** 63n), 2n ** 63n - 1n); }

  finish(): Uint8Array {
    const out = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  private int(value: number | bigint, size: number, min: bigint, max: bigint): this {
    const big = BigInt(value);
    if (typeof value === "number" && !Number.isInteger(value)) throw new RangeError(`not an integer: ${value}`);
    if (big < min || big > max) throw new RangeError(`${value} out of range [${min}, ${max}]`);
    const out = new Uint8Array(size);
    let unsigned = big < 0n ? big + (1n << BigInt(size * 8)) : big;
    for (let i = 0; i < size; i++) {
      out[i] = Number(unsigned & 0xffn);
      unsigned >>= 8n;
    }
    this.parts.push(out);
    return this;
  }
}

export class Reader {
  offset = 0;

  constructor(private readonly data: Uint8Array, private readonly what: string) {}

  bytes(length: number): Uint8Array {
    const end = this.offset + length;
    if (end > this.data.length) throw new DecodeError(`${this.what}: truncated`);
    const out = this.data.slice(this.offset, end);
    this.offset = end;
    return out;
  }

  u8(): number { return Number(this.uint(1)); }
  u16(): number { return Number(this.uint(2)); }
  u32(): number { return Number(this.uint(4)); }
  i32(): number { return Number(BigInt.asIntN(32, this.uint(4))); }
  u64(): bigint { return this.uint(8); }
  i64(): bigint { return BigInt.asIntN(64, this.uint(8)); }

  remaining(): number { return this.data.length - this.offset; }

  end(): void {
    if (this.offset !== this.data.length) throw new DecodeError(`${this.what}: trailing bytes`);
  }

  private uint(size: number): bigint {
    const bytes = this.bytes(size);
    let value = 0n;
    for (let i = size - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]!);
    return value;
  }
}
