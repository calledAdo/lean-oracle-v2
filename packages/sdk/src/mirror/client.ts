//! `MirrorClient`: read prices from one or more Lean Oracle mirrors.
//!
//! Mirrors are untrusted. Every value the client returns is decoded from the signed blob, and with
//! `committees` set, each update is verified against the committee cell data before it is returned.
//! Requests fail over across `urls`.

import { LeanOracleError } from "../errors.js";
import type { PublisherSetData } from "../protocol/publisherSet.js";
import { verifyPriceUpdate } from "../protocol/verify.js";
import type { Hex } from "../types.js";
import { parseMirrorUpdate, toFeedId, type MirrorPrice, type MirrorUpdate, type MirrorUpdateJson } from "./format.js";

export class MirrorError extends LeanOracleError {
  constructor(message: string, readonly status?: number) {
    super(message, "MIRROR");
  }
}

export interface MirrorClientOptions {
  /** Mirror base URLs, tried in order. */
  urls: string | string[];
  apiKey?: string;
  fetch?: typeof fetch;
  /** WebSocket constructor for `stream` (defaults to the global one). */
  WebSocket?: typeof WebSocket;
  /** Per request (default 10 s). */
  timeoutMs?: number;
  /**
   * Committee cell data by committee type hash. When set, every update is verified before it is
   * returned, and updates from other committees are rejected. Refresh it after a rotation.
   */
  committees?: Record<Hex, PublisherSetData> | (() => Record<Hex, PublisherSetData>);
}

export interface QueryOptions {
  /** Only updates from this committee (publisher set type hash). */
  committee?: Hex;
  signal?: AbortSignal;
}

export interface MirrorFeed {
  feedId: Hex;
  committee: Hex;
  latestTickMs: bigint;
}

export interface MirrorStream {
  close(): void;
}

