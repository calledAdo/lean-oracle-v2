//! Publisher-side signing. Deterministic (RFC 6979), low-S, recoverable: the same key and digest
//! always produce the same 65 bytes as the Rust (k256) signer.

import { secp256k1 } from "@noble/curves/secp256k1";

import { bytesToHex, concatBytes, hexToFixed, type BytesLike, toBytes } from "../internal/bytes.js";
import { priceUpdateSigningHash, type PriceUpdateHeader } from "../protocol/priceUpdate.js";
import { publisherSetPopHash, publisherSetUpdateHash, type PublisherSetData } from "../protocol/publisherSet.js";
import type { IndexedSignature, SignatureBundle } from "../protocol/signatures.js";
import { observationSigningHash, type Observation, type SignedObservation } from "../protocol/observation.js";
import { committeeConfigHash, type CommitteeConfig } from "../protocol/committeeConfig.js";
import type { Hex } from "../types.js";

/** Compressed (33-byte) public key of a 32-byte private key. */
export function publicKeyOf(privateKey: Hex): Hex {
  return bytesToHex(secp256k1.getPublicKey(hexToFixed(privateKey, 32, "privateKey"), true));
}

/** 65-byte signature: compact low-S `r || s` followed by the recovery id. */
export function signDigest(digest: BytesLike, privateKey: Hex): Hex {
  const signature = secp256k1.sign(toBytes(digest), hexToFixed(privateKey, 32, "privateKey"), { lowS: true });
  return bytesToHex(concatBytes(signature.toCompactRawBytes(), Uint8Array.of(signature.recovery)));
}

/** Sign a price update header as `publisherIndex` of the current set. */
export function signPriceUpdateHeader(header: PriceUpdateHeader, privateKey: Hex, publisherIndex: number): IndexedSignature {
  return { publisherIndex, signature: signDigest(priceUpdateSigningHash(header), privateKey) };
}

/** Sort by publisher index and reject duplicates, as the on-chain verifier requires. */
export function toSignatureBundle(signatures: IndexedSignature[]): SignatureBundle {
  const bundle = [...signatures].sort((a, b) => a.publisherIndex - b.publisherIndex);
  bundle.forEach((entry, i) => {
    if (i > 0 && entry.publisherIndex === bundle[i - 1]!.publisherIndex) throw new RangeError(`duplicate publisher ${entry.publisherIndex}`);
  });
  return bundle;
}

/** A current publisher's signature authorizing rotation `current → next`. */
export function signRotation(current: PublisherSetData, next: PublisherSetData, operation: number, privateKey: Hex, publisherIndex: number): IndexedSignature {
  return { publisherIndex, signature: signDigest(publisherSetUpdateHash(current, next, operation), privateKey) };
}

/** A next-set publisher's proof of possession of its key. */
export function signProofOfPossession(next: PublisherSetData, privateKey: Hex, publisherIndex: number): IndexedSignature {
  return { publisherIndex, signature: signDigest(publisherSetPopHash(next), privateKey) };
}

/** Sign this publisher's observation for a tick. */
export function signObservation(observation: Observation, privateKey: Hex): SignedObservation {
  return { observation, signature: signDigest(observationSigningHash(observation), privateKey) };
}

/** Approve a committee config version. */
export function signCommitteeConfig(config: CommitteeConfig, privateKey: Hex, publisherIndex: number): IndexedSignature {
  return { publisherIndex, signature: signDigest(committeeConfigHash(config), privateKey) };
}

/**
 * Turn a plain ECDSA signature (DER, or 64-byte compact `r || s`) over `digest` into the 65-byte
 * recoverable low-S form, finding the recovery id that yields `publicKey`. For signers that do not
 * return a recovery id, such as cloud KMS.
 */
export function toRecoverableSignature(signature: BytesLike, digest: BytesLike, publicKey: Hex): Hex {
  const raw = toBytes(signature);
  const parsed = raw.length === 64 ? secp256k1.Signature.fromCompact(raw) : secp256k1.Signature.fromDER(raw);
  const normalized = parsed.normalizeS();
  const hash = toBytes(digest);
  for (const recovery of [0, 1]) {
    const candidate = normalized.addRecoveryBit(recovery);
    try {
      if (bytesToHex(candidate.recoverPublicKey(hash).toRawBytes(true)) === publicKey.toLowerCase()) {
        return bytesToHex(concatBytes(normalized.toCompactRawBytes(), Uint8Array.of(recovery)));
      }
    } catch {
      // Try the other recovery id.
    }
  }
  throw new Error("signature does not match the expected public key");
}

/** Compressed public key from an uncompressed/compressed point or a DER SubjectPublicKeyInfo. */
export function compressPublicKey(key: BytesLike): Hex {
  let bytes = toBytes(key);
  if (bytes.length > 65) bytes = bytes.slice(bytes.length - 65); // SPKI: the point is the trailing BIT STRING
  return bytesToHex(secp256k1.ProjectivePoint.fromHex(bytes).toRawBytes(true));
}
