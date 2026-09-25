import { codeToHtml } from "shiki";
import { Check } from "lucide-react";
import { FEEDS } from "lean-oracle-sdk/presets";

import { Button } from "@/components/ui/button";
import { Mark } from "@/components/ui/brand";
import { Convergence } from "@/components/ui/convergence";
import { FeedCatalog } from "@/components/site/feed-catalog";
import { Ticker } from "@/components/site/ticker";

const GITHUB = "https://github.com/calledAdo/lean-oracle-v2";
const NPM = "https://www.npmjs.com/package/lean-oracle-sdk";

const TS_EXAMPLE = `import { LeanOracleTestnetClient } from "lean-oracle-sdk/client";

const oracle = new LeanOracleTestnetClient();

// Checked against the live committee cell before it is returned.
const [btc] = await oracle.latestPrices(["Crypto.BTC/USDT"], "majors");

// Move your own feed cell to the newest signed price.
const { tx } = await oracle.pullAndUpdate(myFeedCell);`;

const RUST_EXAMPLE = `use lean_oracle_common::consumer::{check_feed_cell, price_at_expo, published_after};

// The feed cell is a cell dep of your transaction.
let feed = check_feed_cell(&data, &BTC_USDT, &MAJORS)?;
published_after(&feed, locked_at_ms)?;
let cents = price_at_expo(&feed, -2).ok_or(ERR_SCALE)?;`;

const STATS = [
  { value: String(FEEDS.length), label: "Price feeds" },
  { value: "10", label: "Exchanges" },
  { value: "1 s", label: "Between signed prices" },
  { value: "38k", label: "Cycles to read a price on-chain" },
];

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 font-mono text-xs tracking-[0.14em] text-muted-foreground uppercase">
      <span className="size-2 bg-[var(--signal)]" />
      {children}
    </div>
  );
}

