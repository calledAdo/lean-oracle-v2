import Link from "next/link";
import { FEEDS } from "lean-oracle-sdk/presets";

import { Button } from "@/components/ui/button";
import { Mark } from "@/components/ui/brand";
import { Convergence } from "@/components/ui/convergence";
import { Ticker } from "@/components/site/ticker";

const GITHUB = "https://github.com/calledAdo/lean-oracle-v2";
const NPM = "https://www.npmjs.com/package/lean-oracle-sdk";

const STATS = [
  { value: String(FEEDS.length), label: "Price feeds" },
  { value: "10", label: "Exchange sources" },
  { value: "1 s", label: "Update frequency" },
  { value: "38k", label: "Cycles per on-chain read" },
];

const PILLARS = [
  {
    title: "Low latency",
    body: "A fresh price every second, pulled into a transaction only when an application needs it.",
  },
  {
    title: "Verifiable by design",
    body: "Every update carries the publisher committee's signatures, checked on-chain before any contract can use it.",
  },
  {
    title: "Efficient to consume",
    body: "Reading a verified price costs a contract about 38,000 cycles, so it fits inside everyday transactions.",
  },
];

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 font-mono text-xs tracking-[0.14em] text-muted-foreground uppercase">
      <span className="size-2 bg-[var(--signal)]" />
      {children}
    </div>
  );
}

export default function Home() {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-4 sm:px-8">
          <Link href="/" className="flex items-center gap-2.5">
            <Mark className="size-7 text-foreground" />
            <span className="font-[family-name:var(--font-heading)] text-lg font-medium tracking-tight">Lean Oracle</span>
          </Link>
          <nav className="flex items-center gap-7 text-sm text-muted-foreground">
            <Link href="/docs" className="hidden hover:text-foreground md:inline">Docs</Link>
            <a href={GITHUB} className="hidden hover:text-foreground md:inline">GitHub</a>
            <Button className="h-9 rounded-full px-4" nativeButton={false} render={<Link href="/docs" />}>Get started</Button>
          </nav>
        </div>
      </header>

      <main className="flex flex-1 flex-col">
        <section className="mx-auto grid w-full max-w-7xl items-center gap-12 px-4 pt-14 pb-16 sm:px-8 lg:grid-cols-[1fr_1.05fr] lg:pt-20">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3.5 py-1.5 text-sm text-muted-foreground">
              <span className="relative flex size-2">
                <span className="absolute inset-0 animate-ping rounded-full bg-[var(--proof)] opacity-60 motion-reduce:animate-none" />
                <span className="relative size-2 rounded-full bg-[var(--proof)]" />
              </span>
              Live on CKB testnet
            </div>
            <h1 className="mt-7 max-w-[15ch] text-[clamp(2.6rem,5.4vw,4.4rem)] leading-[1.03] font-medium tracking-[-0.03em] text-balance">
              Real-time market data for on‑chain finance.
            </h1>
            <p className="mt-6 max-w-[46ch] text-lg text-muted-foreground text-pretty">
              Aggregated prices from leading exchanges, delivered to CKB applications every second and verifiable by the contracts that use them.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Button size="lg" className="h-11 rounded-full px-6 text-base" nativeButton={false} render={<Link href="/docs" />}>Get started</Button>
              <Button size="lg" variant="outline" className="h-11 rounded-full px-6 text-base" nativeButton={false} render={<a href={GITHUB} />}>View on GitHub</Button>
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

        <section className="border-t border-border">
          <div className="mx-auto w-full max-w-7xl px-4 py-24 sm:px-8">
            <Label>Why Lean Oracle</Label>
            <h2 className="mt-5 max-w-[20ch] text-[clamp(2rem,3.8vw,3rem)] leading-[1.08] font-medium tracking-[-0.025em] text-balance">
              Market data your applications can rely on.
            </h2>
            <div className="mt-14 grid gap-12 md:grid-cols-3 md:gap-10">
              {PILLARS.map((p) => (
                <div key={p.title} className="border-t border-border pt-6">
                  <h3 className="text-xl font-medium tracking-[-0.01em]">{p.title}</h3>
                  <p className="mt-3 text-muted-foreground text-pretty">{p.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto w-full max-w-7xl px-4 pb-24 sm:px-8">
          <div className="flex flex-col items-start justify-between gap-8 rounded-3xl border border-border bg-card px-8 py-12 sm:px-12 lg:flex-row lg:items-center">
            <div>
              <h2 className="text-[clamp(1.6rem,3vw,2.3rem)] font-medium tracking-[-0.02em]">Start building with Lean Oracle</h2>
              <p className="mt-3 text-muted-foreground">Live on CKB testnet, with a public mirror and an SDK on npm.</p>
            </div>
            <div className="flex gap-3">
              <Button size="lg" className="h-11 rounded-full px-6 text-base" nativeButton={false} render={<Link href="/docs" />}>Read the docs</Button>
              <Button size="lg" variant="outline" className="h-11 rounded-full px-6 text-base" nativeButton={false} render={<a href={NPM} />}>View on npm</Button>
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
            <Link href="/docs" className="hover:text-foreground">Docs</Link>
            <a href={GITHUB} className="hover:text-foreground">GitHub</a>
            <a href={NPM} className="hover:text-foreground">npm</a>
            <a href="https://64-227-40-35.sslip.io/health" className="hover:text-foreground">Status</a>
          </nav>
          <div>MIT licensed</div>
        </div>
      </footer>
    </div>
  );
}
