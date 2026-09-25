//! Durable publisher state (node:sqlite): the double-sign guard, finalized updates and per-feed
//! state (latest finalized tick and EMA) that aggregation depends on.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { bytesToHex, hexToBytes, type Hex, type PriceUpdate } from "lean-oracle-sdk/protocol";

import type { FeedState } from "./aggregate.js";

export class PublisherStore {
  private readonly db: DatabaseSync;
  private readonly finalizedListeners = new Set<(tickMs: bigint, blob: Uint8Array) => void>();

  constructor(path: string, private readonly committee: Hex) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS signed_ticks (committee TEXT, tick_ms TEXT, header_hash TEXT, PRIMARY KEY (committee, tick_ms));
      CREATE TABLE IF NOT EXISTS finalized (committee TEXT, tick_ms INTEGER, blob BLOB NOT NULL, PRIMARY KEY (committee, tick_ms));
      CREATE TABLE IF NOT EXISTS feed_state (committee TEXT, feed_id TEXT, tick_ms TEXT, ema_price TEXT, ema_conf TEXT, PRIMARY KEY (committee, feed_id));
    `);
  }

  /**
   * Double-sign guard, persisted before a signature is released. True if this publisher has not
   * signed a different header for `tickMs` (re-signing the same header is allowed).
   */
  reserveSignature(tickMs: bigint, headerHash: Hex): boolean {
    this.db
      .prepare("INSERT OR IGNORE INTO signed_ticks (committee, tick_ms, header_hash) VALUES (?, ?, ?)")
      .run(this.committee, tickMs.toString(), headerHash);
    const row = this.db
      .prepare("SELECT header_hash FROM signed_ticks WHERE committee = ? AND tick_ms = ?")
      .get(this.committee, tickMs.toString()) as { header_hash: string } | undefined;
    return row?.header_hash === headerHash;
  }

  hasFinalized(tickMs: bigint): boolean {
    return this.db.prepare("SELECT 1 FROM finalized WHERE committee = ? AND tick_ms = ?").get(this.committee, tickMs) !== undefined;
  }

  /** Store a verified finalized update and advance per-feed state. Returns false if already stored. */
  saveFinalized(update: PriceUpdate, blob: Uint8Array): boolean {
    const tick = update.header.publishTimeMs;
    if (this.hasFinalized(tick)) return false;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO finalized (committee, tick_ms, blob) VALUES (?, ?, ?)").run(this.committee, tick, blob);
      for (const { message } of update.entries) {
        const current = this.feedState(message.feedId);
        if (current && current.tickMs >= tick) continue;
        this.db
          .prepare("INSERT OR REPLACE INTO feed_state (committee, feed_id, tick_ms, ema_price, ema_conf) VALUES (?, ?, ?, ?, ?)")
          .run(this.committee, message.feedId, tick.toString(), message.emaPrice.toString(), message.emaConf.toString());
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    for (const listener of this.finalizedListeners) listener(tick, blob);
    return true;
  }

  /** Called after each newly stored finalized update. Returns an unsubscribe function. */
  onFinalized(listener: (tickMs: bigint, blob: Uint8Array) => void): () => void {
    this.finalizedListeners.add(listener);
    return () => this.finalizedListeners.delete(listener);
  }

  feedState(feedId: Hex): FeedState | undefined {
    const row = this.db
      .prepare("SELECT tick_ms, ema_price, ema_conf FROM feed_state WHERE committee = ? AND feed_id = ?")
      .get(this.committee, feedId) as { tick_ms: string; ema_price: string; ema_conf: string } | undefined;
    return row && { tickMs: BigInt(row.tick_ms), emaPrice: BigInt(row.ema_price), emaConf: BigInt(row.ema_conf) };
  }

  latestFinalizedTick(): bigint | undefined {
    const row = this.db.prepare("SELECT MAX(tick_ms) AS tick FROM finalized WHERE committee = ?").get(this.committee) as { tick: number | bigint | null };
    return row.tick === null ? undefined : BigInt(row.tick);
  }

  /** Latest finalized update with tick ≤ `tickMs`. */
  finalizedAtOrBefore(tickMs: bigint): { tickMs: bigint; blob: Uint8Array } | undefined {
    const row = this.db
      .prepare("SELECT tick_ms, blob FROM finalized WHERE committee = ? AND tick_ms <= ? ORDER BY tick_ms DESC LIMIT 1")
      .get(this.committee, tickMs) as { tick_ms: number | bigint; blob: Uint8Array } | undefined;
    return row && { tickMs: BigInt(row.tick_ms), blob: row.blob };
  }

  finalizedAt(tickMs: bigint): Hex | undefined {
    const row = this.db.prepare("SELECT blob FROM finalized WHERE committee = ? AND tick_ms = ?").get(this.committee, tickMs) as { blob: Uint8Array } | undefined;
    return row && bytesToHex(row.blob);
  }

  /** Finalized blobs with tick > `afterMs`, oldest first. */
  finalizedAfter(afterMs: bigint, limit: number): Hex[] {
    return (this.db
      .prepare("SELECT blob FROM finalized WHERE committee = ? AND tick_ms > ? ORDER BY tick_ms LIMIT ?")
      .all(this.committee, afterMs, limit) as { blob: Uint8Array }[]).map((row) => bytesToHex(row.blob));
  }

  close(): void {
    this.db.close();
  }
}

export { hexToBytes };
