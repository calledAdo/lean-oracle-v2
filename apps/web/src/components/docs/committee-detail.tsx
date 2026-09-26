import data from "@/data/committees.json";
import { CopyValue } from "./copy";

/** One committee: its cell, publishers, quorum, cadence and feeds. */
export function CommitteeDetail({ name }: { name: "majors" | "ckb" }) {
  const c = data.committees[name];
  const feeds = data.feeds.filter((f) => f.committee === name);
  return (
    <div className="not-prose my-6 overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-sm">
        <tbody>
          {[
            ["Type hash (testnet)", <CopyValue key="h" value={c.typeHash} />],
            ["Type ID args", <CopyValue key="a" value={c.typeScript.args} />],
            ["Publishers", `${c.publishers}`],
            ["Quorum", `${c.quorum} of ${c.publishers}`],
            ["Tick", `${c.tickPeriodMs / 1000} s`],
            [
              "Feeds",
              <span key="f" className="flex flex-wrap gap-x-3 gap-y-1">
                {feeds.map((f) => (
                  <a key={f.slug} href={`/docs/feeds/${f.slug}`} className="underline underline-offset-4">{f.pair}</a>
                ))}
              </span>,
            ],
          ].map(([k, v], i) => (
            <tr key={i} className={i ? "border-t border-border" : ""}>
              <td className="w-[36%] px-4 py-2.5 text-muted-foreground">{k}</td>
              <td className="px-3 py-2.5">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
