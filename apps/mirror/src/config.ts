//! Mirror config (a JSON file).

import { readFileSync } from "node:fs";

import type { Hex } from "lean-oracle-sdk/protocol";

import type { ScriptJson } from "./chain.js";
import type { RateLimitConfig } from "./rateLimit.js";

export interface CommitteeSourceConfig {
  /** Label used in logs and `/health`. */
  name: string;
  publisherSetTypeHash: Hex;
  /** Read the committee cell from CKB (preferred); refreshed every `refreshMs` (default 30 s). */
  chain?: { rpcUrl: string; typeScript: ScriptJson; refreshMs?: number };
  /** Or committee cell data as 0x-hex in a file (development without a chain). */
  publisherSetFile?: string;
  /** Publisher API base URLs (`http://host:port`). More than one gives redundancy. */
  publishers: string[];
}

export interface MirrorConfig {
  http: {
    host: string;
    port: number;
    /** Take the client address from `X-Forwarded-For` (only behind a trusted proxy). */
    trustProxy?: boolean;
  };
  /** SQLite database path. */
  dataPath: string;
  committees: CommitteeSourceConfig[];
  rateLimit?: RateLimitConfig;
  /**
   * How long updates are kept, in days (default 7; 0 keeps everything). Older ticks are pruned, so
   * `/v1/updates/at` and `/range` answer only inside the window. Equivocation evidence is kept.
   */
  retentionDays?: number;
}

export function loadMirrorConfig(path: string): MirrorConfig {
  const config = JSON.parse(readFileSync(path, "utf8")) as MirrorConfig;
  if (!config.http || !config.dataPath || !Array.isArray(config.committees) || config.committees.length === 0) {
    throw new Error("mirror config needs http, dataPath and at least one committee");
  }
  if (config.retentionDays !== undefined && !(Number.isFinite(config.retentionDays) && config.retentionDays >= 0)) {
    throw new Error("retentionDays must be a number of days, 0 or more (0 keeps everything)");
  }
  for (const c of config.committees) {
    if (!c.chain && !c.publisherSetFile) throw new Error(`committee ${c.name}: needs chain or publisherSetFile`);
    if (!c.publishers?.length) throw new Error(`committee ${c.name}: needs at least one publisher URL`);
  }
  return config;
}
