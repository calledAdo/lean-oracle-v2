"use client";

import { useState } from "react";

export interface CodeTab {
  label: string;
  file: string;
  html: string;
}

/** Tabs over pre-highlighted code (highlighted at build time). */
export function CodeTabs({ tabs }: { tabs: CodeTab[] }) {
  const [active, setActive] = useState(0);
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div role="tablist" aria-label="Code examples" className="flex items-center gap-1 border-b border-border px-2">
        {tabs.map((tab, i) => (
          <button
            key={tab.label}
            role="tab"
            aria-selected={i === active}
            onClick={() => setActive(i)}
            className={`relative px-3 py-3 text-sm transition-colors ${i === active ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {tab.label}
            {i === active && <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-[var(--signal)]" />}
          </button>
        ))}
        <span className="ml-auto pr-2 font-mono text-xs text-muted-foreground">{tabs[active]!.file}</span>
      </div>
      <div
        role="tabpanel"
        className="overflow-x-auto p-5 text-[13.5px] leading-relaxed [&_pre]:!bg-transparent [&_code]:font-mono"
        dangerouslySetInnerHTML={{ __html: tabs[active]!.html }}
      />
    </div>
  );
}
