"use client";

import { useState } from "react";

// A feed cell update, part by part. Hovering or focusing a part explains it.

const PARTS = {
  input: { label: "Input", title: "Your feed cell", text: "The current feed cell, holding the last verified price. Its lock decides who may spend it." },
  output: { label: "Output", title: "Your feed cell, moved forward", text: "Same type script, same feed and committee. The data must equal the verified price exactly, with a newer publish time." },
  witness: { label: "Witness", title: "The signed update", text: "The update blob from the mirror: header, signatures, and this feed's price with its Merkle proof. Stored in input_type of the first input's witness." },
  code: { label: "Cell dep", title: "price_feed_type code", text: "The script that checks the update. Its code hash and out point are listed under Networks." },
  committee: { label: "Cell dep", title: "Committee cell", text: "Holds the committee's current public keys. The script checks the signatures against it." },
  fee: { label: "Input + output", title: "Fee and change", text: "An ordinary cell from your wallet pays the fee. completeFee adds it and the change." },
} as const;
type Part = keyof typeof PARTS;

const Box = ({ id, active, onPick }: { id: Part; active: Part; onPick: (p: Part) => void }) => {
  const on = id === active;
  return (
    <button
      type="button"
      onMouseEnter={() => onPick(id)}
      onFocus={() => onPick(id)}
      onClick={() => onPick(id)}
      className="w-full rounded-lg border px-3 py-2.5 text-left transition-colors"
      style={{ borderColor: on ? "var(--signal)" : "var(--border)", background: on ? "color-mix(in srgb, var(--signal) 8%, var(--background))" : "var(--background)" }}
    >
      <div className="text-[11px] text-muted-foreground">{PARTS[id].label}</div>
      <div className="text-[13.5px]">{PARTS[id].title}</div>
    </button>
  );
};

export function TxAnatomy() {
  const [active, setActive] = useState<Part>("witness");
  return (
    <figure className="not-prose my-8 rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
        <div className="space-y-2">
          <Box id="input" active={active} onPick={setActive} />
          <Box id="witness" active={active} onPick={setActive} />
        </div>
        <div className="hidden text-center text-xs text-muted-foreground sm:block">transaction<br />→</div>
        <div className="space-y-2">
          <Box id="output" active={active} onPick={setActive} />
          <Box id="fee" active={active} onPick={setActive} />
        </div>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <Box id="code" active={active} onPick={setActive} />
        <Box id="committee" active={active} onPick={setActive} />
      </div>
      <p className="mt-4 min-h-[48px] text-[14px] leading-relaxed" aria-live="polite">{PARTS[active].text}</p>
    </figure>
  );
}
