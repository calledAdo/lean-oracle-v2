"use client";

import { useEffect, useState } from "react";

// The journey of one price, as six steps. It advances on its own until someone picks a step.

const STEPS = [
  {
    name: "Observe",
    where: "Exchanges → publishers",
    text: "Each publisher keeps live connections to the exchanges that trade a pair and samples their order books through the tick.",
  },
  {
    name: "Agree",
    where: "Publishers",
    text: "Every publisher computes the price the same way: healthy exchanges only, outliers dropped, the median as the price and how far exchanges disagree as its confidence.",
  },
  {
    name: "Sign",
    where: "Committee",
    text: "The committee puts every feed of the tick into one Merkle tree. A quorum of publishers signs its root, once per tick.",
  },
  {
    name: "Serve",
    where: "Mirror",
    text: "Mirrors collect the signed updates, check them and serve them over HTTP and WebSocket. They can't forge a price, only fail to serve one.",
  },
  {
    name: "Submit",
    where: "Your app",
    text: "When your application needs a price, it fetches an update and puts it in a transaction that moves your own feed cell forward.",
  },
  {
    name: "Verify",
    where: "CKB",
    text: "The price_feed_type script checks the Merkle proof, the quorum signatures and that time moves forward. Only then does the cell change.",
  },
];

export function Pipeline() {
  const [active, setActive] = useState(0);
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    if (!auto || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => setActive((a) => (a + 1) % STEPS.length), 3200);
    return () => clearInterval(timer);
  }, [auto]);

  const step = STEPS[active];
  return (
    <figure className="not-prose my-8 rounded-xl border border-border bg-card p-4 sm:p-5">
      <ol className="grid grid-cols-3 gap-2 sm:grid-cols-6" aria-label="How a price reaches your contract">
        {STEPS.map((s, i) => {
          const done = i < active;
          const on = i === active;
          return (
            <li key={s.name} className="relative">
              {i > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute top-[17px] right-[calc(50%+18px)] hidden h-px w-[calc(100%-28px)] sm:block"
                  style={{ background: done || on ? "var(--signal)" : "var(--border)", transition: "background 400ms" }}
                />
              )}
              <button
                type="button"
                onClick={() => {
                  setAuto(false);
                  setActive(i);
                }}
                aria-current={on ? "step" : undefined}
                className="flex w-full flex-col items-center gap-2 rounded-lg py-1 text-center"
              >
                <span
                  className="relative grid size-9 place-items-center rounded-full border font-mono text-[13px] transition-colors"
                  style={{
                    borderColor: on || done ? "var(--signal)" : "var(--border)",
                    background: on ? "var(--signal)" : "var(--background)",
                    color: on ? "var(--background)" : done ? "var(--signal)" : "var(--muted-foreground)",
                  }}
                >
                  {i + 1}
                </span>
                <span className={`text-[13px] ${on ? "text-foreground" : "text-muted-foreground"}`}>{s.name}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="mt-5 min-h-[92px] rounded-lg border border-border bg-background px-4 py-3.5" aria-live="polite">
        <div className="text-xs text-muted-foreground">{step.where}</div>
        <div className="mt-1 text-[15px] leading-relaxed">{step.text}</div>
      </div>
      <figcaption className="mt-3 text-[13px] text-muted-foreground">
        {auto ? "Playing through the steps. Pick one to stop." : (
          <button type="button" className="underline underline-offset-4 hover:text-foreground" onClick={() => setAuto(true)}>
            Play again
          </button>
        )}
      </figcaption>
    </figure>
  );
}
