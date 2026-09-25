//! Health checks. Each returns one `CheckResult` per thing it watches; a check that cannot reach
//! its target reports that as a failure rather than throwing.

export interface CheckResult {
  /** Stable identity, e.g. `publisher:majors` or `mirror:ckb`. */
  key: string;
  ok: boolean;
  detail: string;
}

export interface Target {
  name: string;
  url: string;
  /** Alert when the latest finalized tick is older than this. */
  maxLagMs: number;
}

type Fetch = typeof fetch;

async function getJson(fetchFn: Fetch, url: string): Promise<unknown> {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

const age = (tickMs: string | null | undefined, now: number) => (tickMs ? now - Number(tickMs) : Infinity);
const seconds = (ms: number) => (Number.isFinite(ms) ? `${Math.round(ms / 1000)} s` : "never");

/** A publisher's API: its latest finalized tick must be recent. */
export async function checkPublisher(target: Target, now: number, fetchFn: Fetch = fetch): Promise<CheckResult> {
  const key = `publisher:${target.name}`;
  try {
    const health = (await getJson(fetchFn, `${target.url}/health`)) as { latestFinalizedTickMs?: string | null };
    const lag = age(health.latestFinalizedTickMs, now);
    return { key, ok: lag <= target.maxLagMs, detail: `last finalized ${seconds(lag)} ago` };
  } catch (error) {
    return { key, ok: false, detail: `unreachable (${error instanceof Error ? error.message : String(error)})` };
  }
}

/** The mirror: reachable, every committee recent, and no equivocation evidence beyond `knownEquivocations`. */
export async function checkMirror(
  url: string,
  maxLagMs: Record<string, number>,
  now: number,
  fetchFn: Fetch = fetch,
): Promise<{ results: CheckResult[]; equivocations: number }> {
  try {
    const health = (await getJson(fetchFn, `${url}/health`)) as { committees: { name: string; latestTickMs: string | null; sourcesConnected: number; sources: number }[] };
    const results: CheckResult[] = [{ key: "mirror:reachable", ok: true, detail: url }];
    for (const c of health.committees) {
      const lag = age(c.latestTickMs, now);
      const limit = maxLagMs[c.name] ?? 60_000;
      results.push({ key: `mirror:${c.name}`, ok: lag <= limit, detail: `latest tick ${seconds(lag)} old, ${c.sourcesConnected}/${c.sources} publishers connected` });
    }
    const { equivocations } = (await getJson(fetchFn, `${url}/v1/equivocations?limit=1000`)) as { equivocations: unknown[] };
    return { results, equivocations: equivocations.length };
  } catch (error) {
    return { results: [{ key: "mirror:reachable", ok: false, detail: `${url} unreachable (${error instanceof Error ? error.message : String(error)})` }], equivocations: -1 };
  }
}
