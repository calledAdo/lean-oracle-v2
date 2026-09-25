//! Root entry: the consumer API. Never imports `@ckb-ccc/core`.

export {
  feedId,
  verifyPriceUpdate,
  decodePriceUpdate,
  selectFeeds,
  decodePriceFeedData,
  decodePublisherSetData,
  isInitialized,
  type VerifiedPrice,
  type PriceUpdate,
  type PriceMessage,
  type PriceUpdateHeader,
  type PriceFeedData,
  type PublisherSetData,
} from "./protocol/index.js";
export { MirrorClient, MirrorError, toFeedId, type MirrorClientOptions, type MirrorPrice, type MirrorUpdate } from "./mirror/index.js";
export { LeanOracleError, DecodeError, VerifyError, contractErrorName, type VerifyErrorReason } from "./errors.js";
export type { Hex } from "./types.js";
