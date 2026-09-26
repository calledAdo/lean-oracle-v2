//! A committee as the mirror sees it: its publisher sets over time, and full verification of
//! finalized updates against them.
//!
//! The mirror keeps every set it has observed. The committee cell names the previous set and the
//! first tick of the current one (`previous.untilMs`), so an update from the previous set is accepted
//! only for ticks before that, the same rule the feed contract applies. A set the mirror saw retire
//! earlier keeps the bound it had. When the committee revokes the previous set, the mirror stops
//! accepting anything new from it (history already stored stays served).

import { readFileSync } from "node:fs";

import {
  GOVERNANCE_PAUSED,
  decodePriceUpdate,
  decodePublisherSetData,
  encodePriceMessage,
  leafHash,
  priceUpdateSigningHash,
  verifyProof,
  verifyThreshold,
  type Hex,
  type PriceUpdate,
  type PublisherSet,
  type PublisherSetData,
} from "lean-oracle-sdk/protocol";

import { fetchCommitteeData } from "./chain.js";
import type { CommitteeSourceConfig } from "./config.js";

interface KnownSet {
  set: PublisherSet;
  /** When the mirror first saw a newer set (undefined while current). */
  retiredAtMs?: number;
}

export class Committee {
  readonly name: string;
  readonly typeHash: Hex;
  private readonly sets = new Map<number, KnownSet>();
  private currentIndex: number | undefined;
  /** The committee cell's PAUSED flag: while set, nothing new is accepted (as on chain). */
  private paused = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly source: CommitteeSourceConfig,
    private readonly log: (event: string, detail?: Record<string, unknown>) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {
    this.name = source.name;
    this.typeHash = source.publisherSetTypeHash.toLowerCase() as Hex;
  }

  /** Load the committee data once, then keep it fresh from the chain. */
  async start(): Promise<void> {
    await this.refresh();
    if (this.source.chain) {
      this.timer = setInterval(() => void this.refresh().catch((error) => this.log("committee.refresh_failed", { committee: this.name, error: String(error) })), this.source.chain.refreshMs ?? 30_000);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    const data = this.source.chain
      ? await fetchCommitteeData(this.source.chain.rpcUrl, this.source.chain.typeScript)
      : decodePublisherSetData(readFileSync(this.source.publisherSetFile!, "utf8").trim() as Hex);
    this.observe(data);
  }

  /** Record the committee cell's current state: its current set and, if kept, the previous one. */
  observe(data: PublisherSetData): void {
    const index = data.current.setIndex;
    if (this.currentIndex !== undefined && index < this.currentIndex) return;
    const changed = index !== this.currentIndex;
    const paused = (data.governanceFlags & GOVERNANCE_PAUSED) !== 0;
    if (paused !== this.paused) this.log(paused ? "committee.paused" : "committee.unpaused", { committee: this.name });
    this.paused = paused;
    // Older sets this mirror knows are retired. The immediate predecessor is bounded by the on-chain
    // switch tick, or revoked (bound 0) when the cell no longer keeps it; sets retired earlier keep the
    // bound they already had (they were aged out by a later rotation, not revoked).
    for (const [i, known] of this.sets) {
      if (i === index) continue;
      let bound: number;
      if (i === index - 1) {
        const kept = data.previous?.set.setIndex === i;
        bound = kept ? Number(data.previous!.untilMs) : 0;
        if (!kept && known.retiredAtMs !== 0) this.log("committee.previous_revoked", { committee: this.name, setIndex: i });
      } else {
        bound = known.retiredAtMs ?? this.now();
      }
      if (known.retiredAtMs === undefined || bound < known.retiredAtMs) known.retiredAtMs = bound;
    }
    if (data.previous && !this.sets.has(data.previous.set.setIndex)) {
      // Learned from the chain (e.g. after a restart): history of the previous set stays verifiable.
      this.sets.set(data.previous.set.setIndex, { set: data.previous.set, retiredAtMs: Number(data.previous.untilMs) });
    }
    if (changed) {
      this.sets.set(index, { set: data.current });
      this.currentIndex = index;
      this.log("committee.set", { committee: this.name, setIndex: index, publishers: data.current.pubkeys.length, previous: data.previous?.set.setIndex ?? null });
    }
  }

  get ready(): boolean {
    return this.currentIndex !== undefined;
  }

  /**
   * Decode and fully verify a finalized update: committee, set, quorum signatures, and a valid
   * proof for every leaf (so any subset can be served). Throws with a reason.
   */
  verify(blob: Hex | Uint8Array): PriceUpdate {
    const update = decodePriceUpdate(blob);
    const { header } = update;
    if (header.publisherSetTypeHash.toLowerCase() !== this.typeHash) throw new Error("another committee");
    if (this.paused) throw new Error("committee is paused");
    const known = this.sets.get(header.setIndex);
    if (!known) throw new Error(`unknown set index ${header.setIndex}`);
    if (known.retiredAtMs !== undefined && Number(header.publishTimeMs) >= known.retiredAtMs) throw new Error("signed by a retired set after its retirement");
    if (update.entries.length !== header.leafCount) throw new Error("not a complete update");
    const ids = new Set(update.entries.map((e) => e.message.feedId.toLowerCase()));
    if (ids.size !== update.entries.length) throw new Error("duplicate feed");
    for (const entry of update.entries) {
      if (!verifyProof(header.merkleRoot, leafHash(encodePriceMessage(entry.message)), entry.proof)) throw new Error("bad proof");
    }
    if (!verifyThreshold(update.signatures, priceUpdateSigningHash(header), known.set)) throw new Error("no quorum");
    return update;
  }
}
