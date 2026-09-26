"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

/** A monospace value that copies itself on click; long hashes are shortened on screen only. */
export function CopyValue({ value, short = true }: { value: string; short?: boolean }) {
  const [copied, setCopied] = useState(false);
  const shown = short && value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
  return (
    <button
      type="button"
      title={value}
      aria-label={`Copy ${value}`}
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="inline-flex items-center gap-1.5 rounded px-1 font-mono text-[13px] text-foreground/90 hover:bg-accent"
    >
      {shown}
      {copied ? <Check className="size-3.5 text-[var(--proof)]" /> : <Copy className="size-3.5 text-muted-foreground" />}
    </button>
  );
}
