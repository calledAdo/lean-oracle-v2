//! Preset clients so consumers don't thread network constants (same pattern as lean-oracle-sdk 0.x).

import type { ccc } from "@ckb-ccc/core";

import { leanOracleMainnetPreset, leanOracleTestnetPreset, type LeanOracleNetworkPreset } from "../presets/networks.js";
import { LeanOracleClient } from "./LeanOracleClient.js";

/** @public */
export interface LeanOraclePresetClientOverrides {
  ckbRpcUrl?: string;
  mirrorUrls?: string[];
}

export interface LeanOraclePresetClientOptions {
  overrides?: LeanOraclePresetClientOverrides;
  cccClient?: ccc.Client;
  mirrorApiKey?: string;
}

const merge = (base: LeanOracleNetworkPreset, o?: LeanOraclePresetClientOverrides): LeanOracleNetworkPreset => ({
  ...base,
  ckbRpcUrl: o?.ckbRpcUrl ?? base.ckbRpcUrl,
  mirrorUrls: o?.mirrorUrls ?? base.mirrorUrls,
});

/** @public */
export class LeanOracleTestnetClient extends LeanOracleClient {
  constructor(options: LeanOraclePresetClientOptions = {}) {
    super({ network: merge(leanOracleTestnetPreset, options.overrides), cccClient: options.cccClient, mirrorApiKey: options.mirrorApiKey });
  }
}

/** @public */
export class LeanOracleMainnetClient extends LeanOracleClient {
  constructor(options: LeanOraclePresetClientOptions = {}) {
    super({ network: merge(leanOracleMainnetPreset, options.overrides), cccClient: options.cccClient, mirrorApiKey: options.mirrorApiKey });
  }
}
