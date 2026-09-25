// The root, /protocol and /publisher entry points must never load @ckb-ccc/core.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");

function importsOf(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const [, spec] of readFileSync(file, "utf8").matchAll(/(?:import|export)[^"']*["']([^"']+)["']/g)) {
    if (spec.startsWith(".")) importsOf(resolve(dirname(file), spec), seen);
    else seen.add(spec);
  }
  return seen;
}

test("CCC-free entry points", () => {
  for (const entry of ["index.js", "protocol/index.js", "publisher/index.js", "presets/index.js", "mirror/index.js"]) {
    const deps = [...importsOf(resolve(dist, entry))].filter((d) => d.startsWith("@ckb-ccc"));
    assert.deepEqual(deps, [], `${entry} pulls in ${deps.join(", ")}`);
  }
});

test("every subpath resolves", async () => {
  for (const sub of ["lean-oracle-sdk", "lean-oracle-sdk/protocol", "lean-oracle-sdk/publisher", "lean-oracle-sdk/mirror", "lean-oracle-sdk/client", "lean-oracle-sdk/ckb", "lean-oracle-sdk/tx", "lean-oracle-sdk/presets"]) {
    assert.ok(Object.keys(await import(sub)).length > 0, sub);
  }
});
