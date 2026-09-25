#!/usr/bin/env node
//! lean-oracle-mirror run --config <mirror.json>

import { parseArgs } from "node:util";

import { loadMirrorConfig } from "./config.js";
import { startMirror } from "./mirror.js";

const log = (event: string, detail: Record<string, unknown> = {}) =>
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...detail })}\n`);

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({ args: rest, options: { config: { type: "string" } } });
  if (command !== "run" || !values.config) {
    process.stderr.write("usage: lean-oracle-mirror run --config <mirror.json>\n");
    process.exit(2);
  }
  const mirror = await startMirror(loadMirrorConfig(values.config), log);
  const shutdown = async () => {
    log("mirror.stopping");
    await mirror.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  log("mirror.fatal", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
