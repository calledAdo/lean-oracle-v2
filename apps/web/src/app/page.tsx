import { codeToHtml } from "shiki";
import { BadgeCheck, Box, Globe } from "lucide-react";
import { FEEDS } from "lean-oracle-sdk/presets";

import { Button } from "@/components/ui/button";
import { Mark, PriceFlow } from "@/components/ui/price-flow";
import { CodeTabs } from "@/components/site/code-tabs";
import { FeedsTable } from "@/components/site/feeds-table";
import { Ticker } from "@/components/site/ticker";

const GITHUB = "https://github.com/calledAdo/lean-oracle-v2";

const TS_EXAMPLE = `import { LeanOracleTestnetClient } from "lean-oracle-sdk/client";

const oracle = new LeanOracleTestnetClient();

// Checked against the live committee cell before it is returned.
const [btc] = await oracle.latestPrices(["Crypto.BTC/USDT"], "majors");

// Move your own feed cell to the newest signed price.
const { tx } = await oracle.pullAndUpdate(myFeedCell);`;

const RUST_EXAMPLE = `use lean_oracle_common::consumer::{check_feed_cell, price_at_expo, published_after};

// The feed cell is a cell dep of your transaction.
let feed = check_feed_cell(&data, &BTC_USDT, &MAJORS)?; // right feed, committee, signed
published_after(&feed, locked_at_ms)?;                  // newer than your own cell
let cents = price_at_expo(&feed, -2).ok_or(ERR_SCALE)?; // BTC/USDT in cents`;

const FEATURES = [
  {
    icon: BadgeCheck,
    title: "Checked by the chain",
    body: "The feed cell's script verifies the committee's signatures and Merkle proof. An unsigned or altered price can't get in.",
  },
  {
    icon: Box,
    title: "Your own feed cell",
    body: "Create a cell for the pairs you need and update it when you need to. It only moves forward in time, so old prices can't be replayed.",
  },
  {
    icon: Globe,
    title: "Mirrors can't forge prices",
    body: "Signed updates are served by public mirrors, and anyone can run one. A mirror can go down, but it can't change a price.",
  },
];

const EXCHANGES = 10;

const STATS = [
  { value: String(FEEDS.length), label: "price feeds" },
  { value: String(EXCHANGES), label: "exchanges" },
  { value: "1 s", label: "between signed prices" },
  { value: "38k", label: "cycles to read a price on-chain" },
];

function Section({ title, lead, children, id }: { title: string; lead: string; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-8 sm:py-24">
      <h2 className="text-[clamp(1.7rem,3.2vw,2.4rem)] leading-tight font-semibold tracking-[-0.025em]">{title}</h2>
      <p className="mt-3 max-w-[58ch] text-muted-foreground text-pretty">{lead}</p>
      <div className="mt-10">{children}</div>
    </section>
  );
}

