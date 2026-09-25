//! Price feed cell data. Mirrors contracts/common/src/price_feed.rs.

import { DecodeError } from "../errors.js";
import { bytesToHex, hexToFixed, type BytesLike, toBytes } from "../internal/bytes.js";
import { Reader, Writer } from "../internal/codec.js";
import type { Hex } from "../types.js";
import { PRICE_FEED_LEN } from "./constants.js";
import type { VerifiedPrice } from "./verify.js";

export interface PriceFeedData {
  feedId: Hex;
  publisherSetTypeHash: Hex;
  price: bigint;
  conf: bigint;
  expo: number;
  /** Committee-signed time of the stored price; zero until the first authenticated update. */
  publishTimeMs: bigint;
  prevPublishTimeMs: bigint;
  emaPrice: bigint;
  emaConf: bigint;
  sourceTimeMs: bigint;
  numPublishers: number;
}

export function encodePriceFeedData(data: PriceFeedData): Uint8Array {
  return new Writer()
    .bytes(hexToFixed(data.feedId, 32, "feedId"))
    .bytes(hexToFixed(data.publisherSetTypeHash, 32, "publisherSetTypeHash"))
    .i64(data.price)
    .u64(data.conf)
    .i32(data.expo)
    .u64(data.publishTimeMs)
    .u64(data.prevPublishTimeMs)
    .i64(data.emaPrice)
    .u64(data.emaConf)
    .u64(data.sourceTimeMs)
    .u8(data.numPublishers)
    .finish();
}

export function decodePriceFeedData(bytes: BytesLike): PriceFeedData {
  const reader = new Reader(toBytes(bytes), "PriceFeedData");
  if (reader.remaining() !== PRICE_FEED_LEN) throw new DecodeError(`PriceFeedData: expected ${PRICE_FEED_LEN} bytes`);
  return {
    feedId: bytesToHex(reader.bytes(32)),
    publisherSetTypeHash: bytesToHex(reader.bytes(32)),
    price: reader.i64(),
    conf: reader.u64(),
    expo: reader.i32(),
    publishTimeMs: reader.u64(),
    prevPublishTimeMs: reader.u64(),
    emaPrice: reader.i64(),
    emaConf: reader.u64(),
    sourceTimeMs: reader.u64(),
    numPublishers: reader.u8(),
  };
}

/** Data for a newly created cell: configuration only, every price and time field zero. */
export function uninitializedPriceFeed(feedId: Hex, publisherSetTypeHash: Hex): PriceFeedData {
  return {
    feedId,
    publisherSetTypeHash,
    price: 0n,
    conf: 0n,
    expo: 0,
    publishTimeMs: 0n,
    prevPublishTimeMs: 0n,
    emaPrice: 0n,
    emaConf: 0n,
    sourceTimeMs: 0n,
    numPublishers: 0,
  };
}

/** A nonzero `publishTimeMs` means the cell holds at least one authenticated price. */
export function isInitialized(data: PriceFeedData): boolean {
  return data.publishTimeMs !== 0n;
}

/** The cell data an on-chain update with `verified` must produce. */
export function applyVerifiedPrice(current: PriceFeedData, verified: VerifiedPrice): PriceFeedData {
  const m = verified.message;
  return {
    ...current,
    price: m.price,
    conf: m.conf,
    expo: m.expo,
    publishTimeMs: verified.header.publishTimeMs,
    prevPublishTimeMs: m.prevPublishTimeMs,
    emaPrice: m.emaPrice,
    emaConf: m.emaConf,
    sourceTimeMs: m.sourceTimeMs,
    numPublishers: m.numPublishers,
  };
}
