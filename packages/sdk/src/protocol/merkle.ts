//! Sorted-pair blake2b Merkle tree over price leaves; an odd node is promoted unchanged.

import { bytesToHex, compareBytes, type BytesLike, toBytes } from "../internal/bytes.js";
import type { Hex } from "../types.js";
import { ckbHash, DOMAIN_PRICE_LEAF, DOMAIN_PRICE_NODE } from "./hash.js";

export function leafHash(messageBytes: BytesLike): Hex {
  return bytesToHex(ckbHash(DOMAIN_PRICE_LEAF, toBytes(messageBytes)));
}

export function nodeHash(a: BytesLike, b: BytesLike): Hex {
  const [x, y] = [toBytes(a), toBytes(b)];
  const [lo, hi] = compareBytes(x, y) <= 0 ? [x, y] : [y, x];
  return bytesToHex(ckbHash(DOMAIN_PRICE_NODE, lo, hi));
}

function nextLevel(level: Hex[]): Hex[] {
  const out: Hex[] = [];
  for (let i = 0; i < level.length; i += 2) out.push(i + 1 < level.length ? nodeHash(level[i]!, level[i + 1]!) : level[i]!);
  return out;
}

/** Root over leaf hashes in ascending feed id order. */
export function merkleRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) throw new RangeError("merkleRoot: no leaves");
  let level = leaves;
  while (level.length > 1) level = nextLevel(level);
  return level[0]!;
}

/** Sibling path for `leaves[index]`, matching `merkleRoot`. */
export function merkleProof(leaves: Hex[], index: number): Hex[] {
  if (index < 0 || index >= leaves.length) throw new RangeError("merkleProof: index out of range");
  const proof: Hex[] = [];
  let level = leaves;
  while (level.length > 1) {
    const sibling = index ^ 1;
    if (sibling < level.length) proof.push(level[sibling]!);
    level = nextLevel(level);
    index = Math.floor(index / 2);
  }
  return proof;
}

export function verifyProof(root: BytesLike, leaf: BytesLike, proof: BytesLike[]): boolean {
  const current = proof.reduce<Hex>((node, sibling) => nodeHash(node, sibling), bytesToHex(toBytes(leaf)));
  return current === bytesToHex(toBytes(root));
}
