#!/usr/bin/env node
//! lean-oracle-watchdog. Configuration (environment):
//!
//!   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   where alerts go (required)
//!   WATCH_MIRROR_URL                        e.g. https://mirror.example (public URL, so TLS is checked too)
//!   WATCH_PUBLISHERS                        name=url,... e.g. majors=http://majors:7701,ckb=http://ckb:7701
//!   WATCH_MAX_LAG_MS                        name=ms,...  (default 30000 per committee)
//!   WATCH_INTERVAL_MS                       default 30000
//!   WATCH_SUMMARY_HOUR_UTC                  daily summary hour, default 8
//!   WATCH_NAME                              label in messages, e.g. "testnet"

import { AlertState } from "./alerts.js";
import { checkMirror, checkPublisher, type CheckResult, type Target } from "./checks.js";
import { telegram } from "./telegram.js";

const log = (event: string, detail: Record<string, unknown> = {}) => process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...detail })}\n`);

function pairs(raw: string | undefined): [string, string][] {
  return (raw ?? "").split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf("=");
    if (i < 1) throw new Error(`expected name=value, got ${p}`);
    return [p.slice(0, i), p.slice(i + 1)];
  });
}

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) throw new Error("set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
  const name = process.env.WATCH_NAME ?? "lean-oracle";
  const lag = Object.fromEntries(pairs(process.env.WATCH_MAX_LAG_MS).map(([k, v]) => [k, Number(v)]));
  const publishers: Target[] = pairs(process.env.WATCH_PUBLISHERS).map(([n, url]) => ({ name: n, url: url.replace(/\/+$/, ""), maxLagMs: lag[n] ?? 30_000 }));
  const mirror = process.env.WATCH_MIRROR_URL?.replace(/\/+$/, "");
  const interval = Number(process.env.WATCH_INTERVAL_MS ?? 30_000);
  const summaryHour = Number(process.env.WATCH_SUMMARY_HOUR_UTC ?? 8);
  const bot = telegram(token, chat);
  const state = new AlertState();
  const send = (text: string) => bot.send(`[${name}] ${text}`).catch((error) => log("telegram.failed", { error: String(error) }));

  await send(`👀 watchdog started: ${publishers.map((p) => p.name).join(", ") || "no publishers"}${mirror ? `, mirror ${mirror}` : ""}`);
  let lastSummaryDay = new Date().getUTCDate();
  for (;;) {
    const now = Date.now();
    const results: CheckResult[] = await Promise.all(publishers.map((p) => checkPublisher(p, now)));
    let equivocations = -1;
    if (mirror) {
      const m = await checkMirror(mirror, lag, now);
      results.push(...m.results);
      equivocations = m.equivocations;
    }
    for (const message of state.update(results, equivocations, now)) await send(message);
    log("round", { failing: results.filter((r) => !r.ok).map((r) => r.key) });
    const date = new Date();
    if (date.getUTCHours() === summaryHour && date.getUTCDate() !== lastSummaryDay) {
      lastSummaryDay = date.getUTCDate();
      await send(state.summary());
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

main().catch((error) => {
  log("watchdog.fatal", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
