//! Binary peer protocol (docs/oracle-design.md section 5). Frames are `type u8 | payload`. The
//! sender is known from the authenticated connection (see `hello` below), so frames carry no
//! per-message signature; observations and header signatures are signed in their own domains.

import { bytesToHex, ckbHash, decodeSignedObservation, DOMAIN_PEER_HELLO, encodeSignedObservation, hexToBytes, recoverSigner, type Hex, type PublisherSet, type SignedObservation } from "lean-oracle-sdk/protocol";

import type { KeySigner } from "./keySigner.js";

export interface ProposalBody {
  tickMs: bigint;
  /** Latest finalized update at or before tick − 2 periods; seeds the leader order. */
  anchorTickMs: bigint;
  anchorHash: Hex;
  /** The proposer's latest finalized tick before this tick (EMA / prev_publish_time base). */
  prevTickMs: bigint;
  /** Chosen observations: publisher index and observation signing hash, ascending by index. */
  chosen: { index: number; hash: Hex }[];
}

export type PeerMessage =
  | { type: "observation"; signed: SignedObservation }
  /** Signed by `proposer` (so peers can relay it); `rank` is the proposer's rank for the tick. */
  | { type: "proposal"; rank: number; proposer: number; body: ProposalBody; signature: Hex }
  /** Ask for a tick's observations and best proposal (a backup preparing its slot). */
  | { type: "tick_request"; tickMs: bigint }
  | { type: "signature"; tickMs: bigint; headerHash: Hex; signature: Hex }
  | { type: "obs_request"; tickMs: bigint; indexes: number[] }
  | { type: "sync_request"; afterTickMs: bigint }
  | { type: "sync_response"; blobs: Uint8Array[] };

const T = { observation: 1, proposal: 2, signature: 3, obs_request: 4, sync_request: 5, sync_response: 6, tick_request: 7 } as const;

const DOMAIN_PROPOSAL = new TextEncoder().encode("LEAN/PROPOSAL/V1");

function encodeBody(out: Out, rank: number, proposer: number, b: ProposalBody): Out {
  out.u8(rank).u8(proposer).u64(b.tickMs).u64(b.anchorTickMs).bytes(hexToBytes(b.anchorHash)).u64(b.prevTickMs).u8(b.chosen.length);
  for (const c of b.chosen) out.u8(c.index).bytes(hexToBytes(c.hash));
  return out;
}

/** Digest a proposer signs: `ckbHash("LEAN/PROPOSAL/V1" || rank || proposer || body)`. */
export function proposalDigest(rank: number, proposer: number, body: ProposalBody): Hex {
  return bytesToHex(ckbHash(DOMAIN_PROPOSAL, encodeBody(new Out(), rank, proposer, body).finish()));
}

