//! Typed SDK errors. `VerifyErrorReason` matches the Rust `VerifyError` enum.

export class LeanOracleError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Bytes that do not decode as the expected structure. */
export class DecodeError extends LeanOracleError {
  constructor(message: string) {
    super(message, "DECODE");
  }
}

export type VerifyErrorReason =
  | "Malformed"
  | "FeedNotFound"
  | "DuplicateFeed"
  | "Proof"
  | "PublisherSet"
  | "Paused"
  | "SetIndex"
  | "Signature";

/** A price update that fails verification. */
export class VerifyError extends LeanOracleError {
  constructor(readonly reason: VerifyErrorReason, message: string = reason) {
    super(message, `VERIFY_${reason.toUpperCase()}`);
  }
}

/** On-chain script error codes (contracts/common/src/errors.rs). */
export const CONTRACT_ERRORS: Readonly<Record<number, string>> = {
  [-1]: "ENCODING",
  [-2]: "SYSCALL",
  11: "INVALID_SCRIPT_GROUP",
  12: "CONFIG_MUTATED",
  14: "TYPE_ID_INVALID",
  60: "PUBLISHER_SET_MALFORMED",
  61: "PUBLISHER_SET_CONTINUITY",
  62: "PUBLISHER_SET_AUTH",
  63: "PUBLISHER_SET_POP",
  64: "PUBLISHER_SET_OPERATION",
  80: "FEED_DATA_MALFORMED",
  81: "FEED_ID_MISMATCH",
  82: "FEED_CREATION_NONZERO",
  83: "FEED_NOT_FORWARD",
  84: "FEED_WITNESS_MALFORMED",
  85: "FEED_SET_DEP",
  86: "UPDATE_MALFORMED",
  87: "UPDATE_FEED_NOT_FOUND",
  88: "UPDATE_PROOF",
  89: "UPDATE_SET",
  90: "UPDATE_SIGNATURE",
  91: "UPDATE_MISMATCH",
};

/** Name of an on-chain script error code, e.g. `83 → "FEED_NOT_FORWARD"`. */
export function contractErrorName(code: number): string | undefined {
  return CONTRACT_ERRORS[code];
}
