//! Ingestion: for every publisher of every committee, backfill over HTTP and follow the live
//! websocket stream. Every update is verified before it is stored; any publisher can be down, lag
//! or lie without affecting what the mirror serves.

import { hexToBytes, type Hex, type PriceUpdate } from "lean-oracle-sdk/protocol";
import WebSocket from "ws";

import type { Committee } from "./committee.js";
import type { InsertResult, MirrorStore } from "./store.js";

const PAGE = 500;
const RESYNC_MS = 60_000;
const MAX_RETRY_MS = 10_000;

export type Log = (event: string, detail?: Record<string, unknown>) => void;

/** Verifies and stores updates; tells listeners about each new one. */
export class Ingestor {
  private readonly listeners = new Set<(update: PriceUpdate, blob: Uint8Array) => void>();

  constructor(
    private readonly store: MirrorStore,
    private readonly log: Log,
    private readonly now: () => number = Date.now,
  ) {}

  onUpdate(listener: (update: PriceUpdate, blob: Uint8Array) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Verify and store one blob; returns the outcome and, when valid, its tick. */
  ingest(committee: Committee, blobHex: Hex, source: string): { result: InsertResult | "invalid"; tickMs?: bigint } {
    let update: PriceUpdate;
    const blob = hexToBytes(blobHex);
    try {
      update = committee.verify(blob);
    } catch (error) {
      this.log("ingest.invalid", { committee: committee.name, source, error: error instanceof Error ? error.message : String(error) });
      return { result: "invalid" };
    }
    const result = this.store.insert(update, blob, this.now());
    if (result === "equivocation") {
      this.log("ingest.equivocation", { committee: committee.name, source, tickMs: update.header.publishTimeMs.toString() });
    }
    if (result === "new") for (const listener of this.listeners) listener(update, blob);
    return { result, tickMs: update.header.publishTimeMs };
  }
}

/** One publisher API followed for one committee. */
export class PublisherSource {
  private socket: WebSocket | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private retryMs = 500;
  private syncing = false;
  connected = false;
  /** Newest tick received from this publisher. */
  private cursor: bigint;

  constructor(
    readonly committee: Committee,
    private readonly baseUrl: string,
    store: MirrorStore,
    private readonly ingestor: Ingestor,
    private readonly log: Log,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.cursor = store.latestTick(committee.typeHash) ?? 0n;
  }

  start(): void {
    void this.backfill();
    this.connect();
    this.timer = setInterval(() => void this.backfill(), RESYNC_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.socket?.terminate();
  }

  /** Page through everything newer than the cursor. */
  async backfill(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      for (;;) {
        const response = await this.fetchFn(`${this.baseUrl}/v1/finalized?after=${this.cursor}`, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { blobs } = (await response.json()) as { blobs: Hex[] };
        for (const blob of blobs) this.accept(blob);
        if (blobs.length < PAGE) break;
      }
    } catch (error) {
      this.log("source.backfill_failed", { committee: this.committee.name, source: this.baseUrl, error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.syncing = false;
    }
  }

  private accept(blob: Hex): void {
    const { tickMs } = this.ingestor.ingest(this.committee, blob, this.baseUrl);
    if (tickMs !== undefined && tickMs > this.cursor) this.cursor = tickMs;
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = new WebSocket(`${this.baseUrl.replace(/^http/, "ws")}/v1/stream`, { handshakeTimeout: 5000, maxPayload: 1024 * 1024 });
    this.socket = socket;
    socket.on("open", () => {
      this.connected = true;
      this.retryMs = 500;
      this.log("source.connected", { committee: this.committee.name, source: this.baseUrl });
      void this.backfill(); // anything finalized while we were away
    });
    socket.on("message", (data: Buffer) => {
      try {
        const { blob } = JSON.parse(data.toString()) as { blob: Hex };
        this.accept(blob);
      } catch {
        this.log("source.bad_frame", { source: this.baseUrl });
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      this.connected = false;
      if (this.stopped) return;
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    });
  }
}
