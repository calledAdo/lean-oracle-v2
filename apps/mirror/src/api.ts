//! Public read API.
//!
//!   GET /health
//!   GET /v1/feeds
//!   GET /v1/updates/latest?ids=<id|symbol>,...[&committee=]
//!   GET /v1/updates/at?t=<ms>&ids=...[&committee=]    first update at or after t, per feed
//!   GET /v1/updates/range?id=&from=&to=[&limit≤1000][&committee=]
//!   GET /v1/equivocations[?limit=]
//!   WS  /v1/stream?ids=...[&committee=]               each new update containing any of ids
//!
//! Updates are JSON (`MirrorUpdateJson`); each `blob` carries only the requested feeds. Rate limited
//! per API key (`x-api-key` header or `apiKey` query) or per IP.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { mirrorUpdateJson, toFeedId, type MirrorUpdateJson } from "lean-oracle-sdk/mirror";
import { decodePriceUpdate, type Hex, type PriceUpdate } from "lean-oracle-sdk/protocol";
import { WebSocketServer, type WebSocket } from "ws";

import type { Committee } from "./committee.js";
import type { Ingestor, PublisherSource } from "./ingest.js";
import { RateLimiter } from "./rateLimit.js";
import type { MirrorStore, StoredUpdate } from "./store.js";

const MAX_IDS = 64;
const MAX_RANGE = 1000;

export interface ApiDeps {
  store: MirrorStore;
  ingestor: Ingestor;
  committees: Committee[];
  sources: PublisherSource[];
  limiter: RateLimiter;
  trustProxy?: boolean;
}

class BadRequest extends Error {}

function feedIds(raw: string | null): Hex[] {
  const list = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) throw new BadRequest("ids is required");
  if (list.length > MAX_IDS) throw new BadRequest(`at most ${MAX_IDS} ids`);
  return [...new Set(list.map(toFeedId))];
}

function tickParam(raw: string | null, name: string): bigint {
  if (raw === null || !/^\d{1,20}$/.test(raw)) throw new BadRequest(`${name} must be a Unix time in ms`);
  return BigInt(raw);
}

function committeeParam(raw: string | null): Hex | undefined {
  if (raw === null) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new BadRequest("committee must be a 32-byte hex type hash");
  return raw.toLowerCase() as Hex;
}

/** Group per-feed results by update, so each (committee, tick) is decoded and sent once. */
function grouped(results: [Hex, StoredUpdate | undefined][]): { updates: MirrorUpdateJson[]; missing: Hex[] } {
  const byUpdate = new Map<string, { stored: StoredUpdate; ids: Hex[] }>();
  const missing: Hex[] = [];
  for (const [id, stored] of results) {
    if (!stored) {
      missing.push(id);
      continue;
    }
    const key = `${stored.committee}:${stored.tickMs}`;
    const group = byUpdate.get(key) ?? byUpdate.set(key, { stored, ids: [] }).get(key)!;
    group.ids.push(id);
  }
  const updates = [...byUpdate.values()].map(({ stored, ids }) => mirrorUpdateJson(decodePriceUpdate(stored.blob), ids));
  return { updates, missing };
}

