import { bytesToHex, concatBytes, hexToFixed } from "../internal/bytes.js";
import type { LeanOracleDeployment } from "../presets/deployment.js";
import type { Hex, Script } from "../types.js";

/** Committee cell type script: `args = type_id` (32 bytes). */
export function publisherSetTypeScript(deployment: LeanOracleDeployment, typeId: Hex): Script {
  const { codeHash, hashType } = deployment.contracts.publisherSetType;
  return { codeHash, hashType, args: bytesToHex(hexToFixed(typeId, 32, "typeId")) };
}

/** Feed cell type script: `args = feed_id || type_id` (64 bytes). */
export function priceFeedTypeScript(deployment: LeanOracleDeployment, feedId: Hex, typeId: Hex): Script {
  const { codeHash, hashType } = deployment.contracts.priceFeedType;
  return { codeHash, hashType, args: bytesToHex(concatBytes(hexToFixed(feedId, 32, "feedId"), hexToFixed(typeId, 32, "typeId"))) };
}
