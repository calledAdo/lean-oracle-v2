//! Alert state: messages only on changes (failing → recovered and back), a reminder while something
//! stays down, and a daily summary so silence means "healthy".

import type { CheckResult } from "./checks.js";

export interface AlertPolicy {
  /** Repeat a still-failing alert this often (default 1 h). */
  remindEveryMs: number;
  /** Consecutive failures before alerting (default 2), to ride out a single blip. */
  failuresBeforeAlert: number;
}

interface State {
  failures: number;
  alerted: boolean;
  lastAlertMs: number;
  detail: string;
}

export class AlertState {
  private readonly states = new Map<string, State>();
  private equivocations: number | undefined;

  constructor(private readonly policy: AlertPolicy = { remindEveryMs: 3_600_000, failuresBeforeAlert: 2 }) {}

  /** Messages to send for this round of results. */
  update(results: CheckResult[], equivocations: number, now: number): string[] {
    const messages: string[] = [];
    for (const r of results) {
      const s = this.states.get(r.key) ?? { failures: 0, alerted: false, lastAlertMs: 0, detail: "" };
      s.detail = r.detail;
      if (r.ok) {
        if (s.alerted) messages.push(`✅ ${r.key} recovered: ${r.detail}`);
        s.failures = 0;
        s.alerted = false;
      } else {
        s.failures++;
        if (!s.alerted && s.failures >= this.policy.failuresBeforeAlert) {
          messages.push(`🚨 ${r.key}: ${r.detail}`);
          s.alerted = true;
          s.lastAlertMs = now;
        } else if (s.alerted && now - s.lastAlertMs >= this.policy.remindEveryMs) {
          messages.push(`⏰ still failing — ${r.key}: ${r.detail}`);
          s.lastAlertMs = now;
        }
      }
      this.states.set(r.key, s);
    }
    if (equivocations >= 0) {
      if (this.equivocations !== undefined && equivocations > this.equivocations) {
        messages.push(`🛑 EQUIVOCATION: the mirror recorded ${equivocations - this.equivocations} new conflicting update(s). Check /v1/equivocations and stop the affected publisher.`);
      }
      this.equivocations = equivocations;
    }
    return messages;
  }

  summary(): string {
    const lines = [...this.states].map(([key, s]) => `${s.alerted ? "🚨" : "✅"} ${key}: ${s.detail}`);
    return `Lean Oracle daily summary\n${lines.join("\n")}\nequivocations recorded: ${this.equivocations ?? "unknown"}`;
  }
}
