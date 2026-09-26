//! One publisher's per-tick protocol (docs/oracle-design.md section 5).
//!
//! 1. Observe at `t` and send the signed observation to every publisher.
//! 2. The leader order for `t` comes from the anchor (latest finalized update at or before
//!    `t − 2 periods`). Rank 0 proposes as soon as it holds every observation, or a quorum after a
//!    short grace. Rank r ≥ 1 may propose from `t + r × deadline`: it first asks its peers for the
//!    tick's observations and best proposal, then re-proposes the best proposal seen or, failing
//!    that, its own. Proposals name the chosen observations by hash and are signed by their
//!    proposer, so any peer can relay them.
//! 3. Each publisher derives the messages, EMA and header itself from those observations and its
//!    finalized history, checks tolerance and the double-sign guard, then sends its header
//!    signature to every publisher.
//! 4. Every publisher finalizes locally once a quorum signed the header it derived.
//!
//! Finalization is monotonic: once a later tick is finalized, earlier unfinalized ticks are dropped.

import {
  assemblePriceUpdate,
  decodePriceUpdate,
  decodePriceUpdateHeader,
  encodePriceUpdate,
  GOVERNANCE_PAUSED,
  HEADER_LEN,
  observationSigningHash,
  priceUpdateSigningHash,
  quorum,
  recoverSigner,
  verifyObservation,
  verifyThreshold,
  type CommitteeConfig,
  type Hex,
  type Observation,
  type PriceUpdate,
  type PriceUpdateHeader,
  type PublisherSetData,
  type SignedObservation,
  type UpdateEntry,
} from "lean-oracle-sdk/protocol";
import { toSignatureBundle } from "lean-oracle-sdk/publisher";

import { aggregateMessages, withinTolerance } from "./aggregate.js";
import type { ActiveConfig, ConfigSchedule } from "./configSchedule.js";
import type { KeySigner } from "./keySigner.js";
import { leaderOrder, NO_ANCHOR, slotOpensAt } from "./leaderOrder.js";
import type { MarketData } from "./marketData.js";
import { observeFeeds } from "./methodology.js";
import type { PublisherStore } from "./store.js";
import type { Transport } from "./transport.js";
import { decodeMessage, encodeMessage, proposalDigest, type PeerMessage, type ProposalBody } from "./wire.js";

export interface PublisherNodeOptions {
  index: number;
  signer: KeySigner;
  publisherSetTypeHash: Hex;
  publisherSet: PublisherSetData;
  schedule: ConfigSchedule;
  store: PublisherStore;
  transport: Transport;
  marketData: MarketData;
  now?: () => number;
  log?: (event: string, detail?: Record<string, unknown>) => void;
  /** Clock skew tolerated when checking a proposer's slot, in ms. */
  skewMs?: number;
}

interface Derived {
  header: PriceUpdateHeader;
  entries: UpdateEntry[];
  headerHash: Hex;
}

interface Anchor {
  tickMs: bigint;
  hash: Hex;
}

interface TickState {
  observations: Map<number, SignedObservation>;
  own?: Observation;
  anchor?: Anchor;
  best?: SignedProposal;
  proposedRanks: Set<number>;
  requestedTick: boolean;
  pending: { from: number; proposal: SignedProposal }[];
  derived: Map<Hex, Derived>;
  signatures: Map<Hex, Map<number, Hex>>;
  finalized: boolean;
  /** Peers already sent our finalized update for this tick. */
  sharedWith: Set<number>;
}

interface SignedProposal {
  rank: number;
  proposer: number;
  body: ProposalBody;
  signature: Hex;
}

const SYNC_BATCH = 200;
const anchorHashOf = (blob: Uint8Array): Hex => priceUpdateSigningHash(decodePriceUpdateHeader(blob.subarray(0, HEADER_LEN)));

export class PublisherNode {
  private readonly ticks = new Map<bigint, TickState>();
  private readonly n: number;
  private readonly quorum: number;
  /** Backup ranks: `f = n − quorum` candidates beyond the primary guarantee one honest, live proposer. */
  readonly maxRank: number;
  private readonly now: () => number;
  private readonly log: NonNullable<PublisherNodeOptions["log"]>;

