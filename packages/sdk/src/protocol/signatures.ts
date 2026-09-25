//! Recoverable low-S secp256k1 signature bundles. Mirrors contracts/common/src/signatures.rs.

import { secp256k1 } from "@noble/curves/secp256k1";

import { DecodeError } from "../errors.js";
import { bytesToHex, equalBytes, hexToFixed, type BytesLike, toBytes } from "../internal/bytes.js";
import { Reader, Writer } from "../internal/codec.js";
import type { Hex } from "../types.js";
import { SIGNATURE_LEN } from "./constants.js";
import { quorum, type PublisherSet } from "./publisherSet.js";

export interface IndexedSignature {
  publisherIndex: number;
  /** 64-byte compact low-S signature followed by the recovery id. */
  signature: Hex;
}

export type SignatureBundle = IndexedSignature[];

export function encodeSignatureBundle(bundle: SignatureBundle): Uint8Array {
  const writer = new Writer().u8(bundle.length);
  for (const entry of bundle) writer.u8(entry.publisherIndex).bytes(hexToFixed(entry.signature, SIGNATURE_LEN, "signature"));
  return writer.finish();
}

/** Decode a bundle at the start of `bytes`; returns it and the number of bytes used. */
export function decodeSignatureBundlePrefix(bytes: Uint8Array): { bundle: SignatureBundle; used: number } {
  const reader = new Reader(bytes, "SignatureBundle");
  const count = reader.u8();
  const bundle = Array.from({ length: count }, () => ({
    publisherIndex: reader.u8(),
    signature: bytesToHex(reader.bytes(SIGNATURE_LEN)),
  }));
  return { bundle, used: reader.offset };
}

export function decodeSignatureBundle(bytes: BytesLike): SignatureBundle {
  const data = toBytes(bytes);
  const { bundle, used } = decodeSignatureBundlePrefix(data);
  if (used !== data.length) throw new DecodeError("SignatureBundle: trailing bytes");
  return bundle;
}

/** Recover the compressed public key, or `undefined` if the signature is invalid or high-S. */
export function recoverSigner(digest: BytesLike, signature: BytesLike): Hex | undefined {
  const raw = toBytes(signature);
  if (raw.length !== SIGNATURE_LEN || raw[64]! > 3) return undefined;
  try {
    const parsed = secp256k1.Signature.fromCompact(raw.slice(0, 64)).addRecoveryBit(raw[64]!);
    if (parsed.hasHighS()) return undefined;
    return bytesToHex(parsed.recoverPublicKey(toBytes(digest)).toRawBytes(true));
  } catch {
    return undefined;
  }
}

function signedBy(digest: Uint8Array, entry: IndexedSignature, expected: Hex): boolean {
  const recovered = recoverSigner(digest, entry.signature);
  return recovered !== undefined && equalBytes(toBytes(recovered), toBytes(expected));
}

/** At least a quorum of distinct publishers, in strictly ascending index order, signed `digest`. */
export function verifyThreshold(bundle: SignatureBundle, digest: BytesLike, set: PublisherSet): boolean {
  const hash = toBytes(digest);
  if (bundle.length < quorum(set) || bundle.length > set.pubkeys.length) return false;
  return bundle.every((entry, i) => {
    const key = set.pubkeys[entry.publisherIndex];
    return (i === 0 || entry.publisherIndex > bundle[i - 1]!.publisherIndex) && key !== undefined && signedBy(hash, entry, key);
  });
}

/** Every key of `set`, in index order, signed `digest` (proof of possession). */
export function verifyAll(bundle: SignatureBundle, digest: BytesLike, set: PublisherSet): boolean {
  const hash = toBytes(digest);
  return (
    bundle.length === set.pubkeys.length &&
    bundle.every((entry, i) => entry.publisherIndex === i && signedBy(hash, entry, set.pubkeys[i]!))
  );
}