class Out {
  private readonly parts: Uint8Array[] = [];
  u8(v: number) { this.parts.push(Uint8Array.of(v)); return this; }
  u16(v: number) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this.parts.push(b); return this; }
  u32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); this.parts.push(b); return this; }
  u64(v: bigint) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); this.parts.push(b); return this; }
  bytes(v: Uint8Array) { this.parts.push(v); return this; }
  finish(): Uint8Array {
    const out = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

class In {
  private o = 0;
  constructor(private readonly d: Uint8Array) {}
  private take(n: number) { if (this.o + n > this.d.length) throw new Error("truncated frame"); const v = this.d.subarray(this.o, this.o + n); this.o += n; return v; }
  u8() { return this.take(1)[0]!; }
  u16() { return new DataView(this.take(2).slice().buffer).getUint16(0, true); }
  u32() { return new DataView(this.take(4).slice().buffer).getUint32(0, true); }
  u64() { return new DataView(this.take(8).slice().buffer).getBigUint64(0, true); }
  bytes(n: number) { return this.take(n).slice(); }
  rest() { return this.take(this.d.length - this.o).slice(); }
  end() { if (this.o !== this.d.length) throw new Error("trailing bytes in frame"); }
}

export function encodeMessage(m: PeerMessage): Uint8Array {
  const out = new Out().u8(T[m.type]);
  switch (m.type) {
    case "observation":
      return out.bytes(encodeSignedObservation(m.signed)).finish();
    case "proposal":
      return encodeBody(out, m.rank, m.proposer, m.body).bytes(hexToBytes(m.signature)).finish();
    case "tick_request":
      return out.u64(m.tickMs).finish();
    case "signature":
      return out.u64(m.tickMs).bytes(hexToBytes(m.headerHash)).bytes(hexToBytes(m.signature)).finish();
    case "obs_request":
      out.u64(m.tickMs).u8(m.indexes.length);
      for (const i of m.indexes) out.u8(i);
      return out.finish();
    case "sync_request":
      return out.u64(m.afterTickMs).finish();
    case "sync_response":
      out.u16(m.blobs.length);
      for (const blob of m.blobs) out.u32(blob.length).bytes(blob);
      return out.finish();
  }
}

export function decodeMessage(data: Uint8Array): PeerMessage {
  const r = new In(data);
  const type = r.u8();
  let m: PeerMessage;
  switch (type) {
    case T.observation:
      return { type: "observation", signed: decodeSignedObservation(r.rest()) };
    case T.proposal: {
      const rank = r.u8();
      const proposer = r.u8();
      const tickMs = r.u64();
      const anchorTickMs = r.u64();
      const anchorHash = bytesToHex(r.bytes(32));
      const prevTickMs = r.u64();
      const chosen = Array.from({ length: r.u8() }, () => ({ index: r.u8(), hash: bytesToHex(r.bytes(32)) }));
      m = { type: "proposal", rank, proposer, body: { tickMs, anchorTickMs, anchorHash, prevTickMs, chosen }, signature: bytesToHex(r.bytes(65)) };
      break;
    }
    case T.tick_request:
      m = { type: "tick_request", tickMs: r.u64() };
      break;
    case T.signature:
      m = { type: "signature", tickMs: r.u64(), headerHash: bytesToHex(r.bytes(32)), signature: bytesToHex(r.bytes(65)) };
      break;
    case T.obs_request: {
      const tickMs = r.u64();
      m = { type: "obs_request", tickMs, indexes: Array.from({ length: r.u8() }, () => r.u8()) };
      break;
    }
    case T.sync_request:
      m = { type: "sync_request", afterTickMs: r.u64() };
      break;
    case T.sync_response:
      m = { type: "sync_response", blobs: Array.from({ length: r.u16() }, () => r.bytes(r.u32())) };
      break;
    default:
      throw new Error(`unknown frame type ${type}`);
  }
  r.end();
  return m;
}

/**
 * Connection authentication: the server sends a 32-byte challenge; the client answers with its
 * publisher index and a signature over `ckbHash("LEAN/PEER_HELLO/V1" || challenge || server pubkey || index)`.
 * Binding the server's key stops a hello from being replayed to another publisher.
 */
export function helloDigest(challenge: Uint8Array, serverPubkey: Hex, clientIndex: number): Hex {
  return bytesToHex(ckbHash(DOMAIN_PEER_HELLO, challenge, hexToBytes(serverPubkey), Uint8Array.of(clientIndex)));
}

export async function answerHello(challenge: Uint8Array, serverPubkey: Hex, selfIndex: number, signer: KeySigner): Promise<Uint8Array> {
  const signature = hexToBytes(await signer.sign(helloDigest(challenge, serverPubkey, selfIndex)));
  const out = new Uint8Array(66);
  out[0] = selfIndex;
  out.set(signature, 1);
  return out;
}

/** The authenticated client index, or undefined. */
export function checkHello(answer: Uint8Array, challenge: Uint8Array, serverPubkey: Hex, set: PublisherSet): number | undefined {
  if (answer.length !== 66) return undefined;
  const index = answer[0]!;
  const key = set.pubkeys[index];
  if (!key) return undefined;
  const recovered = recoverSigner(helloDigest(challenge, serverPubkey, index), bytesToHex(answer.subarray(1)));
  return recovered === key.toLowerCase() ? index : undefined;
}
