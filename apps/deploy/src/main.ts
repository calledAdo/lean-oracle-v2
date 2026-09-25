#!/usr/bin/env node
//! lean-oracle-deploy. Run through npm scripts (see README):
//!
//!   npm run deploy:code       -- --network testnet          (builds the contracts first; --skip-build to reuse)
//!   npm run deploy:committee  -- --network testnet --name majors
//!   npm run rotate:committee  -- --network testnet --name majors --next <set.hex> --authorization <sigs.json> --pop <sigs.json>
//!   npm run show              -- --network testnet
//!   npm run validate:config   -- deploy:committee --network testnet --name majors
//!   npm run sync:presets
//!
//! Every action is a dry run unless BROADCAST=true (or --broadcast). Network intent lives in
//! config/<network>.json; keys and RPC overrides in .env; results are appended to
//! deployments/<network>.json.

import { parseArgs } from "node:util";

import { deployCode, deployCommittee, rotate, show, syncPresets, validate } from "./actions.js";
import { loadContext, loadEnv } from "./context.js";

async function main(): Promise<void> {
  loadEnv();
  const [action, ...rest] = process.argv.slice(2);
  const { values: v, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      network: { type: "string", default: process.env.DEPLOY_NETWORK ?? "devnet" },
      name: { type: "string" },
      next: { type: "string" },
      authorization: { type: "string" },
      pop: { type: "string" },
      broadcast: { type: "boolean", default: false },
      "skip-build": { type: "boolean", default: false },
    },
  });
  const ctx = () => loadContext(v.network!, v.broadcast!);
  const need = (value: string | undefined, flag: string) => {
    if (!value) throw new Error(`${action} requires --${flag}`);
    return value;
  };
  switch (action) {
    case "deploy:code":
      return deployCode(ctx(), { build: !v["skip-build"] });
    case "deploy:committee":
      return deployCommittee(ctx(), need(v.name, "name"));
    case "rotate:committee":
      return rotate(ctx(), need(v.name, "name"), need(v.next, "next"), need(v.authorization, "authorization"), need(v.pop, "pop"));
    case "show":
      return show(ctx());
    case "validate:config":
      if (!(await validate(v.network!, positionals[0] ?? "", v.name, ctx))) process.exitCode = 1;
      return;
    case "sync:presets":
      return syncPresets();
    default:
      process.stderr.write("usage: lean-oracle-deploy <deploy:code|deploy:committee|rotate:committee|show|validate:config|sync:presets> [--network devnet|testnet|mainnet] [--broadcast]\n");
      process.exit(2);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
