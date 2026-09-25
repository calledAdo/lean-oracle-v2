// Every feed with the exchanges it is priced from and how often it is signed, read at build time
// from the publisher committee configs (apps/publisher/configs), so it always matches production.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const VENUE_NAMES: Record<string, string> = {
  binance: "Binance", coinbase: "Coinbase", kraken: "Kraken", bitstamp: "Bitstamp", okx: "OKX",
  bybit: "Bybit", gate: "Gate", bitget: "Bitget", kucoin: "KuCoin", mexc: "MEXC",
};

interface Template {
  tickPeriodMs: number;
  feeds: { symbol: string; minVenues: number; markets: { venue: string }[] }[];
}

function committee(name: string): Template {
  return JSON.parse(readFileSync(join(process.cwd(), "../publisher/configs", `${name}.template.json`), "utf8")) as Template;
}

export function FeedCatalog() {
  const rows = (["majors", "ckb"] as const).flatMap((name) => {
    const t = committee(name);
    return t.feeds.map((f) => ({
      pair: f.symbol.replace(/^Crypto\./, ""),
      every: t.tickPeriodMs === 1000 ? "Every second" : `Every ${t.tickPeriodMs / 1000} seconds`,
      sources: f.markets.map((m) => VENUE_NAMES[m.venue] ?? m.venue),
      minVenues: f.minVenues,
    }));
  });
  return (
    <div className="rounded-xl border border-border">
      <table className="w-full table-fixed text-left text-sm">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            <th className="w-[28%] px-4 py-3 font-medium sm:w-[18%] sm:px-5">Pair</th>
            <th className="px-4 py-3 font-medium sm:px-5">Priced from</th>
            <th className="w-[22%] px-4 py-3 font-medium sm:w-[16%] sm:px-5">Signed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.pair} className="border-b border-border align-top last:border-0">
              <td className="px-4 py-3.5 font-medium sm:px-5">{r.pair}</td>
              <td className="px-4 py-3.5 sm:px-5">
                <div className="flex flex-wrap gap-1.5">
                  {r.sources.map((s) => (
                    <span key={s} className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">{s}</span>
                  ))}
                </div>
                <div className="mt-1.5 text-xs text-muted-foreground">Signed when at least {r.minVenues} of {r.sources.length} report a price.</div>
              </td>
              <td className="px-4 py-3.5 text-muted-foreground sm:px-5">{r.every}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
