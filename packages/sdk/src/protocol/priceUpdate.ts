//! Signed price updates: header, per-feed messages and blobs. Mirrors contracts/common/src/price_update.rs.

import { DecodeError } from "../errors.js";
import { bytesToHex, compareBytes, hexToBytes, hexToFixed, type BytesLike, toBytes } from "../internal/bytes.js";
import { Reader, Writer } from "../internal/codec.js";
import type { Hex } from "../types.js";
import { HEADER_LEN, MAX_PROOF_LEN, MESSAGE_LEN, MESSAGE_TYPE_PRICE, PRICE_UPDATE_MAGIC, PRICE_UPDATE_VERSION } from "./constants.js";
import { ckbHash, DOMAIN_PRICE_UPDATE } from "./hash.js";
import { leafHash, merkleProof, merkleRoot } from "./merkle.js";
import { decodeSignatureBundlePrefix, encodeSignatureBundle, type SignatureBundle } from "./signatures.js";

export interface PriceUpdateHeader {
  publisherSetTypeHash: Hex;
  setIndex: number;
  /** The tick: committee-signed time of every price in this update. */
  publishTimeMs: bigint;
  tickPeriodMs: number;
  configHash: Hex;
  leafCount: number;
  merkleRoot: Hex;
}

/** One feed's price at the header's tick. */
export interface PriceMessage {
  feedId: Hex;
  price: bigint;
  conf: bigint;
  expo: number;
  prevPublishTimeMs: bigint;
  emaPrice: bigint;
  emaConf: bigint;
  sourceTimeMs: bigint;
  numPublishers: number;
}

export interface UpdateEntry {
  message: PriceMessage;
  proof: Hex[];
}

export interface PriceUpdate {
  header: PriceUpdateHeader;
  signatures: SignatureBundle;
  entries: UpdateEntry[];
}

const MAGIC = new TextEncoder().encode(PRICE_UPDATE_MAGIC);

export function encodePriceUpdateHeader(header: PriceUpdateHeader): Uint8Array {
  return new Writer()
    .bytes(MAGIC)
    .u8(PRICE_UPDATE_VERSION)
    .bytes(hexToFixed(header.publisherSetTypeHash, 32, "publisherSetTypeHash"))
    .u32(header.setIndex)
    .u64(header.publishTimeMs)
    .u32(header.tickPeriodMs)
    .bytes(hexToFixed(header.configHash, 32, "configHash"))
    .u16(header.leafCount)
    .bytes(hexToFixed(header.merkleRoot, 32, "merkleRoot"))
    .finish();
}

export function decodePriceUpdateHeader(bytes: BytesLike): PriceUpdateHeader {
  const reader = new Reader(toBytes(bytes), "PriceUpdateHeader");
  if (reader.remaining() !== HEADER_LEN) throw new DecodeError(`PriceUpdateHeader: expected ${HEADER_LEN} bytes`);
  if (new TextDecoder().decode(reader.bytes(4)) !== PRICE_UPDATE_MAGIC || reader.u8() !== PRICE_UPDATE_VERSION) {
    throw new DecodeError("PriceUpdateHeader: bad magic or version");
  }
  const header = {
    publisherSetTypeHash: bytesToHex(reader.bytes(32)),
    setIndex: reader.u32(),
    publishTimeMs: reader.u64(),
    tickPeriodMs: reader.u32(),
    configHash: bytesToHex(reader.bytes(32)),
    leafCount: reader.u16(),
    merkleRoot: bytesToHex(reader.bytes(32)),
  };
  if (header.leafCount === 0) throw new DecodeError("PriceUpdateHeader: leaf_count must be positive");
  return header;
}

/** The digest the committee quorum signs. */
export function priceUpdateSigningHash(header: PriceUpdateHeader): Hex {
  return bytesToHex(ckbHash(DOMAIN_PRICE_UPDATE, encodePriceUpdateHeader(header)));
}

export function encodePriceMessage(message: PriceMessage): Uint8Array {
  return new Writer()
    .u8(MESSAGE_TYPE_PRICE)
    .bytes(hexToFixed(message.feedId, 32, "feedId"))
    .i64(message.price)
    .u64(message.conf)
    .i32(message.expo)
    .u64(message.prevPublishTimeMs)
    .i64(message.emaPrice)
    .u64(message.emaConf)
    .u64(message.sourceTimeMs)
    .u8(message.numPublishers)
    .finish();
}

