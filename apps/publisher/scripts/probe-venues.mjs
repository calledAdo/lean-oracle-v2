// Connect to every market in the committee templates for a few seconds and report what arrives.
//   node scripts/probe-venues.mjs [seconds]
// In Docker: docker run --rm -v $PWD/apps/publisher/scripts:/app/apps/publisher/scripts \
//   --entrypoint node lean-oracle-publisher:dev apps/publisher/scripts/probe-venues.mjs 20
import { readFileSync } from "node:fs";

import { MarketData } from "../dist/marketData.js";
import { exchangeLookup } from "../dist/net/resolver.js";
import { SourceManager } from "../dist/sources/manager.js";
import { marketsByVenue } from "../dist/sources/runner.js";

// Usage: probe-venues.mjs [seconds] [--doh]  (--doh resolves exchange hosts over DNS-over-HTTPS)
const seconds = Number(process.argv[2] ?? 20);
const doh = process.argv.includes("--doh");
const templates = ["majors", "ckb"].map((n) => JSON.parse(readFileSync(new URL(`../configs/${n}.template.json`, import.meta.url), "utf8")));
const byVenue = marketsByVenue(templates.flatMap((t) => t.feeds));
const counts = new Map();
const sink = {
  alive() {},
  quote(venue, market, q) {
    const c = counts.get(`${venue} ${market}`) ?? { quotes: 0, trades: 0 };
    c.quotes++; c.bid = q.bid; c.ask = q.ask;
    counts.set(`${venue} ${market}`, c);
  },
  trade(venue, market, t) {
    const c = counts.get(`${venue} ${market}`) ?? { quotes: 0, trades: 0 };
    c.trades++; c.last = t.price;
    counts.set(`${venue} ${market}`, c);
  },
};
const errors = [];
const manager = new SourceManager(sink, (event, d) => {
  if (event === "venue.error" || event === "venue.stalled" || event === "source.unsupported_venue") errors.push(`${d?.venue}: ${event} ${d?.error ?? ""}`);
}, doh ? exchangeLookup({ mode: "doh" }) : undefined);
manager.sync(templates);
await new Promise((r) => setTimeout(r, seconds * 1000));
manager.stop();
const fmt = (v) => (v === undefined ? "-" : (Number(v / 10n ** 10n) / 1e8).toString());
for (const [venue, markets] of byVenue) for (const m of markets) {
  const c = counts.get(`${venue} ${m}`);
  console.log(`${c?.quotes ? "OK  " : "NONE"} ${venue.padEnd(9)} ${m.padEnd(10)} quotes=${c?.quotes ?? 0} trades=${c?.trades ?? 0} bid=${fmt(c?.bid)} ask=${fmt(c?.ask)} last=${fmt(c?.last)}`);
}
if (errors.length) console.log("errors:", [...new Set(errors)].slice(0, 20));
process.exit(0);
