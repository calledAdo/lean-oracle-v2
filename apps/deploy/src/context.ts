//! Deployment context: the checked-in network config (`config/<network>.json`), operator secrets
//! from the environment (`.env`), the CKB client and signer, and the deployment record.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ccc } from "@ckb-ccc/core";
import { createClient, createPrivateKeySigner, type DevnetSecpOverride } from "lean-oracle-sdk/ckb";
import type { ContractName, NetworkName } from "lean-oracle-sdk/presets";
import type { Hex } from "lean-oracle-sdk/protocol";

import { RecordStore } from "./record.js";

export const DEPLOY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(DEPLOY_ROOT, "../..");

export interface CommitteeIntent {
  /** Compressed secp256k1 public keys (any order; sorted on deploy). */
  pubkeys: Hex[];
  /** Replay domain for rotations (default: the chain's genesis block hash). */
  networkId?: Hex;
}

export interface NetworkConfig {
  network: NetworkName;
  rpcUrl: string;
  /** Shannons per 1000 bytes (default: the node's fee-rate statistics). */
  feeRate?: string;
  /** Devnet only: offckb's secp256k1 script. */
  secp256k1?: DevnetSecpOverride;
  /** Contract binaries, relative to the repository root. */
  binaries: Record<ContractName, string>;
  committees: Record<string, CommitteeIntent>;
}

export interface Context {
  network: NetworkName;
  config: NetworkConfig;
  client: ccc.Client;
  signer: ccc.SignerCkbPrivateKey;
  record: RecordStore;
  feeRate?: bigint;
  broadcast: boolean;
}

export function loadEnv(): void {
  const path = resolve(DEPLOY_ROOT, ".env");
  if (existsSync(path)) process.loadEnvFile(path);
}

export function loadConfig(network: string): NetworkConfig {
  if (!["devnet", "testnet", "mainnet"].includes(network)) throw new Error(`unknown network ${network}; use devnet, testnet or mainnet`);
  const config = JSON.parse(readFileSync(resolve(DEPLOY_ROOT, "config", `${network}.json`), "utf8")) as NetworkConfig;
  if (config.network !== network) throw new Error(`config/${network}.json says network ${config.network}`);
  return config;
}

/** The deployer key: `<NET>_DEPLOYER_PRIVATE_KEY`, or a file named by `<NET>_DEPLOYER_KEY_FILE`. */
export function deployerKey(network: NetworkName): Hex {
  const prefix = network.toUpperCase();
  const inline = process.env[`${prefix}_DEPLOYER_PRIVATE_KEY`];
  const file = process.env[`${prefix}_DEPLOYER_KEY_FILE`];
  const key = inline ?? (file ? readFileSync(isAbsolute(file) ? file : resolve(DEPLOY_ROOT, file), "utf8").trim() : undefined);
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`set ${prefix}_DEPLOYER_PRIVATE_KEY or ${prefix}_DEPLOYER_KEY_FILE (see apps/deploy/.env.example)`);
  return key as Hex;
}

export function loadContext(network: string, broadcastFlag: boolean): Context {
  const config = loadConfig(network);
  const rpcUrl = process.env[`${config.network.toUpperCase()}_CKB_RPC_URL`] ?? config.rpcUrl;
  const client = createClient(config.network, rpcUrl, config.secp256k1);
  return {
    network: config.network,
    config,
    client,
    signer: createPrivateKeySigner(client, deployerKey(config.network)),
    record: new RecordStore(resolve(REPO_ROOT, "deployments", `${config.network}.json`), config.network),
    feeRate: config.feeRate ? BigInt(config.feeRate) : undefined,
    broadcast: broadcastFlag || process.env.BROADCAST === "true",
  };
}
