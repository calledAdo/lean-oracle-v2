import { Button } from "@/components/ui/button";
import { Mark, PriceFlow } from "@/components/ui/price-flow";

export default function Home() {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5 sm:px-8">
        <a href="/" className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
          <Mark className="size-6 text-foreground" />
          Lean Oracle
        </a>
        <nav className="flex items-center gap-6 text-sm text-muted-foreground">
          <a href="/docs" className="hover:text-foreground">Docs</a>
          <a href="https://github.com/calledAdo/lean-oracle-v2" className="hidden hover:text-foreground sm:inline">GitHub</a>
        </nav>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center px-4 pt-6 pb-16 text-center sm:px-8 sm:pt-10">
        <h1 className="max-w-[20ch] text-[clamp(2.3rem,5.2vw,3.9rem)] leading-[1.02] font-semibold tracking-[-0.035em] text-balance">
          Exchange prices, signed for your CKB contract.
        </h1>
        <p className="mt-5 max-w-[48ch] text-lg text-muted-foreground text-pretty">
          A committee signs a price every second. Your contract checks the signatures itself.
        </p>
        <div className="mt-8 flex gap-3">
          <Button size="lg" className="h-11 rounded-full px-6 text-base" nativeButton={false} render={<a href="/docs" />}>
            Get started
          </Button>
          <Button size="lg" variant="outline" className="h-11 rounded-full px-6 text-base" nativeButton={false} render={<a href="https://github.com/calledAdo/lean-oracle-v2" />}>
            View on GitHub
          </Button>
        </div>

        <div className="mt-10 w-full max-w-3xl sm:mt-12">
          <PriceFlow />
        </div>
      </main>
    </div>
  );
}
