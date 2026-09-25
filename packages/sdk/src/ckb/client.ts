//! CCC client/signer wiring for the SDK. Intentionally self-contained — the SDK
//! replicates this rather than importing it from any other module (see the
//! project decoupling rule). Devnet (offckb) needs a local secp `KnownScript`
//! override, supplied by the caller.

import { ccc } from "@ckb-ccc/core";
import { cccA } from "@ckb-ccc/core/advanced";

import type { Hex } from "../types.js";

export type Network = "testnet" | "mainnet" | "devnet";

export interface DevnetSecpOverride {
  codeHash: Hex;
  hashType: "type" | "data" | "data1" | "data2";
  depTxHash: Hex;
  depIndex: number;
  depType: "code" | "depGroup";
}

class ClientDevnet extends ccc.ClientJsonRpc {
  constructor(
    url: string,
    private readonly scripts_: Record<ccc.KnownScript, unknown>,
  ) {
    super(url);
  }
  get addressPrefix(): string {
    return "ckt";
  }
  async getKnownScript(script: ccc.KnownScript) {
    const found = this.scripts_[script];
    if (!found) throw new Error(`No script information for ${script} on devnet`);
    return ccc.ScriptInfo.from(found as never);
  }
}

export function createClient(
  network: Network,
  rpcUrl: string,
  devnetSecp?: DevnetSecpOverride,
): ccc.Client {
  if (network === "mainnet") return new ccc.ClientPublicMainnet({ url: rpcUrl });
  if (network === "devnet") {
    if (!devnetSecp) {
      throw new Error("devnet client requires a secp256k1_blake160 KnownScript override");
    }
    const overrides = {
      [ccc.KnownScript.Secp256k1Blake160]: {
        codeHash: devnetSecp.codeHash,
        hashType: devnetSecp.hashType,
        cellDeps: [
          {
            cellDep: {
              outPoint: { txHash: devnetSecp.depTxHash, index: devnetSecp.depIndex },
              depType: devnetSecp.depType,
            },
          },
        ],
      },
    };
    const scripts = { ...(cccA.TESTNET_SCRIPTS as Record<ccc.KnownScript, unknown>), ...overrides };
    return new ClientDevnet(rpcUrl, scripts as Record<ccc.KnownScript, unknown>);
  }
  return new ccc.ClientPublicTestnet({ url: rpcUrl });
}

export function createPrivateKeySigner(client: ccc.Client, privateKey: Hex): ccc.SignerCkbPrivateKey {
  return new ccc.SignerCkbPrivateKey(client, privateKey);
}
