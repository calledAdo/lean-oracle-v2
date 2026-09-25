//! WebSocket transport. Each publisher listens on one port and dials every peer; frames to a peer
//! go over our outbound connection to it. Inbound connections must authenticate first: the server
//! sends a challenge, the client answers with its index and a signature (wire.ts `answerHello`).
//! Frames to an unreachable peer are dropped: ticks are ephemeral and history is recovered by sync.

import { randomBytes } from "node:crypto";

import type { Hex, PublisherSet } from "lean-oracle-sdk/protocol";
import WebSocket, { WebSocketServer } from "ws";

import type { KeySigner } from "./keySigner.js";
import type { Transport } from "./transport.js";
import { answerHello, checkHello } from "./wire.js";

export interface WsTransportOptions {
  selfIndex: number;
  signer: KeySigner;
  set: PublisherSet;
  host: string;
  port: number;
  /** Publisher index → peer URL (e.g. `ws://publisher-2:7700`). */
  peers: Map<number, string>;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

const MAX_PAYLOAD = 4 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 5000;

export class WsTransport implements Transport {
  private readonly server: WebSocketServer;
  private readonly outbound = new Map<number, { socket: WebSocket; ready: boolean }>();
  private handler: (from: number, frame: Uint8Array) => void = () => {};
  private closed = false;

  constructor(private readonly o: WsTransportOptions) {
    this.server = new WebSocketServer({ host: o.host, port: o.port, maxPayload: MAX_PAYLOAD });
    this.server.on("connection", (socket) => this.accept(socket));
    for (const [index, url] of o.peers) if (index !== o.selfIndex) this.dial(index, url, 500);
  }

  send(to: number, frame: Uint8Array): void {
    if (to === this.o.selfIndex) {
      const copy = frame.slice();
      setImmediate(() => this.handler(this.o.selfIndex, copy));
      return;
    }
    const peer = this.outbound.get(to);
    if (peer?.ready && peer.socket.readyState === WebSocket.OPEN) peer.socket.send(frame);
  }

  broadcast(frame: Uint8Array): void {
    for (const index of this.outbound.keys()) this.send(index, frame);
  }

  onFrame(handler: (from: number, frame: Uint8Array) => void): void {
    this.handler = handler;
  }

  connectedPeers(): number[] {
    return [...this.outbound].filter(([, p]) => p.ready && p.socket.readyState === WebSocket.OPEN).map(([i]) => i);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const { socket } of this.outbound.values()) socket.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Inbound: challenge, verify the answer, then deliver frames tagged with the proven index. */
  private accept(socket: WebSocket): void {
    const challenge = randomBytes(32);
    let from: number | undefined;
    const timer = setTimeout(() => from === undefined && socket.terminate(), HELLO_TIMEOUT_MS);
    socket.send(challenge);
    socket.on("message", (data: Buffer) => {
      const bytes = new Uint8Array(data);
      if (from === undefined) {
        from = checkHello(bytes, challenge, this.o.signer.publicKey, this.o.set);
        clearTimeout(timer);
        if (from === undefined) {
          this.o.log?.("transport.bad_hello");
          socket.terminate();
        }
        return;
      }
      this.handler(from, bytes);
    });
    socket.on("error", () => {});
  }

  /** Outbound: answer the peer's challenge, then this connection carries our frames to it. */
  private dial(index: number, url: string, delayMs: number): void {
    if (this.closed) return;
    const socket = new WebSocket(url, { maxPayload: MAX_PAYLOAD, handshakeTimeout: 5000 });
    const peer = { socket, ready: false };
    this.outbound.set(index, peer);
    const serverKey = this.o.set.pubkeys[index] as Hex;
    socket.once("message", async (data: Buffer) => {
      socket.send(await answerHello(new Uint8Array(data), serverKey, this.o.selfIndex, this.o.signer));
      peer.ready = true;
      this.o.log?.("transport.connected", { peer: index });
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      peer.ready = false;
      if (this.closed) return;
      setTimeout(() => this.dial(index, url, Math.min(delayMs * 2, 10_000)), delayMs);
    });
  }
}
