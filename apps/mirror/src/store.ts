//! Mirror storage (node:sqlite): every verified finalized update, a per-feed index, and evidence of
//! equivocation.
//!
//! An update is identified by its header hash. Publishers may hold the same update with different
//! quorum subsets of signatures, so the first valid copy is kept and later copies with the same
//! header are duplicates. A second valid header for the same (committee, tick) is equivocation: the
//! first stays canonical and both are kept as public evidence.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { bytesToHex, priceUpdateSigningHash, type Hex, type PriceUpdate } from "lean-oracle-sdk/protocol";

export type InsertResult = "new" | "duplicate" | "equivocation";

export interface StoredUpdate {
  committee: Hex;
  tickMs: bigint;
  blob: Uint8Array;
}

export interface Equivocation {
  committee: Hex;
  tickMs: bigint;
  headerHash: Hex;
  blob: Hex;
  receivedMs: number;
}

type Row = { committee: string; tick_ms: number | bigint; blob: Uint8Array };
const toStored = (row: Row | undefined): StoredUpdate | undefined =>
  row && { committee: row.committee as Hex, tickMs: BigInt(row.tick_ms), blob: row.blob };

export class MirrorStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS updates (committee TEXT, tick_ms INTEGER, header_hash TEXT NOT NULL, blob BLOB NOT NULL, received_ms INTEGER NOT NULL, PRIMARY KEY (committee, tick_ms));
      CREATE TABLE IF NOT EXISTS feed_ticks (feed_id TEXT, committee TEXT, tick_ms INTEGER, PRIMARY KEY (feed_id, committee, tick_ms));
      CREATE INDEX IF NOT EXISTS feed_ticks_by_time ON feed_ticks (feed_id, tick_ms);
      CREATE TABLE IF NOT EXISTS equivocations (committee TEXT, tick_ms INTEGER, header_hash TEXT, blob BLOB NOT NULL, received_ms INTEGER NOT NULL, PRIMARY KEY (committee, tick_ms, header_hash));
    `);
  }

  /** Store a verified update. */
  insert(update: PriceUpdate, blob: Uint8Array, receivedMs: number): InsertResult {
    const committee = update.header.publisherSetTypeHash.toLowerCase();
    const tick = update.header.publishTimeMs;
    const headerHash = priceUpdateSigningHash(update.header);
    const existing = this.db.prepare("SELECT header_hash, blob, received_ms FROM updates WHERE committee = ? AND tick_ms = ?").get(committee, tick) as
      | { header_hash: string; blob: Uint8Array; received_ms: number }
      | undefined;
    if (existing?.header_hash === headerHash) return "duplicate";
    if (existing) {
      const evidence = this.db.prepare("INSERT OR IGNORE INTO equivocations (committee, tick_ms, header_hash, blob, received_ms) VALUES (?, ?, ?, ?, ?)");
      evidence.run(committee, tick, existing.header_hash, existing.blob, existing.received_ms);
      const added = evidence.run(committee, tick, headerHash, blob, receivedMs);
      return added.changes > 0 ? "equivocation" : "duplicate";
    }
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO updates (committee, tick_ms, header_hash, blob, received_ms) VALUES (?, ?, ?, ?, ?)").run(committee, tick, headerHash, blob, receivedMs);
      const index = this.db.prepare("INSERT OR IGNORE INTO feed_ticks (feed_id, committee, tick_ms) VALUES (?, ?, ?)");
      for (const { message } of update.entries) index.run(message.feedId.toLowerCase(), committee, tick);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return "new";
  }

  latestTick(committee: Hex): bigint | undefined {
    const row = this.db.prepare("SELECT MAX(tick_ms) AS tick FROM updates WHERE committee = ?").get(committee.toLowerCase()) as { tick: number | bigint | null };
    return row.tick === null ? undefined : BigInt(row.tick);
  }

  /** The newest update containing `feedId` (optionally from one committee). */
  latest(feedId: Hex, committee?: Hex): StoredUpdate | undefined {
    return this.feedQuery(feedId, committee, "", "ORDER BY f.tick_ms DESC", []);
  }

  /** The first update at or after `tickMs` containing `feedId`. */
  atOrAfter(feedId: Hex, tickMs: bigint, committee?: Hex): StoredUpdate | undefined {
    return this.feedQuery(feedId, committee, "AND f.tick_ms >= ?", "ORDER BY f.tick_ms ASC", [tickMs]);
  }

  /** Updates containing `feedId` with `from ≤ tick ≤ to`, oldest first. */
  range(feedId: Hex, from: bigint, to: bigint, limit: number, committee?: Hex): StoredUpdate[] {
    const [where, args] = committee ? ["AND f.committee = ?", [committee.toLowerCase()]] : ["", []];
    return (this.db
      .prepare(`SELECT u.committee, u.tick_ms, u.blob FROM feed_ticks f JOIN updates u ON u.committee = f.committee AND u.tick_ms = f.tick_ms
                WHERE f.feed_id = ? ${where} AND f.tick_ms >= ? AND f.tick_ms <= ? ORDER BY f.tick_ms ASC LIMIT ?`)
      .all(feedId.toLowerCase(), ...args, from, to, limit) as Row[]).map((row) => toStored(row)!);
  }

  /** Feeds seen, with the committee and latest tick of each. */
  feeds(): { feedId: Hex; committee: Hex; latestTickMs: bigint }[] {
    return (this.db.prepare("SELECT feed_id, committee, MAX(tick_ms) AS tick FROM feed_ticks GROUP BY feed_id, committee ORDER BY feed_id").all() as {
      feed_id: string;
      committee: string;
      tick: number | bigint;
    }[]).map((row) => ({ feedId: row.feed_id as Hex, committee: row.committee as Hex, latestTickMs: BigInt(row.tick) }));
  }

  equivocations(limit: number): Equivocation[] {
    return (this.db.prepare("SELECT committee, tick_ms, header_hash, blob, received_ms FROM equivocations ORDER BY tick_ms DESC, received_ms ASC LIMIT ?").all(limit) as {
      committee: string;
      tick_ms: number | bigint;
      header_hash: string;
      blob: Uint8Array;
      received_ms: number;
    }[]).map((row) => ({ committee: row.committee as Hex, tickMs: BigInt(row.tick_ms), headerHash: row.header_hash as Hex, blob: bytesToHex(row.blob), receivedMs: row.received_ms }));
  }

  close(): void {
    this.db.close();
  }

  private feedQuery(feedId: Hex, committee: Hex | undefined, extra: string, order: string, extraArgs: bigint[]): StoredUpdate | undefined {
    const [where, args] = committee ? ["AND f.committee = ?", [committee.toLowerCase()]] : ["", []];
    return toStored(this.db
      .prepare(`SELECT u.committee, u.tick_ms, u.blob FROM feed_ticks f JOIN updates u ON u.committee = f.committee AND u.tick_ms = f.tick_ms
                WHERE f.feed_id = ? ${where} ${extra} ${order} LIMIT 1`)
      .get(feedId.toLowerCase(), ...args, ...extraArgs) as Row | undefined);
  }
}