export class MirrorClient {
  private readonly urls: string[];
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: MirrorClientOptions) {
    this.urls = (Array.isArray(options.urls) ? options.urls : [options.urls]).map((u) => u.replace(/\/+$/, ""));
    if (this.urls.length === 0) throw new MirrorError("MirrorClient needs at least one URL");
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** The newest update for each feed (IDs or symbols). Feeds from different ticks come as separate updates. */
  async latest(feeds: string[], options: QueryOptions = {}): Promise<MirrorUpdate[]> {
    return this.updates("/v1/updates/latest", feeds, {}, options);
  }

  /** For each feed, the first update at or after `timeMs`. Check `publishTimeMs` if you need an exact tick. */
  async at(timeMs: bigint | number, feeds: string[], options: QueryOptions = {}): Promise<MirrorUpdate[]> {
    return this.updates("/v1/updates/at", feeds, { t: String(timeMs) }, options);
  }

  /** One feed's prices with `fromMs ≤ publishTimeMs ≤ toMs`, oldest first (at most 1000). */
  async range(feed: string, fromMs: bigint | number, toMs: bigint | number, options: QueryOptions & { limit?: number } = {}): Promise<MirrorPrice[]> {
    const params: Record<string, string> = { id: toFeedId(feed), from: String(fromMs), to: String(toMs) };
    if (options.limit !== undefined) params.limit = String(options.limit);
    if (options.committee) params.committee = options.committee;
    const body = (await this.get("/v1/updates/range", params, options.signal)) as { updates: MirrorUpdateJson[] };
    return body.updates.map((json) => this.checked(json, [toFeedId(feed)])).flatMap((u) => u.prices);
  }

  async feeds(signal?: AbortSignal): Promise<MirrorFeed[]> {
    const body = (await this.get("/v1/feeds", {}, signal)) as { feeds: { feedId: Hex; committee: Hex; latestTickMs: string }[] };
    return body.feeds.map((f) => ({ ...f, latestTickMs: BigInt(f.latestTickMs) }));
  }

  /**
   * Every new update containing any of `feeds`, as it is finalized. Reconnects (failing over across
   * URLs) until closed. Updates that fail verification go to `onError` and are not delivered.
   */
  stream(feeds: string[], onUpdate: (update: MirrorUpdate) => void, options: { committee?: Hex; onError?: (error: unknown) => void } = {}): MirrorStream {
    const Ws = this.options.WebSocket ?? globalThis.WebSocket;
    if (!Ws) throw new MirrorError("no WebSocket implementation; pass one in the options");
    const ids = feeds.map(toFeedId);
    let closed = false;
    let socket: WebSocket | undefined;
    let attempt = 0;
    const open = () => {
      if (closed) return;
      const base = this.urls[attempt % this.urls.length]!.replace(/^http/, "ws");
      const query = new URLSearchParams({ ids: ids.join(",") });
      if (options.committee) query.set("committee", options.committee);
      if (this.options.apiKey) query.set("apiKey", this.options.apiKey);
      socket = new Ws(`${base}/v1/stream?${query}`);
      socket.onopen = () => {
        attempt = 0;
      };
      socket.onmessage = (event: MessageEvent) => {
        try {
          onUpdate(this.checked(JSON.parse(String(event.data)) as MirrorUpdateJson, ids));
        } catch (error) {
          options.onError?.(error);
        }
      };
      socket.onerror = () => {};
      socket.onclose = () => {
        if (closed) return;
        attempt++;
        setTimeout(open, Math.min(500 * 2 ** Math.min(attempt, 5), 10_000));
      };
    };
    open();
    return {
      close: () => {
        closed = true;
        socket?.close();
      },
    };
  }

  private async updates(path: string, feeds: string[], params: Record<string, string>, options: QueryOptions): Promise<MirrorUpdate[]> {
    const ids = feeds.map(toFeedId);
    const query: Record<string, string> = { ...params, ids: ids.join(",") };
    if (options.committee) query.committee = options.committee;
    const body = (await this.get(path, query, options.signal)) as { updates: MirrorUpdateJson[]; missing?: Hex[] };
    return body.updates.map((json) => this.checked(json, ids));
  }

  /** Decode, check it answers the request, and verify when committees are configured. */
  private checked(json: MirrorUpdateJson, requested: Hex[]): MirrorUpdate {
    const update = parseMirrorUpdate(json);
    const wanted = new Set(requested);
    if (update.prices.some((p) => !wanted.has(p.feedId.toLowerCase() as Hex))) throw new MirrorError("mirror returned a feed that was not requested");
    const committees = typeof this.options.committees === "function" ? this.options.committees() : this.options.committees;
    if (committees) {
      const entry = Object.entries(committees).find(([hash]) => hash.toLowerCase() === update.committee);
      if (!entry) throw new MirrorError(`update from an unexpected committee ${update.committee}`);
      for (const price of update.prices) verifyPriceUpdate(update.blob, price.feedId, entry[0] as Hex, entry[1]);
    }
    return update;
  }

  private async get(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    const query = new URLSearchParams(params).toString();
    let lastError: unknown;
    for (const base of this.urls) {
      try {
        const headers: Record<string, string> = this.options.apiKey ? { "x-api-key": this.options.apiKey } : {};
        const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 10_000);
        const response = await this.fetchFn(`${base}${path}${query ? `?${query}` : ""}`, { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        if (response.ok) return await response.json();
        const message = await response.text().catch(() => "");
        // Client errors are the same on every mirror; only retry server errors and rate limits.
        if (response.status < 500 && response.status !== 429) throw new MirrorError(`${path}: HTTP ${response.status} ${message}`, response.status);
        lastError = new MirrorError(`${path}: HTTP ${response.status} ${message}`, response.status);
      } catch (error) {
        if (error instanceof MirrorError && error.status !== undefined && error.status < 500 && error.status !== 429) throw error;
        if (signal?.aborted) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new MirrorError(String(lastError));
  }
}
