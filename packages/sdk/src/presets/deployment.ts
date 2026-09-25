//! Deployment records.
//!
//! `deployments/<network>.json` is an append-only record written by `lean-oracle-deploy`: every
//! contract version ever deployed, which one is current, every committee with the contract version
//! it was created under, and a history of every broadcast action. `parseDeployment` turns a record
//! into the resolved `LeanOracleDeployment` the transaction builders use.

import type { CellDepInfo, Hex, Script } from "../types.js";

export type NetworkName = "devnet" | "testnet" | "mainnet";
export type ContractName = "priceFeedType" | "publisherSetType";

export interface CodeRef {
  codeHash: Hex;
  hashType: "data2";
  cellDep: CellDepInfo;
  /** Version number in the deployment record (1, 2, ...). */
  version?: number;
}

export interface CommitteeRef {
  typeScript: Script;
  typeHash: Hex;
}

/** Resolved view: the current contract versions, all versions, and the committees. */
export interface LeanOracleDeployment {
  network: NetworkName;
  contracts: Record<ContractName, CodeRef>;
  /** Every deployed version of each contract, by version number. */
  contractVersions?: Record<ContractName, Record<number, CodeRef>>;
  committees: Record<string, CommitteeRef>;
}

// ── On-disk record (append-only) ────────────────────────────────────────────

export interface CodeVersionRecord {
  codeHash: Hex;
  hashType: "data2";
  cellDep: CellDepInfo;
  bytes: number;
  capacity: string;
  deployedAt: string;
  /** Set when the code cell was consumed; cells created under this version can no longer move. */
  retired?: { txHash: Hex; at: string };
}

export interface CommitteeRecord extends CommitteeRef {
  /** `publisherSetType` version the committee cell was created under. */
  codeVersion: number;
  createdTx: Hex;
  createdAt: string;
  publishers: number;
  rotations: { setIndex: number; publishers: number; txHash: Hex; at: string }[];
}

export interface HistoryEntry {
  action: string;
  txHash: Hex;
  at: string;
  detail?: Record<string, unknown>;
}

export interface RetiredCommitteeRecord extends CommitteeRecord {
  name: string;
  retiredAt: string;
  reason: string;
}

export interface DeploymentRecord {
  network: NetworkName;
  contracts: Partial<Record<ContractName, { current: number; versions: Record<string, CodeVersionRecord> }>>;
  committees: Record<string, CommitteeRecord>;
  /** Committees no longer in use (a committee cell cannot be destroyed, only abandoned). */
  retiredCommittees?: RetiredCommitteeRecord[];
  history: HistoryEntry[];
}

export function emptyDeploymentRecord(network: NetworkName): DeploymentRecord {
  return { network, contracts: {}, committees: {}, history: [] };
}

const isHex32 = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const CONTRACTS: ContractName[] = ["priceFeedType", "publisherSetType"];

function checkCode(c: CodeRef | undefined, name: string): CodeRef {
  if (!c || !isHex32(c.codeHash) || c.hashType !== "data2" || !isHex32(c.cellDep?.outPoint?.txHash)) {
    throw new TypeError(`deployment: invalid ${name}`);
  }
  return c;
}

/**
 * Resolve a deployment record (or an already-resolved deployment) into a `LeanOracleDeployment`.
 * Committees must reference a known `publisherSetType` version.
 */
export function parseDeployment(value: unknown): LeanOracleDeployment {
  const raw = value as { network?: NetworkName; contracts?: Record<string, unknown>; committees?: Record<string, CommitteeRef> };
  if (!raw || !["devnet", "testnet", "mainnet"].includes(raw.network ?? "")) throw new TypeError("deployment: invalid network");
  const contracts = {} as Record<ContractName, CodeRef>;
  const contractVersions = {} as Record<ContractName, Record<number, CodeRef>>;
  for (const name of CONTRACTS) {
    const entry = raw.contracts?.[name] as { current?: number; versions?: Record<string, CodeVersionRecord> } | CodeRef | undefined;
    if (entry && "versions" in entry && entry.versions) {
      const versions: Record<number, CodeRef> = {};
      for (const [n, v] of Object.entries(entry.versions)) {
        if (v.retired) continue;
        versions[Number(n)] = checkCode({ codeHash: v.codeHash, hashType: v.hashType, cellDep: v.cellDep, version: Number(n) }, `${name} v${n}`);
      }
      const current = versions[entry.current ?? -1];
      if (!current) throw new TypeError(`deployment: ${name} has no current version`);
      contracts[name] = current;
      contractVersions[name] = versions;
    } else {
      contracts[name] = checkCode(entry as CodeRef | undefined, `contracts.${name}`);
      contractVersions[name] = { [contracts[name].version ?? 1]: contracts[name] };
    }
  }
  const committees: Record<string, CommitteeRef> = {};
  const setCodeHashes = new Set(Object.values(contractVersions.publisherSetType).map((c) => c.codeHash.toLowerCase()));
  for (const [name, c] of Object.entries(raw.committees ?? {})) {
    if (!isHex32(c.typeHash) || !setCodeHashes.has(c.typeScript?.codeHash?.toLowerCase() ?? "")) throw new TypeError(`deployment: invalid committee ${name}`);
    committees[name] = { typeScript: c.typeScript, typeHash: c.typeHash };
  }
  return { network: raw.network!, contracts, contractVersions, committees };
}

/** The version of `contract` whose code hash is `codeHash` (cells keep the code they were created with). */
export function codeRefFor(deployment: LeanOracleDeployment, contract: ContractName, codeHash: Hex): CodeRef {
  const all = deployment.contractVersions?.[contract] ?? { 0: deployment.contracts[contract] };
  const found = Object.values(all).find((c) => c.codeHash.toLowerCase() === codeHash.toLowerCase());
  if (!found) throw new Error(`${contract} code ${codeHash} is not in this deployment`);
  return found;
}
