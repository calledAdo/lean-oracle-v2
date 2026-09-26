import { source } from "@/lib/source";

// llms.txt: an index of the docs for AI coding tools (https://llmstxt.org).
export const revalidate = false;

export function GET() {
  const lines = [
    "# Lean Oracle",
    "",
    "> Pull price oracle for Nervos CKB: exchange prices signed every second by a publisher committee, brought on chain by the transactions that use them and verified by the price_feed_type script.",
    "",
    "## Docs",
    "",
    ...source.getPages().map((p) => `- [${p.data.title}](${p.url})${p.data.description ? `: ${p.data.description}` : ""}`),
    "",
    "## Code",
    "",
    "- [Repository](https://github.com/calledAdo/lean-oracle-v2)",
    "- [lean-oracle-sdk on npm](https://www.npmjs.com/package/lean-oracle-sdk)",
  ];
  return new Response(lines.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