export default async function Home() {
  const highlight = (code: string, lang: string) => codeToHtml(code, { lang, theme: "vitesse-dark" });
  const tabs = [
    { label: "TypeScript", file: "app.ts", html: await highlight(TS_EXAMPLE, "ts") },
    { label: "Rust (on-chain)", file: "lock.rs", html: await highlight(RUST_EXAMPLE, "rust") },
  ];

  return (
    <div className="flex min-h-svh flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5 sm:px-8">
        <a href="/" className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
          <Mark className="size-7 text-foreground" />
          Lean Oracle
        </a>
        <nav className="flex items-center gap-6 text-sm text-muted-foreground">
          <a href="#feeds" className="hidden hover:text-foreground sm:inline">Feeds</a>
          <a href="/docs" className="hover:text-foreground">Docs</a>
          <a href={GITHUB} className="hidden hover:text-foreground sm:inline">GitHub</a>
        </nav>
      </header>

      <main className="flex flex-1 flex-col">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center px-4 pt-6 pb-16 text-center sm:px-8 sm:pt-10">
          <h1 className="max-w-[20ch] text-[clamp(2.3rem,5.2vw,3.9rem)] leading-[1.02] font-semibold tracking-[-0.035em] text-balance">
            The price oracle for CKB.
          </h1>
          <p className="mt-5 max-w-[48ch] text-lg text-muted-foreground text-balance">
            Live exchange prices, signed every second and checked on-chain.
          </p>
          <div className="mt-8 flex gap-3">
            <Button size="lg" className="h-11 rounded-full px-6 text-base" nativeButton={false} render={<a href="/docs" />}>
              Get started
            </Button>
            <Button size="lg" variant="outline" className="h-11 rounded-full px-6 text-base" nativeButton={false} render={<a href={GITHUB} />}>
              View on GitHub
            </Button>
          </div>
          <div className="mt-10 w-full max-w-3xl sm:mt-12">
            <PriceFlow />
          </div>
        </div>

        <Ticker />

        <div className="mx-auto grid w-full max-w-6xl grid-cols-2 gap-y-10 px-4 py-16 sm:px-8 md:grid-cols-4">
          {STATS.map((s) => (
            <div key={s.label}>
              <div className="text-[clamp(2rem,4vw,3rem)] leading-none font-semibold tracking-[-0.03em] tabular-nums">{s.value}</div>
              <div className="mt-2 text-sm text-muted-foreground">{s.label}</div>
            </div>
          ))}
        </div>

        <Section title="How it works" lead="Lean Oracle is a pull oracle: instead of someone posting prices on-chain for you, your transaction carries the signed price and the chain checks it.">
          <div className="grid gap-x-10 gap-y-10 md:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <div key={title}>
                <Icon className="size-6 text-[var(--signal)]" strokeWidth={1.75} />
                <h3 className="mt-4 text-lg font-semibold tracking-tight">{title}</h3>
                <p className="mt-2 text-muted-foreground text-pretty">{body}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Integrate in a few lines" lead="Read prices in your app with the SDK, and check them inside your own CKB script with the common crate.">
          <div className="grid items-start gap-10 lg:grid-cols-[1fr_1.35fr]">
            <ol className="space-y-6">
              {[
                ["Install the SDK", "npm install lean-oracle-sdk"],
                ["Create your feed cell", "One transaction, for the pair you need."],
                ["Pull and update", "Carry the latest signed price into your cell whenever you need it."],
                ["Read it in your script", "Add the feed cell as a cell dep and check it with lean-oracle-common."],
              ].map(([title, body], i) => (
                <li key={title} className="flex gap-4">
                  <span className="mt-0.5 flex size-7 flex-none items-center justify-center rounded-full border border-border font-mono text-xs text-[var(--signal)]">{i + 1}</span>
                  <div>
                    <div className="font-medium">{title}</div>
                    <div className={`mt-1 text-sm text-muted-foreground ${i === 0 ? "font-mono" : ""}`}>{body}</div>
                  </div>
                </li>
              ))}
            </ol>
            <CodeTabs tabs={tabs} />
          </div>
        </Section>

        <Section id="feeds" title="Live feeds" lead="Every feed is a native market pair, priced only from exchanges that trade it. These values update as the committees sign them.">
          <FeedsTable />
        </Section>

        <section className="mx-auto w-full max-w-6xl px-4 pb-24 sm:px-8">
          <div className="flex flex-col items-start justify-between gap-6 rounded-2xl border border-border bg-card px-8 py-10 sm:flex-row sm:items-center">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">Start building on CKB testnet</h2>
              <p className="mt-2 text-muted-foreground">Contracts, committees and a public mirror are live today.</p>
            </div>
            <div className="flex gap-3">
              <Button size="lg" className="h-11 rounded-full px-6 text-base" nativeButton={false} render={<a href="/docs" />}>Read the docs</Button>
              <Button size="lg" variant="outline" className="h-11 rounded-full px-6 text-base" nativeButton={false} render={<a href="https://www.npmjs.com/package/lean-oracle-sdk" />}>View on npm</Button>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-10 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <div className="flex items-center gap-2 text-foreground">
            <Mark className="size-5" />
            Lean Oracle
          </div>
          <nav className="flex flex-wrap gap-x-6 gap-y-2">
            <a href="/docs" className="hover:text-foreground">Docs</a>
            <a href={GITHUB} className="hover:text-foreground">GitHub</a>
            <a href="https://www.npmjs.com/package/lean-oracle-sdk" className="hover:text-foreground">npm</a>
            <a href="https://64-227-40-35.sslip.io/health" className="hover:text-foreground">Mirror status</a>
          </nav>
          <div>MIT licensed. Running on CKB testnet.</div>
        </div>
      </footer>
    </div>
  );
}
