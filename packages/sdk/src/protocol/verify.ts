//! Price update verification. Same checks and order as Rust `verify_price_update`.

import { VerifyError } from "../errors.js";
import { type BytesLike } from "../internal/bytes.js";
import type { Hex } from "../types.js";
import { GOVERNANCE_PAUSED } from "./constants.js";
import { leafHash, verifyProof } from "./merkle.js";
import { decodePriceUpdate, encodePriceMessage, priceUpdateSigningHash, type PriceMessage, type PriceUpdate, type PriceUpdateHeader } from "./priceUpdate.js";
import { setFor, type PublisherSetData } from "./publisherSet.js";
import { verifyThreshold } from "./signatures.js";

export interface VerifiedPrice {
  header: PriceUpdateHeader;
  message: PriceMessage;
}

/**
 * Verify one feed's price in an update against the committee cell's current data.
 * Accepts the current set, or the previous set for ticks before its switch. Throws `VerifyError` with the same reasons as the Rust verifier.
 */
export function verifyPriceUpdate(
  update: BytesLike | PriceUpdate,
  feedId: Hex,
  publisherSetTypeHash: Hex,
  publisherSet: PublisherSetData,
): VerifiedPrice {
  let decoded: PriceUpdate;
  try {
    decoded = typeof update === "string" || update instanceof Uint8Array ? decodePriceUpdate(update) : update;
  } catch (error) {
    throw new VerifyError("Malformed", error instanceof Error ? error.message : String(error));
  }
  const matches = decoded.entries.filter((e) => e.message.feedId.toLowerCase() === feedId.toLowerCase());
  if (matches.length > 1) throw new VerifyError("DuplicateFeed");
  const entry = matches[0];
  if (!entry) throw new VerifyError("FeedNotFound", `feed ${feedId} is not in this update`);
  if (!verifyProof(decoded.header.merkleRoot, leafHash(encodePriceMessage(entry.message)), entry.proof)) {
    throw new VerifyError("Proof");
  }
  if (decoded.header.publisherSetTypeHash.toLowerCase() !== publisherSetTypeHash.toLowerCase()) {
    throw new VerifyError("PublisherSet", "update was signed for a different committee");
  }
  if ((publisherSet.governanceFlags & GOVERNANCE_PAUSED) !== 0) throw new VerifyError("Paused");
  const set = setFor(publisherSet, decoded.header.setIndex, decoded.header.publishTimeMs);
  if (!set) throw new VerifyError("SetIndex", `set index ${decoded.header.setIndex} may not sign tick ${decoded.header.publishTimeMs}`);
  if (!verifyThreshold(decoded.signatures, priceUpdateSigningHash(decoded.header), set)) throw new VerifyError("Signature");
  return { header: decoded.header, message: entry.message };
}