  constructor(private readonly o: PublisherNodeOptions) {
    this.n = o.publisherSet.current.pubkeys.length;
    this.quorum = quorum(o.publisherSet.current);
    this.maxRank = this.n - this.quorum;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
    o.transport.onFrame((from, frame) => void this.receive(from, frame));
  }

  get index(): number {
    return this.o.index;
  }

  /** Anchor for `tickMs`: latest finalized update at or before `tick − 2 periods`. */
  anchor(tickMs: bigint): Anchor {
    const state = this.tick(tickMs);
    if (state.anchor) return state.anchor;
    const active = this.o.schedule.at(tickMs);
    const row = active ? this.o.store.finalizedAtOrBefore(tickMs - 2n * BigInt(active.config.tickPeriodMs)) : undefined;
    return row ? { tickMs: row.tickMs, hash: anchorHashOf(row.blob) } : { tickMs: 0n, hash: NO_ANCHOR };
  }

  /** Publisher indexes for ranks 0..maxRank at `tickMs`. */
  leaders(tickMs: bigint): number[] {
    return leaderOrder(tickMs, this.anchor(tickMs).hash, this.n).slice(0, this.maxRank + 1);
  }

  /** At each tick boundary: measure, sign the observation and send it to every publisher. */
  async observe(tickMs: bigint): Promise<void> {
    const active = this.o.schedule.at(tickMs);
    if (!active || (this.o.publisherSet.governanceFlags & GOVERNANCE_PAUSED) !== 0) return;
    const entries = observeFeeds(active.config, this.o.marketData, Number(tickMs));
    if (entries.length === 0) {
      this.log("observe.empty", { tickMs: tickMs.toString() });
      return;
    }
    const observation: Observation = {
      publisherSetTypeHash: this.o.publisherSetTypeHash,
      setIndex: this.o.publisherSet.current.setIndex,
      tickMs,
      configHash: active.hash,
      publisherIndex: this.o.index,
      entries,
    };
    const signed: SignedObservation = { observation, signature: await this.o.signer.sign(observationSigningHash(observation)) };
    const state = this.tick(tickMs);
    state.own = observation;
    state.observations.set(this.o.index, signed);
    this.o.transport.broadcast(encodeMessage({ type: "observation", signed }));
    await this.proposeEarly(tickMs);
  }

  /**
   * Called by the scheduler after the grace period and at each backup slot. Proposes if this
   * publisher holds a rank whose slot is open and the tick is not finalized.
   */
  async maybePropose(tickMs: bigint): Promise<void> {
    const state = this.tick(tickMs);
    const active = this.o.schedule.at(tickMs);
    if (!active || state.finalized || this.passed(tickMs)) return;
    const rank = this.leaders(tickMs).indexOf(this.o.index);
    if (rank < 0 || state.proposedRanks.has(rank)) return;
    if (BigInt(this.now()) < slotOpensAt(tickMs, rank, active.config.observationDeadlineMs)) return;
    // A backup first learns what its peers hold (observations, best proposal); the scheduler calls
    // again shortly after.
    if (rank > 0 && !state.requestedTick && !state.best && state.observations.size < this.n) {
      state.requestedTick = true;
      this.o.transport.broadcast(encodeMessage({ type: "tick_request", tickMs }));
      return;
    }
    // Re-propose the best proposal already seen, so signatures already given still count.
    const body = state.best?.body ?? this.ownBody(tickMs);
    if (!body) {
      this.log("propose.no_quorum", { tickMs: tickMs.toString(), rank, observations: state.observations.size });
      return;
    }
    state.proposedRanks.add(rank);
    const proposal: SignedProposal = { rank, proposer: this.o.index, body, signature: await this.o.signer.sign(proposalDigest(rank, this.o.index, body)) };
    this.o.transport.broadcast(encodeMessage({ type: "proposal", ...proposal }));
    await this.onProposal(this.o.index, proposal);
  }

