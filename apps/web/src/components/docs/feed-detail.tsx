"use client";

import { useEffect, useState } from "react";
import { feedBySymbol } from "lean-oracle-sdk/presets";
import { DynamicCodeBlock } from "fumadocs-ui/components/dynamic-codeblock";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import data from "@/data/committees.json";
import { MIRROR, decimalsFor, formatPrice } from "@/lib/prices";
import { CopyValue } from "./copy";

interface Live {
  price: number;
  conf: number;
  ema: number;
  publishTimeMs: number;
  sourceTimeMs: number;
  numPublishers: number;
}

function useFeed(symbol: string) {
  const [live, setLive] = useState<Live>();
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const r = await (await fetch(`${MIRROR}/v1/updates/latest?ids=${encodeURIComponent(symbol)}`)).json();
        const u = r.updates?.[0];
        const p = u?.prices?.[0];
        if (!p || stop) return;
        const s = 10 ** p.expo;
        setLive({
          price: Number(p.price) * s,
          conf: Number(p.conf) * s,
          ema: Number(p.emaPrice) * s,
          publishTimeMs: Number(u.publishTimeMs),
          sourceTimeMs: Number(p.sourceTimeMs),
          numPublishers: p.numPublishers,
        });
      } catch {
        /* keep the last value */
      }
    };
    poll();
    const t = setInterval(poll, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [symbol]);
  return live;
}

const Row = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <tr className="border-t border-border">
    <td className="w-[42%] px-4 py-2.5 text-muted-foreground">{k}</td>
    <td className="px-4 py-2.5">{children}</td>
  </tr>
);

const bps = (v: number) => `${(v / 100).toFixed(v % 100 ? 2 : 0)}%`;
const secs = (ms: number) => (ms >= 60000 ? `${ms / 60000} min` : `${ms / 1000} s`);

/** Everything about one feed: live value, identifiers, methodology and markets, plus ready-to-use code. */
export function FeedDetail({ symbol }: { symbol: string }) {
  const f = data.feeds.find((x) => x.symbol === symbol);
  const reg = feedBySymbol(symbol);
  const live = useFeed(symbol);
  if (!f || !reg) return null;
  const c = data.committees[f.committee as keyof typeof data.committees];
  const d = live ? decimalsFor(live.price) : 2;

  return (
    <div className="not-prose my-6 space-y-6">
      <div className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4">
        {[
          ["Price (testnet)", live ? formatPrice(live.price, d) : "–"],
          ["Confidence", live ? `± ${formatPrice(live.conf, d)}` : "–"],
          ["1-hour EMA", live ? formatPrice(live.ema, d) : "–"],
          ["Signed at (UTC)", live ? new Date(live.publishTimeMs).toISOString().slice(11, 19) : "–"],
        ].map(([k, v]) => (
          <div key={k} className="bg-card px-4 py-3">
            <div className="text-xs text-muted-foreground">{k}</div>
            <div className="mt-1 font-mono text-[15px] tabular-nums">{v}</div>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        <div className="bg-card px-4 py-2.5 text-[13px] font-medium">Identifiers</div>
        <table className="w-full text-sm">
          <tbody>
            <Row k="Symbol"><span className="font-mono text-[13px]">{f.symbol}</span></Row>
            <Row k="Feed ID"><CopyValue value={reg.feedId} /></Row>
            <Row k="Exponent"><span className="font-mono text-[13px]">{f.expo}</span> <span className="text-muted-foreground">(value = price × 10^{f.expo})</span></Row>
            <Row k="Committee"><a className="underline underline-offset-4" href="/docs/feeds/committees">{f.committee}</a></Row>
            <Row k="Committee type hash (testnet)"><CopyValue value={c.typeHash} /></Row>
            <Row k="Update frequency">Every {secs(f.tickPeriodMs)}</Row>
            <Row k="Market hours">24/7</Row>
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        <div className="bg-card px-4 py-2.5 text-[13px] font-medium">Methodology</div>
        <table className="w-full text-sm">
          <tbody>
            <Row k="Exchange price">{f.method === "mid" ? `Median mid price over ${secs(f.windowMs)}, sampled every 100 ms` : `Trade VWAP over ${secs(f.windowMs)}, mid price if there were no trades`}</Row>
            <Row k="Exchanges required">{f.minVenues} of {f.markets.length}</Row>
            <Row k="Exchange must be live within">{secs(f.maxQuoteAgeMs)}</Row>
            <Row k="Maximum spread">{bps(f.maxSpreadBps)}</Row>
            <Row k="Minimum size at top of book">{f.minTopNotional} {f.quote} each side</Row>
            <Row k="Outlier cut-off">{bps(f.maxDeviationBps)} from the median</Row>
            <Row k="Publisher agreement tolerance">{bps(f.toleranceBps)}</Row>
            <Row k="EMA half-life">{secs(f.emaHalfLifeMs)}</Row>
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        <div className="bg-card px-4 py-2.5 text-[13px] font-medium">Markets</div>
        <table className="w-full text-sm">
          <tbody>
            {f.markets.map((m) => (
              <Row key={m.venue} k={m.venue}><span className="font-mono text-[13px]">{m.market}</span></Row>
            ))}
          </tbody>
        </table>
      </div>

      <Tabs items={["TypeScript", "Rust"]}>
        <Tab value="TypeScript">
          <DynamicCodeBlock
            lang="ts"
            code={`import { LeanOracleTestnetClient } from "lean-oracle-sdk/client";

const oracle = new LeanOracleTestnetClient();
const [p] = await oracle.latestPrices(["${f.symbol}"], "${f.committee}");
const value = Number(p.price) * 10 ** p.expo; // ${f.pair}`}
          />
        </Tab>
        <Tab value="Rust">
          <DynamicCodeBlock
            lang="rust"
            code={`// ${f.pair}
const FEED_ID: [u8; 32] = hex!("${reg.feedId.slice(2)}");
// ${f.committee} committee (testnet)
const COMMITTEE: [u8; 32] = hex!("${c.typeHash.slice(2)}");

let feed = check_feed_cell(&data, &FEED_ID, &COMMITTEE)?;`}
          />
        </Tab>
      </Tabs>
    </div>
  );
}
