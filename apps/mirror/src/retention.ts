//! Bounded history: prune the store on a timer so disk use stops growing (docs/oracle-design.md).

export const DEFAULT_RETENTION_DAYS = 7;
const EVERY_MS = 10 * 60_000;

/** Prune ticks older than `windowMs` now and every 10 minutes. Returns a stop function (no-op if `windowMs` is 0). */
export function startPruning(store: { prune(beforeMs: bigint): number }, windowMs: number, log: (event: string, detail?: Record<string, unknown>) => void): () => void {
  if (windowMs <= 0) return () => {};
  const run = () => {
    try {
      const removed = store.prune(BigInt(Date.now() - windowMs));
      if (removed > 0) log("store.pruned", { removed, keptDays: windowMs / 86_400_000 });
    } catch (error) {
      log("store.prune_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };
  run();
  const timer = setInterval(run, EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
