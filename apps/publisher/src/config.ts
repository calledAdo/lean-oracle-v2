//! Operator config (a JSON file) and loading of the committee inputs it points to.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { decodePublisherSetData, type CommitteeConfig, type Hex, type IndexedSignature, type PublisherSetData, type SignedCommitteeConfig } from "lean-oracle-sdk/protocol";
import { toSignatureBundle } from "lean-oracle-sdk/publisher";

import { fetchCommitteeData, type ScriptJson } from "./chain.js";
import { ConfigSchedule } from "./configSchedule.js";
import type { DnsConfig } from "./net/resolver.js";
import { createKeySigner, type KeyConfig, type KeySigner } from "./keySigner.js";

export interface OperatorConfig {
  /** Where the publisher key lives: a file (`{ "type": "file", "path" }`) or AWS KMS. */
  key: KeyConfig;
  dataDir: string;
  listen: { host: string; port: number };
  api: { host: string; port: number };
  /** Peer publishers by compressed public key → WebSocket URL. */
  peers: { pubkey: Hex; url: string }[];
  committee: {
    publisherSetTypeHash: Hex;
    /** Read the committee cell from CKB (preferred): node RPC URL and the committee type script. */
    chain?: { rpcUrl: string; typeScript: ScriptJson };
    /** Or committee cell data as 0x-hex in a file (development without a chain). */
    publisherSetFile?: string;
    /**
     * Directory of approved committee configs, one JSON file per version:
     * `{ "config": {...}, "signatures": [{ "publisherIndex", "signature" }, ...] }`. Re-read while
     * running, so a new version can be dropped in ahead of its activation tick.
     */
    configDir: string;
  };
  /**
   * DNS for exchange connections. `{ "dns": { "mode": "doh" } }` resolves exchange hosts over
   * DNS-over-HTTPS (default https://1.1.1.1/dns-query), for networks whose resolvers block them.
   */
  network?: { dns?: DnsConfig };
  /**
   * Shadow mode: record and price every feed like a member, but sign nothing and join no peers;
   * compare the results with the committee's signed updates from this mirror. The key need not be
   * in the committee.
   */
  shadow?: { referenceUrl: string };
  /** Development only: synthetic quotes instead of exchanges, with this publisher's skew in bps. */
  mockSource?: { skewBps: number; prices: Record<string, string> };
}

export interface LoadedConfig {
  operator: OperatorConfig;
  signer: KeySigner;
  /** This key's index in the current set; -1 in shadow mode when the key is not a member. */
  index: number;
  publisherSet: PublisherSetData;
  schedule: ConfigSchedule;
  peers: Map<number, string>;
}

const readText = (path: string) => readFileSync(path, "utf8").trim();

/**
 * A committee config file. `signatures` are the approvals of the set the config was first signed by.
 * `approvals` holds approvals by later key sets, keyed by set index: publisher indexes change when
 * the committee rotates, so the next set approves the config again before a rotation, and publishers
 * restarting under the new set find their approval ready.
 */
export interface ConfigFile {
  config: CommitteeConfig;
  signatures: IndexedSignature[];
  approvals?: { setIndex: number; signatures: IndexedSignature[] }[];
}

/** The approval by key set `setIndex`: from `approvals` if present, else `signatures`. */
export function approvalFor(file: ConfigFile, setIndex: number): IndexedSignature[] {
  return file.approvals?.find((a) => a.setIndex === setIndex)?.signatures ?? file.signatures;
}

/** Add every config file in `dir` not yet in `schedule`; returns the versions added. */
export function loadConfigDir(dir: string, schedule: ConfigSchedule, log: (event: string, detail?: Record<string, unknown>) => void = () => {}): number[] {
  if (!existsSync(dir)) throw new Error(`configDir ${dir} does not exist`);
  const known = new Set(schedule.all().map((v) => v.config.version));
  // Hidden files (e.g. macOS `._*` metadata) are never configs.
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
  const parsed = files.map((f) => ({ file: f, raw: JSON.parse(readText(join(dir, f))) as ConfigFile }));
  const added: number[] = [];
  for (const { file, raw } of parsed.sort((a, b) => a.raw.config.version - b.raw.config.version)) {
    if (known.has(raw.config.version)) continue;
    try {
      const signed: SignedCommitteeConfig = { config: raw.config, signatures: toSignatureBundle(approvalFor(raw, schedule.setIndex)) };
      schedule.add(signed);
      added.push(raw.config.version);
    } catch (error) {
      log("config.rejected", { file, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return added;
}

export async function loadConfig(path: string): Promise<LoadedConfig> {
  const base = dirname(resolve(path));
  const at = (p: string) => resolve(base, p);
  const operator = JSON.parse(readText(path)) as OperatorConfig;
  const publisherSetTypeHash = operator.committee.publisherSetTypeHash.toLowerCase() as Hex;

  const signer = await createKeySigner(operator.key.type === "file" ? { ...operator.key, path: at(operator.key.path) } : operator.key);
  let publisherSet: PublisherSetData;
  if (operator.committee.chain) {
    publisherSet = (await fetchCommitteeData(operator.committee.chain.rpcUrl, operator.committee.chain.typeScript)).data;
  } else if (operator.committee.publisherSetFile) {
    publisherSet = decodePublisherSetData(readText(at(operator.committee.publisherSetFile)) as Hex);
  } else {
    throw new Error("committee needs `chain` or `publisherSetFile`");
  }
  const index = publisherSet.current.pubkeys.indexOf(signer.publicKey);
  if (index < 0 && !operator.shadow) throw new Error(`this key (${signer.publicKey}) is not in the current publisher set`);

  const schedule = new ConfigSchedule(publisherSetTypeHash, publisherSet.current);
  const configDir = at(operator.committee.configDir);
  if (loadConfigDir(configDir, schedule, (event, detail) => { throw new Error(`${event}: ${JSON.stringify(detail)}`); }).length === 0) {
    throw new Error(`no approved committee config in ${configDir}`);
  }

  const peers = new Map<number, string>();
  for (const peer of operator.shadow ? [] : operator.peers) {
    const peerIndex = publisherSet.current.pubkeys.indexOf(peer.pubkey.toLowerCase() as Hex);
    if (peerIndex < 0) throw new Error(`peer ${peer.pubkey} is not in the current publisher set`);
    peers.set(peerIndex, peer.url);
  }
  return {
    operator: { ...operator, dataDir: at(operator.dataDir), committee: { ...operator.committee, publisherSetTypeHash, configDir } },
    signer,
    index,
    publisherSet,
    schedule,
    peers,
  };
}
