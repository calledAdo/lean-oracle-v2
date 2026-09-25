//! Wiring: committees, storage, ingestion from publishers, and the public API.

import type { Server } from "node:http";

import { Committee } from "./committee.js";
import type { MirrorConfig } from "./config.js";
import { startApi } from "./api.js";
import { Ingestor, PublisherSource, type Log } from "./ingest.js";
import { DEFAULT_RATE_LIMIT, RateLimiter } from "./rateLimit.js";
import { MirrorStore } from "./store.js";

export interface RunningMirror {
  server: Server;
  store: MirrorStore;
  ingestor: Ingestor;
  committees: Committee[];
  sources: PublisherSource[];
  stop(): Promise<void>;
}

export async function startMirror(config: MirrorConfig, log: Log = () => {}): Promise<RunningMirror> {
  const store = new MirrorStore(config.dataPath);
  const ingestor = new Ingestor(store, log);
  const committees = config.committees.map((c) => new Committee(c, log));
  await Promise.all(committees.map((c) => c.start()));
  const sources = config.committees.flatMap((c, i) => c.publishers.map((url) => new PublisherSource(committees[i]!, url, store, ingestor, log)));
  const limiter = new RateLimiter(config.rateLimit ?? DEFAULT_RATE_LIMIT);
  const server = startApi(config.http.host, config.http.port, { store, ingestor, committees, sources, limiter, trustProxy: config.http.trustProxy });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  for (const source of sources) source.start();
  log("mirror.started", { port: config.http.port, committees: committees.map((c) => c.name), sources: sources.length });
  return {
    server,
    store,
    ingestor,
    committees,
    sources,
    async stop() {
      for (const source of sources) source.stop();
      for (const committee of committees) committee.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}
