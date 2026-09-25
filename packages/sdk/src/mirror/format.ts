//! Mirror API wire format (JSON). 64-bit values are decimal strings. `blob` is a price update
//! carrying only the requested feeds (each with its Merkle proof), ready for a feed cell witness.

import { bytesToHex, isHex } from "../internal/bytes.js";
import { feedId as feedIdOf } from "../protocol/hash.js";
import { decodePriceUpdate, encodePriceUpdate, selectFeeds, type PriceMessage, type PriceUpdate } from "../protocol/priceUpdate.js";
import type { Hex } from "../types.js";

export interface MirrorPriceJson {
  feedId: Hex;
  price: string;
  conf: string;
  expo: number;
  emaPrice: string;
  emaConf: string;
  prevPublishTimeMs: string;
  sourceTimeMs: string;
  numPublishers: number;
}

export interface MirrorUpdateJson {
  /** Committee (publisher set type hash). */
  committee: Hex;
  publishTimeMs: string;
  blob: Hex;
  prices: MirrorPriceJson[];
}

/** A price as the SDK returns it, decoded from the blob (never from the JSON fields). */
export interface MirrorPrice extends PriceMessage {
  committee: Hex;
  publishTimeMs: bigint;
}

export interface MirrorUpdate {
  committee: Hex;
  publishTimeMs: bigint;
  /** Update carrying just these feeds; pass it to `updateFeedCell`. */
  blob: Hex;
  prices: MirrorPrice[];
}

/** A feed ID (0x + 64 hex) as is, or a symbol such as `Crypto.BTC/USDT` hashed to its ID. */
export function toFeedId(idOrSymbol: string): Hex {
  return isHex(idOrSymbol) && idOrSymbol.length === 66 ? (idOrSymbol.toLowerCase() as Hex) : feedIdOf(idOrSymbol);
}

/** Server side: the JSON for `update` restricted to `feedIds`. */
export function mirrorUpdateJson(update: PriceUpdate, feedIds: Hex[]): MirrorUpdateJson {
  const selected = selectFeeds(update, feedIds);
  return {
    committee: update.header.publisherSetTypeHash.toLowerCase() as Hex,
    publishTimeMs: update.header.publishTimeMs.toString(),
    blob: bytesToHex(encodePriceUpdate(selected)),
    prices: selected.entries.map(({ message: m }) => ({
      feedId: m.feedId,
      price: m.price.toString(),
      conf: m.conf.toString(),
      expo: m.expo,
      emaPrice: m.emaPrice.toString(),
      emaConf: m.emaConf.toString(),
      prevPublishTimeMs: m.prevPublishTimeMs.toString(),
      sourceTimeMs: m.sourceTimeMs.toString(),
      numPublishers: m.numPublishers,
    })),
  };
}

/** Client side: decode the blob and take every value from it. */
export function parseMirrorUpdate(json: MirrorUpdateJson): MirrorUpdate {
  const update = decodePriceUpdate(json.blob);
  const committee = update.header.publisherSetTypeHash.toLowerCase() as Hex;
  const publishTimeMs = update.header.publishTimeMs;
  return {
    committee,
    publishTimeMs,
    blob: json.blob,
    prices: update.entries.map(({ message }) => ({ ...message, committee, publishTimeMs })),
  };
}