export function startApi(host: string, port: number, deps: ApiDeps): Server {
  const { store, limiter } = deps;
  const clientIp = (req: IncomingMessage) =>
    (deps.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]!.trim() : "") || req.socket.remoteAddress || "unknown";
  const apiKeyOf = (req: IncomingMessage, url: URL) => (req.headers["x-api-key"] as string | undefined) ?? url.searchParams.get("apiKey") ?? undefined;

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown, cache = "no-store") => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": cache, "access-control-allow-origin": "*" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "x-api-key", "access-control-allow-methods": "GET" });
      return void res.end();
    }
    if (req.method !== "GET") return send(405, { error: "method not allowed" });
    if (url.pathname === "/health") {
      return send(200, {
        committees: deps.committees.map((c) => ({
          name: c.name,
          committee: c.typeHash,
          ready: c.ready,
          latestTickMs: store.latestTick(c.typeHash)?.toString() ?? null,
          sourcesConnected: deps.sources.filter((s) => s.committee === c && s.connected).length,
          sources: deps.sources.filter((s) => s.committee === c).length,
        })),
      });
    }

    const identity = limiter.identify(clientIp(req), apiKeyOf(req, url));
    if (!identity) return send(401, { error: "unknown API key" });
    const wait = limiter.take(identity.client, identity.limit);
    if (wait > 0) {
      res.setHeader("retry-after", String(wait));
      return send(429, { error: "rate limited" });
    }

    try {
      const committee = committeeParam(url.searchParams.get("committee"));
      switch (url.pathname) {
        case "/v1/feeds":
          return send(200, { feeds: store.feeds().map((f) => ({ ...f, latestTickMs: f.latestTickMs.toString() })) }, "public, max-age=1");
        case "/v1/updates/latest": {
          const ids = feedIds(url.searchParams.get("ids"));
          return send(200, grouped(ids.map((id) => [id, store.latest(id, committee)])));
        }
        case "/v1/updates/at": {
          const t = tickParam(url.searchParams.get("t"), "t");
          const ids = feedIds(url.searchParams.get("ids"));
          const body = grouped(ids.map((id) => [id, store.atOrAfter(id, t, committee)]));
          // An exact-tick answer can never change; an "after" answer can (a gap may be backfilled).
          const exact = body.missing.length === 0 && body.updates.every((u) => BigInt(u.publishTimeMs) === t);
          return send(200, body, exact ? "public, max-age=31536000, immutable" : "public, max-age=1");
        }
        case "/v1/updates/range": {
          const id = toFeedId(url.searchParams.get("id") ?? "");
          const from = tickParam(url.searchParams.get("from"), "from");
          const to = tickParam(url.searchParams.get("to"), "to");
          const limit = Math.min(Number(url.searchParams.get("limit") ?? MAX_RANGE) || MAX_RANGE, MAX_RANGE);
          const updates = store.range(id, from, to, limit, committee).map((s) => mirrorUpdateJson(decodePriceUpdate(s.blob), [id]));
          return send(200, { updates }, "public, max-age=1");
        }
        case "/v1/equivocations": {
          const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 1000);
          return send(200, { equivocations: store.equivocations(limit).map((e) => ({ ...e, tickMs: e.tickMs.toString() })) });
        }
        default:
          return send(404, { error: "not found" });
      }
    } catch (error) {
      if (error instanceof BadRequest) return send(400, { error: error.message });
      return send(500, { error: "internal error" });
    }
  };

  const server = createServer(handle);

  const streams = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const subscribers = new Set<{ ws: WebSocket; ids: Set<string>; committee?: Hex }>();
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const reject = (status: string) => {
      socket.end(`HTTP/1.1 ${status}\r\n\r\n`);
    };
    if (url.pathname !== "/v1/stream") return reject("404 Not Found");
    const identity = limiter.identify(clientIp(req), apiKeyOf(req, url));
    if (!identity) return reject("401 Unauthorized");
    let ids: Hex[];
    let committee: Hex | undefined;
    try {
      ids = feedIds(url.searchParams.get("ids"));
      committee = committeeParam(url.searchParams.get("committee"));
    } catch {
      return reject("400 Bad Request");
    }
    if (!limiter.openStream(identity.client, identity.limit)) return reject("429 Too Many Requests");
    streams.handleUpgrade(req, socket, head, (ws) => {
      const subscriber = { ws, ids: new Set<string>(ids), committee };
      subscribers.add(subscriber);
      ws.on("close", () => {
        subscribers.delete(subscriber);
        limiter.closeStream(identity.client);
      });
      ws.on("error", () => {});
    });
  });

  const unsubscribe = deps.ingestor.onUpdate((update: PriceUpdate) => {
    const committee = update.header.publisherSetTypeHash.toLowerCase();
    for (const s of subscribers) {
      if (s.committee && s.committee !== committee) continue;
      const ids = update.entries.map((e) => e.message.feedId.toLowerCase() as Hex).filter((id) => s.ids.has(id));
      if (ids.length > 0 && s.ws.readyState === s.ws.OPEN) s.ws.send(JSON.stringify(mirrorUpdateJson(update, ids)));
    }
  });
  const heartbeat = setInterval(() => {
    for (const s of subscribers) s.ws.ping();
    limiter.sweep();
  }, 30_000);
  server.on("close", () => {
    unsubscribe();
    clearInterval(heartbeat);
    for (const s of subscribers) s.ws.terminate();
    streams.close();
  });
  server.listen(port, host);
  return server;
}
