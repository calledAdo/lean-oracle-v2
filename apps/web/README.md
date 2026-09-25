# lean-oracle-web

The Lean Oracle website: landing page (and, next, the documentation). Next.js with Tailwind and
shadcn/ui, exported as a static site (`out/`).

```bash
npm run dev -w lean-oracle-web
```

```bash
npm run build -w lean-oracle-web
```

The hero (`src/components/ui/price-flow.tsx`) animates prices flowing from exchanges into Lean
Oracle and on to CKB, and shows the latest signed BTC/USDT price from the public testnet mirror.
