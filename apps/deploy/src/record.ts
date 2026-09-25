//! `deployments/<network>.json`: the append-only deployment record. Every action reads it, adds to
//! it (a new contract version, a committee, a rotation, a history entry) and writes it back
//! atomically. Nothing is ever removed or overwritten; `current` moves to a new version.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  emptyDeploymentRecord,
  parseDeployment,
  type CodeVersionRecord,
  type CommitteeRecord,
  type ContractName,
  type DeploymentRecord,
  type LeanOracleDeployment,
  type NetworkName,
} from "lean-oracle-sdk/presets";
import type { Hex } from "lean-oracle-sdk/protocol";

export class RecordStore {
  constructor(
    readonly path: string,
    private readonly network: NetworkName,
  ) {}

  read(): DeploymentRecord {
    if (!existsSync(this.path)) return emptyDeploymentRecord(this.network);
    const record = JSON.parse(readFileSync(this.path, "utf8")) as DeploymentRecord;
    if (record.network !== this.network) throw new Error(`${this.path} is for ${record.network}`);
    return { ...emptyDeploymentRecord(this.network), ...record };
  }

  /** The resolved deployment; requires both contracts. */
  deployment(): LeanOracleDeployment {
    const record = this.read();
    if (!record.contracts.priceFeedType || !record.contracts.publisherSetType) throw new Error(`no contracts in ${this.path}; run deploy:code first`);
    return parseDeployment(record);
  }

  current(contract: ContractName): { version: number; code: CodeVersionRecord } | undefined {
    const entry = this.read().contracts[contract];
    return entry && { version: entry.current, code: entry.versions[String(entry.current)]! };
  }

  appendCodeVersion(contract: ContractName, code: CodeVersionRecord, txHash: Hex): number {
    return this.update((record) => {
      const entry = record.contracts[contract] ?? { current: 0, versions: {} };
      const version = Math.max(0, ...Object.keys(entry.versions).map(Number)) + 1;
      entry.versions[String(version)] = code;
      entry.current = version;
      record.contracts[contract] = entry;
      record.history.push({ action: "deploy:code", txHash, at: code.deployedAt, detail: { contract, version, codeHash: code.codeHash } });
      return version;
    });
  }

  addCommittee(name: string, committee: CommitteeRecord): void {
    this.update((record) => {
      if (record.committees[name]) throw new Error(`committee ${name} already exists in ${this.path}`);
      record.committees[name] = committee;
      record.history.push({ action: "deploy:committee", txHash: committee.createdTx, at: committee.createdAt, detail: { name, typeHash: committee.typeHash, publishers: committee.publishers } });
    });
  }

  addRotation(name: string, rotation: CommitteeRecord["rotations"][number]): void {
    this.update((record) => {
      const committee = record.committees[name];
      if (!committee) throw new Error(`unknown committee ${name}`);
      committee.rotations.push(rotation);
      record.history.push({ action: "rotate:committee", txHash: rotation.txHash, at: rotation.at, detail: { name, setIndex: rotation.setIndex } });
    });
  }

  retireCode(contract: ContractName, version: number, txHash: Hex, at: string, allowCurrent = false): void {
    this.update((record) => {
      const entry = record.contracts[contract];
      const code = entry?.versions[String(version)];
      if (!entry || !code) throw new Error(`${contract} v${version} is not in the record`);
      if (entry.current === version && !allowCurrent) throw new Error(`${contract} v${version} is current; deploy a newer version first`);
      code.retired = { txHash, at };
      record.history.push({ action: "retire:code", txHash, at, detail: { contract, version } });
    });
  }

  retireCommittee(name: string, reason: string, at: string): void {
    this.update((record) => {
      const committee = record.committees[name];
      if (!committee) throw new Error(`unknown committee ${name}`);
      delete record.committees[name];
      (record.retiredCommittees ??= []).push({ ...committee, name, retiredAt: at, reason });
      record.history.push({ action: "retire:committee", txHash: committee.createdTx, at, detail: { name, typeHash: committee.typeHash, reason } });
    });
  }

  private update<T>(change: (record: DeploymentRecord) => T): T {
    const record = this.read();
    const result = change(record);
    // Never write a record the SDK cannot read back (except mid-migration, with no live current version).
    const midMigration = Object.values(record.contracts).some((c) => c && c.versions[String(c.current)]?.retired);
    if (record.contracts.priceFeedType && record.contracts.publisherSetType && !midMigration) parseDeployment(record);
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(temp, this.path);
    return result;
  }
}
