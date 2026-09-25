//! HTTP API for operators and mirrors: health, finalized updates, and a websocket stream of each
//! newly finalized update. Serve it on a private network; mirrors are the public face.
//!
//!   GET /health
//!   GET /v1/finalized/latest            { tickMs, blob }
//!   GET /v1/finalized/<tickMs>          { tickMs, blob }
//!   GET /v1/finalized?after=<tickMs>    { blobs: [...] } oldest first, at most 500
//!   WS  /v1/stream                      one text frame per finalized update: { tickMs, blob }

import { createServer, type Server } from "node:http";

import { bytesToHex } from "lean-oracle-sdk/protocol";
import { WebSocketServer } from "ws";

import type { PublisherStore } from "./store.js";

const MAX_STREAMS = 32;

export function startApi(
  host: string,
  port: number,
  store: PublisherStore,
  health: () => Record<string, unknown>,
): Server {
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET") return send(405, { error: "method not allowed" });
    if (url.pathname === "/health") return send(200, { ...health(), latestFinalizedTickMs: store.latestFinalizedTick()?.toString() ?? null });
    if (url.pathname === "/v1/finalized/latest") {
      const tick = store.latestFinalizedTick();
      return tick === undefined ? send(404, { error: "none yet" }) : send(200, { tickMs: tick.toString(), blob: store.finalizedAt(tick) });
    }
    const match = /^\/v1\/finalized\/(\d+)$/.exec(url.pathname);
    if (match) {
      const blob = store.finalizedAt(BigInt(match[1]!));
      return blob ? send(200, { tickMs: match[1], blob }) : send(404, { error: "not finalized" });
    }
    const after = /^\/v1\/finalized$/.test(url.pathname) ? url.searchParams.get("after") : null;
    if (after !== null && /^\d+$/.test(after)) return send(200, { blobs: store.finalizedAfter(BigInt(after), 500) });
    send(404, { error: "not found" });
  });

  const streams = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/v1/stream" || streams.clients.size >= MAX_STREAMS) return void socket.destroy();
    streams.handleUpgrade(req, socket, head, (ws) => {
      const unsubscribe = store.onFinalized((tickMs, blob) => ws.send(JSON.stringify({ tickMs: tickMs.toString(), blob: bytesToHex(blob) })));
      ws.on("close", unsubscribe);
      ws.on("error", () => {});
    });
  });
  server.on("close", () => {
    for (const ws of streams.clients) ws.terminate();
    streams.close();
  });
  server.listen(port, host);
  return server;
}
