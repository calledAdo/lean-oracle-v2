import assert from "node:assert/strict";
import { test } from "node:test";

import { AlertState } from "../dist/alerts.js";
import { checkMirror, checkPublisher } from "../dist/checks.js";

const json = (body, status = 200) => async () => ({ ok: status < 300, status, json: async () => body });

test("publisher and mirror checks", async () => {
  const now = 1_000_000;
  assert.equal((await checkPublisher({ name: "majors", url: "http://p", maxLagMs: 30_000 }, now, json({ latestFinalizedTickMs: String(now - 5_000) }))).ok, true);
  assert.equal((await checkPublisher({ name: "majors", url: "http://p", maxLagMs: 30_000 }, now, json({ latestFinalizedTickMs: String(now - 60_000) }))).ok, false);
  assert.match((await checkPublisher({ name: "majors", url: "http://p", maxLagMs: 1 }, now, async () => { throw new Error("ECONNREFUSED"); })).detail, /unreachable/);

  const fetchFn = async (url) => (url.includes("equivocations")
    ? { ok: true, json: async () => ({ equivocations: [{}] }) }
    : { ok: true, json: async () => ({ committees: [{ name: "majors", latestTickMs: String(now - 1_000), sourcesConnected: 1, sources: 1 }, { name: "ckb", latestTickMs: String(now - 90_000), sourcesConnected: 0, sources: 1 }] }) });
  const m = await checkMirror("https://m", { majors: 30_000, ckb: 60_000 }, now, fetchFn);
  assert.deepEqual(m.results.map((r) => [r.key, r.ok]), [["mirror:reachable", true], ["mirror:majors", true], ["mirror:ckb", false]]);
  assert.equal(m.equivocations, 1);
});

test("alerts fire on the second failure, remind hourly, recover once, and flag new equivocations", () => {
  const s = new AlertState({ remindEveryMs: 3_600_000, failuresBeforeAlert: 2 });
  const down = [{ key: "publisher:majors", ok: false, detail: "stalled" }];
  const up = [{ key: "publisher:majors", ok: true, detail: "fine" }];
  assert.deepEqual(s.update(down, 0, 0), [], "one blip is not an alert");
  assert.match(s.update(down, 0, 30_000)[0], /🚨 publisher:majors/);
  assert.deepEqual(s.update(down, 0, 60_000), [], "no repeat within the hour");
  assert.match(s.update(down, 0, 3_700_000)[0], /still failing/);
  assert.match(s.update(up, 0, 3_730_000)[0], /recovered/);
  assert.deepEqual(s.update(up, 0, 3_760_000), []);
  assert.match(s.update(up, 2, 3_790_000)[0], /EQUIVOCATION/);
  assert.match(s.summary(), /✅ publisher:majors/);
});
