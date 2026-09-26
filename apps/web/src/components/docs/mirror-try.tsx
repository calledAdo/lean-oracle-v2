"use client";

import { useState } from "react";
import { MIRROR } from "@/lib/prices";

type Endpoint = "latest" | "at" | "feeds" | "health";

const shorten = (_: string, value: unknown) =>
  typeof value === "string" && value.startsWith("0x") && value.length > 140 ? `${value.slice(0, 66)}… (${(value.length - 2) / 2} bytes)` : value;

/** Send a real request to the public testnet mirror and show the response. */
export function MirrorTry() {
  const [endpoint, setEndpoint] = useState<Endpoint>("latest");
  const [ids, setIds] = useState("Crypto.BTC/USDT");
  const [t, setT] = useState(() => String(Math.floor(Date.now() / 1000 - 60) * 1000));
  const [result, setResult] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const url =
    endpoint === "latest" ? `${MIRROR}/v1/updates/latest?ids=${ids}`
    : endpoint === "at" ? `${MIRROR}/v1/updates/at?t=${t}&ids=${ids}`
    : endpoint === "feeds" ? `${MIRROR}/v1/feeds`
    : `${MIRROR}/health`;

  async function send() {
    setBusy(true);
    try {
      const res = await fetch(url);
      const body = await res.json();
      setResult(`HTTP ${res.status}\n${JSON.stringify(body, shorten, 2)}`);
    } catch (error) {
      setResult(`The request failed: ${(error as Error).message}. The mirror may be unreachable from your network.`);
    } finally {
      setBusy(false);
    }
  }

  const field = "rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[13px] outline-none focus-visible:border-[var(--signal)]";
  return (
    <div className="not-prose my-6 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Endpoint
          <select className={field} value={endpoint} onChange={(e) => setEndpoint(e.target.value as Endpoint)}>
            <option value="latest">GET /v1/updates/latest</option>
            <option value="at">GET /v1/updates/at</option>
            <option value="feeds">GET /v1/feeds</option>
            <option value="health">GET /health</option>
          </select>
        </label>
        {(endpoint === "latest" || endpoint === "at") && (
          <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-xs text-muted-foreground">
            ids
            <input className={field} value={ids} onChange={(e) => setIds(e.target.value)} spellCheck={false} />
          </label>
        )}
        {endpoint === "at" && (
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            t (ms)
            <input className={`${field} w-[150px]`} value={t} onChange={(e) => setT(e.target.value)} inputMode="numeric" />
          </label>
        )}
        <button
          type="button"
          onClick={send}
          disabled={busy}
          className="rounded-md bg-[var(--signal)] px-3.5 py-1.5 text-sm font-medium text-[var(--background)] disabled:opacity-60"
        >
          {busy ? "Sending…" : "Send request"}
        </button>
      </div>
      <div className="mt-3 break-all font-mono text-xs text-muted-foreground">{url}</div>
      {result && (
        <pre className="mt-3 max-h-[360px] overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-xs leading-relaxed">{result}</pre>
      )}
    </div>
  );
}
