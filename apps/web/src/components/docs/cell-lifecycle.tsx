import { ArrowRight, X } from "lucide-react";

// A feed cell's life: created empty, moved forward by signed updates, never backwards, burned by its lock.

const Cell = ({ title, price, time, tone }: { title: string; price: string; time: string; tone?: "new" | "bad" }) => (
  <div
    className="min-w-[132px] flex-1 rounded-lg border bg-background px-3 py-2.5"
    style={{
      borderColor: tone === "bad" ? "oklch(0.704 0.191 22.216)" : tone === "new" ? "var(--signal)" : "var(--border)",
      borderStyle: tone === "bad" ? "dashed" : "solid",
    }}
  >
    <div className="text-xs text-muted-foreground">{title}</div>
    <div className="mt-1.5 font-mono text-[13px] tabular-nums">price {price}</div>
    <div className="font-mono text-[13px] tabular-nums text-muted-foreground">time {time}</div>
  </div>
);

const Arrow = ({ label }: { label: string }) => (
  <div className="flex shrink-0 flex-col items-center justify-center px-1 text-[11px] text-muted-foreground">
    <ArrowRight className="size-4" />
    {label}
  </div>
);

export function CellLifecycle() {
  return (
    <figure className="not-prose my-8 rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
        <Cell title="Created" price="0" time="0" />
        <Arrow label="update" />
        <Cell title="After update" price="84,213.50" time="…41 000" />
        <Arrow label="update" />
        <Cell title="After update" price="84,219.10" time="…47 000" tone="new" />
        <Arrow label="burn" />
        <div className="flex min-w-[96px] items-center justify-center rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
          Gone, CKB returned
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3 sm:ml-[calc(50%-20px)]">
        <X className="size-4 shrink-0 text-[oklch(0.704_0.191_22.216)]" />
        <Cell title="Rejected: older than the stored price" price="84,190.00" time="…44 000" tone="bad" />
      </div>
      <figcaption className="mt-4 text-[13px] leading-relaxed text-muted-foreground">
        A new cell holds no price. Each update must carry a newer signed time than the one stored, so an older price can
        never be replayed against it. Its lock decides who may update or burn it.
      </figcaption>
    </figure>
  );
}
