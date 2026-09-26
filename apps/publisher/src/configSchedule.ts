//! Every approved committee config version, and which one is active at a tick
//! (docs/oracle-design.md section 3.1). A version applies from its activation tick until the next
//! version's activation tick.

import { committeeConfigHash, validateCommitteeConfig, verifyCommitteeConfig, type CommitteeConfig, type Hex, type PublisherSet, type SignedCommitteeConfig } from "lean-oracle-sdk/protocol";

export interface ActiveConfig {
  config: CommitteeConfig;
  hash: Hex;
}

export class ConfigSchedule {
  private readonly versions: ActiveConfig[] = [];

  constructor(private readonly publisherSetTypeHash: Hex, private readonly set: PublisherSet) {}

  /** Index of the key set configs must be approved by. */
  get setIndex(): number {
    return this.set.setIndex;
  }

  /**
   * Add an approved version. It must be valid, approved by a quorum of the current set, for this
   * committee, and later in both version and activation than every version held.
   */
  add(signed: SignedCommitteeConfig): ActiveConfig {
    const { config } = signed;
    const problems = validateCommitteeConfig(config);
    if (problems.length > 0) throw new Error(`invalid committee config v${config.version}: ${problems.join("; ")}`);
    if (config.publisherSetTypeHash.toLowerCase() !== this.publisherSetTypeHash) throw new Error(`config v${config.version} is for another committee`);
    if (!verifyCommitteeConfig(signed, this.set)) throw new Error(`config v${config.version} lacks a quorum of valid signatures`);
    const hash = committeeConfigHash(config);
    const existing = this.versions.find((v) => v.config.version === config.version);
    if (existing) {
      if (existing.hash !== hash) throw new Error(`conflicting configs for version ${config.version}`);
      return existing;
    }
    const last = this.versions[this.versions.length - 1];
    if (last && (config.version < last.config.version || BigInt(config.activationTickMs) <= BigInt(last.config.activationTickMs))) {
      throw new Error(`config v${config.version} must follow v${last.config.version} in version and activation`);
    }
    const entry = { config, hash };
    this.versions.push(entry);
    return entry;
  }

  /** The config active at `tickMs`, or undefined before the first activation. */
  at(tickMs: bigint): ActiveConfig | undefined {
    for (let i = this.versions.length - 1; i >= 0; i--) {
      if (BigInt(this.versions[i]!.config.activationTickMs) <= tickMs) return this.versions[i];
    }
    return undefined;
  }

  /** Every held version (current and future), for subscribing to their markets. */
  all(): readonly ActiveConfig[] {
    return this.versions;
  }
}