function CodePanel({ file, html }: { file: string; html: string }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="border-b border-border px-5 py-3 font-mono text-xs text-muted-foreground">{file}</div>
      <div className="overflow-x-auto p-5 text-[13px] leading-relaxed [&_pre]:!bg-transparent [&_code]:font-mono" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function Feature({ title, body, points, link, code, flip }: { title: string; body: string; points: string[]; link: { href: string; label: string }; code: React.ReactNode; flip?: boolean }) {
  return (
    <div className="grid items-center gap-10 border-t border-border py-14 lg:grid-cols-2 lg:gap-16">
      <div className={flip ? "lg:order-2" : ""}>
        <h3 className="text-3xl font-medium tracking-[-0.02em]">{title}</h3>
        <p className="mt-4 max-w-[46ch] text-muted-foreground">{body}</p>
        <ul className="mt-6 space-y-3">
          {points.map((p) => (
            <li key={p} className="flex gap-3 text-sm">
              <Check className="mt-0.5 size-4 flex-none text-[var(--proof)]" />
              <span>{p}</span>
            </li>
          ))}
        </ul>
        <a href={link.href} className="mt-7 inline-block text-sm font-medium text-[var(--signal)] hover:underline">{link.label}</a>
      </div>
      <div className={flip ? "lg:order-1" : ""}>{code}</div>
    </div>
  );
}

export default async function Home() {
  const highlight = (code: string, lang: string) => codeToHtml(code, { lang, theme: "vitesse-dark" });
  const [ts, rust] = await Promise.all([highlight(TS_EXAMPLE, "ts"), highlight(RUST_EXAMPLE, "rust")]);

  return (
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-4 sm:px-8">
          <a href="/" className="flex items-center gap-2.5">
            <Mark className="size-7 text-foreground" />
            <span className="font-[family-name:var(--font-heading)] text-lg font-medium tracking-tight">Lean Oracle</span>
          </a>
          <nav className="flex items-center gap-7 text-sm text-muted-foreground">
            <a href="#feeds" className="hidden hover:text-foreground md:inline">Feeds</a>
            <a href="#build" className="hidden hover:text-foreground md:inline">Developers</a>
            <a href={GITHUB} className="hidden hover:text-foreground md:inline">GitHub</a>
            <Button className="h-9 rounded-full px-4" nativeButton={false} render={<a href="/docs" />}>Get started</Button>
          </nav>
        </div>
      </header>

      <main className="flex flex-1 flex-col">
        <section className="mx-auto grid w-full max-w-7xl items-center gap-12 px-4 pt-14 pb-16 sm:px-8 lg:grid-cols-[1fr_1.05fr] lg:pt-20">
          <div>
            <a href="#feeds" className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3.5 py-1.5 text-sm text-muted-foreground hover:text-foreground">
              <span className="relative flex size-2">
                <span className="absolute inset-0 animate-ping rounded-full bg-[var(--proof)] opacity-60 motion-reduce:animate-none" />
                <span className="relative size-2 rounded-full bg-[var(--proof)]" />
              </span>
              Live on CKB testnet
            </a>
            <h1 className="mt-7 max-w-[16ch] text-[clamp(2.6rem,5.6vw,4.6rem)] leading-[1.02] font-medium tracking-[-0.03em] text-balance">
              Signed market prices, every second.
            </h1>
            <p className="mt-6 max-w-[44ch] text-lg text-muted-foreground">
              Live prices from ten exchanges, signed by a committee of publishers and verified inside your contract.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Button size="lg" className="h-11 rounded-full px-6 text-base" nativeButton={false} render={<a href="/docs" />}>Get started</Button>
              <Button size="lg" variant="outline" className="h-11 rounded-full px-6 text-base" nativeButton={false} render={<a href="#feeds" />}>Explore feeds</Button>
            </div>
          </div>
          <Convergence />
        </section>

        <Ticker />

        <section className="mx-auto grid w-full max-w-7xl grid-cols-2 px-4 sm:px-8 md:grid-cols-4">
          {STATS.map((s, i) => (
            <div key={s.label} className={`py-12 ${i > 0 ? "md:border-l md:border-border md:pl-8" : ""} ${i % 2 === 1 ? "border-l border-border pl-6 md:pl-8" : ""}`}>
              <div className="font-[family-name:var(--font-heading)] text-[clamp(2.2rem,4.4vw,3.4rem)] leading-none font-medium tracking-[-0.03em] tabular-nums">{s.value}</div>
              <div className="mt-3 text-sm text-muted-foreground">{s.label}</div>
            </div>
          ))}
        </section>

        <section id="build" className="mx-auto w-full max-w-7xl px-4 pt-20 sm:px-8">
          <Label>Build with Lean Oracle</Label>
          <h2 className="mt-5 max-w-[22ch] text-[clamp(2rem,3.8vw,3rem)] leading-[1.08] font-medium tracking-[-0.025em]">
            Read a price in your app. Check it in your contract.
          </h2>
          <div className="mt-12">
            <Feature
              title="For your app"
              body="The SDK reads prices from public mirrors and verifies every one against the live committee cell before handing it to you."
              points={["TypeScript, runs in Node and the browser", "Verification against the committee cell built in", "Builds the transaction that updates your feed cell"]}
              link={{ href: NPM, label: "lean-oracle-sdk on npm" }}
              code={<CodePanel file="app.ts" html={ts} />}
            />
            <Feature
              flip
              title="For your contract"
              body="Your script reads your feed cell as a cell dep. The feed cell only accepts prices the committee signed, and only ever moves forward in time."
              points={["Pin your own feed cell by type hash", "Prove freshness against your cell's own block", "About 38,000 cycles to read and check a price"]}
              link={{ href: `${GITHUB}/tree/main/examples/price_trigger_lock`, label: "See the example contract" }}
              code={<CodePanel file="lock.rs" html={rust} />}
            />
          </div>
        </section>

        <section id="feeds" className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-8">
          <Label>Feeds</Label>
          <h2 className="mt-5 max-w-[24ch] text-[clamp(2rem,3.8vw,3rem)] leading-[1.08] font-medium tracking-[-0.025em]">
            Native pairs, priced only where they trade.
          </h2>
          <p className="mt-4 max-w-[58ch] text-muted-foreground">
            Each price is the median across the exchanges below, and is signed only when enough of them report.
          </p>
          <div className="mt-10">
            <FeedCatalog />
          </div>
        </section>

        <section className="mx-auto w-full max-w-7xl px-4 pb-24 sm:px-8">
          <div className="flex flex-col items-start justify-between gap-8 rounded-3xl border border-border bg-card px-8 py-12 sm:px-12 lg:flex-row lg:items-center">
            <div>
              <h2 className="text-[clamp(1.6rem,3vw,2.3rem)] font-medium tracking-[-0.02em]">Start building on CKB testnet</h2>
              <p className="mt-3 text-muted-foreground">Contracts, committees and a public mirror are live today.</p>
            </div>
            <div className="flex gap-3">
              <Button size="lg" className="h-11 rounded-full px-6 text-base" nativeButton={false} render={<a href="/docs" />}>Read the docs</Button>
              <Button size="lg" variant="outline" className="h-11 rounded-full px-6 text-base" nativeButton={false} render={<a href={GITHUB} />}>View on GitHub</Button>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-10 text-sm text-muted-foreground sm:px-8 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-2.5 text-foreground">
            <Mark className="size-5" />
            <span className="font-[family-name:var(--font-heading)] font-medium">Lean Oracle</span>
          </div>
          <nav className="flex flex-wrap gap-x-6 gap-y-2">
            <a href="/docs" className="hover:text-foreground">Docs</a>
            <a href={GITHUB} className="hover:text-foreground">GitHub</a>
            <a href={NPM} className="hover:text-foreground">npm</a>
            <a href="https://64-227-40-35.sslip.io/health" className="hover:text-foreground">Mirror status</a>
          </nav>
          <div>MIT licensed</div>
        </div>
      </footer>
    </div>
  );
}
