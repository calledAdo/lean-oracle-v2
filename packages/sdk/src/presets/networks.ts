//! Network presets: RPC, mirrors and the canonical deployment for each public network.

import { parseDeployment, type LeanOracleDeployment, type NetworkName } from "./deployment.js";
import { DEPLOYMENT_RECORDS } from "./deployments.generated.js";

/** @public */
export interface LeanOracleNetworkPreset {
  name: NetworkName;
  ckbRpcUrl: string;
  /** Public mirrors, tried in order. Empty until one is announced for the network. */
  mirrorUrls: string[];
  /** Undefined until the contracts are deployed on this network. */
  deployment?: LeanOracleDeployment;
}

const deployed = (network: "testnet" | "mainnet") => {
  const record = DEPLOYMENT_RECORDS[network];
  return record ? parseDeployment(record) : undefined;
};

/** Public deployments, from `deployments/<network>.json` at build time. */
export const DEPLOYMENTS: Partial<Record<NetworkName, LeanOracleDeployment>> = Object.fromEntries(
  (["testnet", "mainnet"] as const).flatMap((n) => (deployed(n) ? [[n, deployed(n)!]] : [])),
);

/** @public */
export const leanOracleTestnetPreset: LeanOracleNetworkPreset = {
  name: "testnet",
  ckbRpcUrl: "https://testnet.ckb.dev/rpc",
  mirrorUrls: ["https://64-227-40-35.sslip.io"],
  deployment: DEPLOYMENTS.testnet,
};

/** @public */
export const leanOracleMainnetPreset: LeanOracleNetworkPreset = {
  name: "mainnet",
  ckbRpcUrl: "https://mainnet.ckb.dev/rpc",
  mirrorUrls: [],
  deployment: DEPLOYMENTS.mainnet,
};

/** A preset's deployment, or a clear error when the network has none yet. */
export function requireDeployment(preset: LeanOracleNetworkPreset): LeanOracleDeployment {
  if (!preset.deployment) throw new Error(`Lean Oracle is not deployed on ${preset.name} yet`);
  return preset.deployment;
}