export function decodePriceMessage(bytes: BytesLike): PriceMessage {
  const reader = new Reader(toBytes(bytes), "PriceMessage");
  if (reader.remaining() !== MESSAGE_LEN || reader.u8() !== MESSAGE_TYPE_PRICE) {
    throw new DecodeError("PriceMessage: bad length or message type");
  }
  return {
    feedId: bytesToHex(reader.bytes(32)),
    price: reader.i64(),
    conf: reader.u64(),
    expo: reader.i32(),
    prevPublishTimeMs: reader.u64(),
    emaPrice: reader.i64(),
    emaConf: reader.u64(),
    sourceTimeMs: reader.u64(),
    numPublishers: reader.u8(),
  };
}

/** `header | SignatureBundle | entry_count u8 | entries { message | proof_len u8 | proof }`. */
export function encodePriceUpdate(update: PriceUpdate): Uint8Array {
  if (update.entries.length === 0 || update.entries.length > 255) throw new RangeError("PriceUpdate: 1..=255 entries");
  const writer = new Writer()
    .bytes(encodePriceUpdateHeader(update.header))
    .bytes(encodeSignatureBundle(update.signatures))
    .u8(update.entries.length);
  for (const entry of update.entries) {
    if (entry.proof.length > MAX_PROOF_LEN) throw new RangeError("PriceUpdate: proof too long");
    writer.bytes(encodePriceMessage(entry.message)).u8(entry.proof.length);
    for (const node of entry.proof) writer.bytes(hexToFixed(node, 32, "proof node"));
  }
  return writer.finish();
}

export function decodePriceUpdate(bytes: BytesLike): PriceUpdate {
  const data = toBytes(bytes);
  if (data.length < HEADER_LEN) throw new DecodeError("PriceUpdate: truncated header");
  const header = decodePriceUpdateHeader(data.slice(0, HEADER_LEN));
  const { bundle: signatures, used } = decodeSignatureBundlePrefix(data.slice(HEADER_LEN));
  const reader = new Reader(data.slice(HEADER_LEN + used), "PriceUpdate");
  const count = reader.u8();
  if (count === 0) throw new DecodeError("PriceUpdate: no entries");
  const entries = Array.from({ length: count }, () => {
    const message = decodePriceMessage(reader.bytes(MESSAGE_LEN));
    const proofLen = reader.u8();
    if (proofLen > MAX_PROOF_LEN) throw new DecodeError("PriceUpdate: proof too long");
    const proof = Array.from({ length: proofLen }, () => bytesToHex(reader.bytes(32)));
    return { message, proof };
  });
  reader.end();
  return { header, signatures, entries };
}

export interface UnsignedUpdateInput {
  publisherSetTypeHash: Hex;
  setIndex: number;
  publishTimeMs: bigint;
  tickPeriodMs: number;
  configHash: Hex;
  messages: PriceMessage[];
}

/** Build the header and every entry's proof for a tick's messages (sorted by feed id). Signatures are added separately. */
export function assemblePriceUpdate(input: UnsignedUpdateInput): { header: PriceUpdateHeader; entries: UpdateEntry[] } {
  const messages = [...input.messages].sort((a, b) => compareBytes(hexToBytes(a.feedId), hexToBytes(b.feedId)));
  messages.forEach((m, i) => {
    if (i > 0 && m.feedId.toLowerCase() === messages[i - 1]!.feedId.toLowerCase()) throw new RangeError(`duplicate feed ${m.feedId}`);
  });
  const leaves = messages.map((m) => leafHash(encodePriceMessage(m)));
  const header: PriceUpdateHeader = {
    publisherSetTypeHash: input.publisherSetTypeHash,
    setIndex: input.setIndex,
    publishTimeMs: input.publishTimeMs,
    tickPeriodMs: input.tickPeriodMs,
    configHash: input.configHash,
    leafCount: messages.length,
    merkleRoot: merkleRoot(leaves),
  };
  return { header, entries: messages.map((message, i) => ({ message, proof: merkleProof(leaves, i) })) };
}

/** A copy of `update` carrying only the given feeds (each keeps its own proof). */
export function selectFeeds(update: PriceUpdate, feedIds: Hex[]): PriceUpdate {
  const wanted = new Set(feedIds.map((id) => id.toLowerCase()));
  const entries = update.entries.filter((e) => wanted.has(e.message.feedId.toLowerCase()));
  if (entries.length === 0) throw new RangeError("selectFeeds: none of the requested feeds are in this update");
  return { ...update, entries };
}
