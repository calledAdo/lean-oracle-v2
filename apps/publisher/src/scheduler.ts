//! Drives a node on wall-clock tick boundaries of the active config: observe at `t`; give rank 0 its
//! chance after a short grace; open each backup rank's slot at `t + r × deadline`; periodic sync and
//! memory pruning.

import type { ConfigSchedule } from "./configSchedule.js";
import type { PublisherNode } from "./node.js";

/** How long rank 0 waits for stragglers once it holds a quorum (it proposes at once with all n). */
export const GRACE_MS = 100;
/** How long a backup waits for its peers' observations and best proposal before proposing. */
export const BACKUP_PREPARE_MS = 100;

export class TickScheduler {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private fired = 0;

  constructor(private readonly node: PublisherNode, private readonly schedule: ConfigSchedule, private readonly syncEveryTicks = 30) {}

  start(): void {
    this.stopped = false;
    this.node.requestSync();
    this.schedule_();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Next tick boundary after `nowMs` under the config active then (or the first activation). */
  nextTick(nowMs: number): bigint {
    const now = BigInt(nowMs);
    const active = this.schedule.at(now) ?? this.schedule.all()[0];
    if (!active) throw new Error("no committee config");
    const period = BigInt(active.config.tickPeriodMs);
    const next = (now / period) * period + period;
    // A later version may activate before `next`; its activation tick is itself a tick.
    const upcoming = this.schedule.all().find((v) => BigInt(v.config.activationTickMs) > now);
    return upcoming && BigInt(upcoming.config.activationTickMs) < next ? BigInt(upcoming.config.activationTickMs) : next;
  }

  private schedule_(): void {
    if (this.stopped) return;
    const next = this.nextTick(Date.now());
    this.timer = setTimeout(() => this.fire(next), Math.max(0, Number(next) - Date.now()));
  }

  private fire(tickMs: bigint): void {
    const active = this.schedule.at(tickMs);
    if (active) {
      const deadline = active.config.observationDeadlineMs;
      void this.node.observe(tickMs);
      setTimeout(() => void this.node.maybePropose(tickMs), Math.min(GRACE_MS, deadline));
      for (let rank = 1; rank <= this.node.maxRank; rank++) {
        // First call asks peers for the tick's state; the second proposes.
        setTimeout(() => void this.node.maybePropose(tickMs), rank * deadline);
        setTimeout(() => void this.node.maybePropose(tickMs), rank * deadline + BACKUP_PREPARE_MS);
      }
    }
    if (++this.fired % this.syncEveryTicks === 0) {
      this.node.requestSync();
      this.node.prune();
    }
    this.schedule_();
  }
}