  /** Ask peers for finalized updates after our latest (on start, periodically, and when behind). */
  requestSync(to?: number): void {
    const frame = encodeMessage({ type: "sync_request", afterTickMs: this.o.store.latestFinalizedTick() ?? 0n });
    if (to === undefined) this.o.transport.broadcast(frame);
    else this.o.transport.send(to, frame);
  }

  /** Drop per-tick memory older than `keepMs`. */
  prune(keepMs = 60_000): void {
    const cutoff = BigInt(this.now() - keepMs);
    for (const tick of this.ticks.keys()) if (tick < cutoff) this.ticks.delete(tick);
  }

  // ── message handling ──────────────────────────────────────────────────────────────────────

  private async receive(from: number, frame: Uint8Array): Promise<void> {
    let m: PeerMessage;
    try {
      m = decodeMessage(frame);
    } catch (error) {
      this.log("peer.bad_frame", { from, error: (error as Error).message });
      return;
    }
    try {
      switch (m.type) {
        case "observation":
          return await this.onObservation(from, m.signed);
        case "proposal":
          return await this.onProposal(from, m);
        case "tick_request": {
          const state = this.ticks.get(m.tickMs);
          if (!state) return;
          for (const signed of state.observations.values()) this.o.transport.send(from, encodeMessage({ type: "observation", signed }));
          if (state.best) this.o.transport.send(from, encodeMessage({ type: "proposal", ...state.best }));
          return;
        }
        case "signature":
          return this.onSignature(from, m.tickMs, m.headerHash, m.signature);
        case "obs_request":
          for (const i of m.indexes) {
            const signed = this.ticks.get(m.tickMs)?.observations.get(i);
            if (signed) this.o.transport.send(from, encodeMessage({ type: "observation", signed }));
          }
          return;
        case "sync_request": {
          const blobs = this.o.store.finalizedAfter(m.afterTickMs, SYNC_BATCH).map((hex) => Uint8Array.from(Buffer.from(hex.slice(2), "hex")));
          this.o.transport.send(from, encodeMessage({ type: "sync_response", blobs }));
          return;
        }
        case "sync_response":
          for (const blob of m.blobs) this.acceptFinalized(blob);
          return;
      }
    } catch (error) {
      this.log("peer.error", { type: m.type, from, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Observations are signed by their author, so they may arrive relayed by any peer. */
  private async onObservation(from: number, signed: SignedObservation): Promise<void> {
    const o = signed.observation;
    if (!this.acceptable(signed, o.tickMs)) return;
    const state = this.tick(o.tickMs);
    const existing = state.observations.get(o.publisherIndex);
    if (existing) {
      if (observationSigningHash(existing.observation) !== observationSigningHash(o)) {
        this.log("peer.equivocating_observation", { author: o.publisherIndex, relayedBy: from, tickMs: o.tickMs.toString() });
      }
      return;
    }
    state.observations.set(o.publisherIndex, signed);
    const pending = state.pending.splice(0);
    for (const p of pending) await this.onProposal(p.from, p.proposal);
    await this.proposeEarly(o.tickMs);
  }

  private acceptable(signed: SignedObservation, tickMs: bigint): boolean {
    const o = signed.observation;
    return (
      o.tickMs === tickMs &&
      o.publisherSetTypeHash === this.o.publisherSetTypeHash &&
      o.configHash === this.o.schedule.at(tickMs)?.hash &&
      verifyObservation(signed, this.o.publisherSet.current)
    );
  }

  /** `from` is whoever delivered the proposal; `proposal.proposer` signed it (it may be relayed). */
  private async onProposal(from: number, proposal: SignedProposal): Promise<void> {
    const { rank, proposer, body } = proposal;
    const tickMs = body.tickMs;
    const reject = (reason: string, detail: Record<string, unknown> = {}) =>
      this.log("sign.reject", { tickMs: tickMs.toString(), from, proposer, rank, reason, ...detail });
    const active = this.o.schedule.at(tickMs);
    if (!active) return reject("no active config");
    const state = this.tick(tickMs);
    if (state.finalized) return this.shareFinalized(from, tickMs);
    if (this.passed(tickMs)) return;

    // Anchor first: it decides the leader order.
    const anchor = this.anchor(tickMs);
    if (body.anchorTickMs > anchor.tickMs) {
      this.requestSync(from);
      return reject("behind on anchor; syncing");
    }
    if (body.anchorTickMs !== anchor.tickMs || body.anchorHash !== anchor.hash) return reject("anchor mismatch");
    if (rank > this.maxRank || this.leaders(tickMs)[rank] !== proposer) return reject("not the leader for this rank");
    const key = this.o.publisherSet.current.pubkeys[proposer];
    if (!key || recoverSigner(proposalDigest(rank, proposer, body), proposal.signature) !== key.toLowerCase()) return reject("bad proposal signature");

    const now = BigInt(this.now());
    if (now + BigInt(this.o.skewMs ?? 50) < slotOpensAt(tickMs, rank, active.config.observationDeadlineMs)) return reject("slot not open");
    if (tickMs < now - BigInt(active.config.maxSigningLagMs) || tickMs > now + BigInt(active.config.tickPeriodMs)) {
      return reject("outside signing window");
    }

    const myPrev = this.o.store.latestFinalizedTick() ?? 0n;
    if (body.prevTickMs > myPrev) {
      this.requestSync(from);
      return reject("behind on history; syncing");
    }
    if (body.prevTickMs < myPrev) return reject("proposer behind on history");

    const indexes = body.chosen.map((c) => c.index);
    if (indexes.length < this.quorum || indexes.some((i, k) => i >= this.n || (k > 0 && i <= indexes[k - 1]!))) {
      return reject("invalid observation set");
    }
    // Only a leader-validated proposal may become the one backups re-propose.
    if (!state.best || rank < state.best.rank) state.best = proposal;

    const missing = body.chosen.filter((c) => !state.observations.has(c.index)).map((c) => c.index);
    if (missing.length > 0) {
      state.pending.push({ from, proposal });
      const request = encodeMessage({ type: "obs_request", tickMs, indexes: missing });
      this.o.transport.send(from, request);
      if (proposer !== from) this.o.transport.send(proposer, request);
      return;
    }
    const observations = body.chosen.map((c) => state.observations.get(c.index)!);
    if (body.chosen.some((c, k) => observationSigningHash(observations[k]!.observation) !== c.hash)) return reject("observation hash mismatch");

    const derived = this.derive(tickMs, active, observations.map((s) => s.observation));
    if (!derived) return reject("no feed reached quorum");
    state.derived.set(derived.headerHash, derived);
    this.tryFinalize(tickMs, derived.headerHash);

    if (state.own) {
      for (const { message } of derived.entries) {
        const mine = state.own.entries.find((e) => e.feedId === message.feedId);
        const tolerance = active.config.feeds.find((f) => f.feedId === message.feedId)!.toleranceBps;
        if (mine && !withinTolerance(message.price, mine.price, tolerance)) return reject("outside tolerance", { feedId: message.feedId });
      }
    }
    if (!this.o.store.reserveSignature(tickMs, derived.headerHash)) return reject("already signed a different header");
    const signature = await this.o.signer.sign(derived.headerHash);
    this.o.transport.broadcast(encodeMessage({ type: "signature", tickMs, headerHash: derived.headerHash, signature }));
    this.onSignature(this.o.index, tickMs, derived.headerHash, signature);
  }

  private onSignature(from: number, tickMs: bigint, headerHash: Hex, signature: Hex): void {
    const key = this.o.publisherSet.current.pubkeys[from];
    if (!key || recoverSigner(headerHash, signature) !== key.toLowerCase()) return;
    const state = this.tick(tickMs);
    if (state.finalized) return this.shareFinalized(from, tickMs);
    const byHeader = state.signatures.get(headerHash) ?? new Map<number, Hex>();
    byHeader.set(from, signature);
    state.signatures.set(headerHash, byHeader);
    this.tryFinalize(tickMs, headerHash);
  }

  private tryFinalize(tickMs: bigint, headerHash: Hex): void {
    const state = this.tick(tickMs);
    const derived = state.derived.get(headerHash);
    const signatures = state.signatures.get(headerHash);
    if (state.finalized || !derived || !signatures || signatures.size < this.quorum || this.passed(tickMs)) return;
    const bundle = toSignatureBundle([...signatures].map(([publisherIndex, signature]) => ({ publisherIndex, signature }))).slice(0, this.quorum);
    const update: PriceUpdate = { header: derived.header, signatures: bundle, entries: derived.entries };
    state.finalized = true;
    this.o.store.saveFinalized(update, encodePriceUpdate(update));
    this.log("finalized", { tickMs: tickMs.toString(), feeds: update.entries.length, signers: bundle.map((s) => s.publisherIndex) });
  }

  private acceptFinalized(blob: Uint8Array): void {
    const update = decodePriceUpdate(blob);
    const { header } = update;
    if (header.publisherSetTypeHash !== this.o.publisherSetTypeHash) return;
    // History from an earlier key set is accepted only if this publisher knows that set (it ran
    // under it or shadowed it); a newer set than ours is never accepted.
    const current = this.o.publisherSet.current;
    const set = header.setIndex === current.setIndex ? current : header.setIndex < current.setIndex ? this.o.store.keySet(header.setIndex) : undefined;
    if (!set) return;
    if (!verifyThreshold(update.signatures, priceUpdateSigningHash(header), set)) {
      this.log("finalized.bad_signatures", { tickMs: header.publishTimeMs.toString() });
      return;
    }
    if (this.o.store.saveFinalized(update, blob)) this.tick(header.publishTimeMs).finalized = true;
  }

  // ── helpers ───────────────────────────────────────────────────────────────────────────────

  /** A peer is still working on a tick we finalized: send it the finalized update, once. */
  private shareFinalized(to: number, tickMs: bigint): void {
    const state = this.tick(tickMs);
    if (to === this.o.index || state.sharedWith.has(to)) return;
    const blob = this.o.store.finalizedAt(tickMs);
    if (!blob) return;
    state.sharedWith.add(to);
    this.o.transport.send(to, encodeMessage({ type: "sync_response", blobs: [Uint8Array.from(Buffer.from(blob.slice(2), "hex"))] }));
  }

  /** Rank 0 proposes at once when it holds every publisher's observation. */
  private async proposeEarly(tickMs: bigint): Promise<void> {
    if (this.tick(tickMs).observations.size === this.n && this.leaders(tickMs)[0] === this.o.index) await this.maybePropose(tickMs);
  }

  /** A later tick is already finalized: this one is abandoned. */
  private passed(tickMs: bigint): boolean {
    const latest = this.o.store.latestFinalizedTick();
    return latest !== undefined && latest >= tickMs && !this.o.store.hasFinalized(tickMs);
  }

  private ownBody(tickMs: bigint): ProposalBody | undefined {
    const state = this.tick(tickMs);
    if (state.observations.size < this.quorum) return undefined;
    const anchor = this.anchor(tickMs);
    const chosen = [...state.observations.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, signed]) => ({ index, hash: observationSigningHash(signed.observation) }));
    return { tickMs, anchorTickMs: anchor.tickMs, anchorHash: anchor.hash, prevTickMs: this.o.store.latestFinalizedTick() ?? 0n, chosen };
  }

  private derive(tickMs: bigint, active: ActiveConfig, observations: Observation[]): Derived | undefined {
    const config: CommitteeConfig = active.config;
    const messages = aggregateMessages(config, observations, this.quorum, tickMs, (id) => this.o.store.feedState(id));
    if (messages.length === 0) return undefined;
    const { header, entries } = assemblePriceUpdate({
      publisherSetTypeHash: this.o.publisherSetTypeHash,
      setIndex: this.o.publisherSet.current.setIndex,
      publishTimeMs: tickMs,
      tickPeriodMs: config.tickPeriodMs,
      configHash: active.hash,
      messages,
    });
    return { header, entries, headerHash: priceUpdateSigningHash(header) };
  }

  private tick(tickMs: bigint): TickState {
    let state = this.ticks.get(tickMs);
    if (!state) {
      state = { observations: new Map(), proposedRanks: new Set(), requestedTick: false, pending: [], derived: new Map(), signatures: new Map(), finalized: false, sharedWith: new Set() };
      this.ticks.set(tickMs, state);
    }
    return state;
  }
}
