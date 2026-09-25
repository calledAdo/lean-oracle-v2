//! Runs one venue connection: subscribe, parse, push into market data; reconnect with backoff and
//! when the stream stalls. Quotes and trades are stamped with the local receive time, the same
//! clock ticks use.

import type { LookupFunction } from "node:net";

import WebSocket from "ws";

import { parseDecimal } from "../fixed.js";
import type { MarketDataSink } from "../marketData.js";
import type { VenueSpec } from "./venues.js";

const STALL_MS = 30_000;

/** JSON numbers from some venues: convert without exponent notation. */
export function decimalText(value: string | number): string {
  if (typeof value === "string") return value;
  const text = String(value);
  return /e/i.test(text) ? value.toFixed(18).replace(/0+$/, "").replace(/\.$/, "") : text;
}

export class VenueConnection {
  private socket: WebSocket | undefined;
  private timers: NodeJS.Timeout[] = [];
  private lastMessage = 0;
  private stopped = false;
  private backoffMs = 1000;

  constructor(
    private readonly spec: VenueSpec,
    private readonly markets: string[],
    private readonly sink: MarketDataSink,
    private readonly log: (event: string, detail?: Record<string, unknown>) => void = () => {},
    private readonly now: () => number = Date.now,
    private readonly lookup?: LookupFunction,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.socket?.terminate();
  }

  /** Apply one decoded message (exposed for tests). */
  handle(message: unknown): void {
    const timeMs = this.now();
    for (const event of this.spec.parse(message)) {
      try {
        if (event.kind === "quote") {
          this.sink.quote(this.spec.venue, event.market, {
            bid: parseDecimal(decimalText(event.bid)),
            ask: parseDecimal(decimalText(event.ask)),
            timeMs,
            ...(event.bidSize !== undefined && event.askSize !== undefined
              ? { bidSize: parseDecimal(decimalText(event.bidSize)), askSize: parseDecimal(decimalText(event.askSize)) }
              : {}),
          });
        } else {
          this.sink.trade(this.spec.venue, event.market, { price: parseDecimal(decimalText(event.price)), qty: parseDecimal(decimalText(event.qty)), timeMs });
        }
      } catch {
        // A malformed number from the venue: skip the event.
      }
    }
  }

  private connect(): void {
    if (this.stopped) return;
    Promise.resolve()
      .then(() => this.spec.url(this.markets))
      .then((url) => this.open(url))
      .catch((error: unknown) => {
        this.log("venue.error", { venue: this.spec.venue, error: error instanceof Error ? error.message : String(error) });
        this.retry();
      });
  }

  private retry(): void {
    if (this.stopped) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    setTimeout(() => this.connect(), delay);
  }

  private open(url: string): void {
    if (this.stopped) return;
    const socket = new WebSocket(url, { handshakeTimeout: 10_000, ...(this.lookup ? { lookup: this.lookup } : {}) });
    this.socket = socket;
    socket.on("pong", () => this.sink.alive(this.spec.venue, this.now()));
    socket.on("open", () => {
      this.backoffMs = 1000;
      this.lastMessage = this.now();
      for (const message of this.spec.subscribe(this.markets)) socket.send(JSON.stringify(message));
      this.log("venue.connected", { venue: this.spec.venue, markets: this.markets });
      if (this.spec.ping) {
        const { intervalMs, payload } = this.spec.ping;
        this.timers.push(
          setInterval(() => {
            const value = typeof payload === "function" ? (payload as () => unknown)() : payload;
            socket.send(typeof value === "string" ? value : JSON.stringify(value));
          }, intervalMs),
        );
      }
      this.timers.push(
        setInterval(() => {
          if (this.now() - this.lastMessage > STALL_MS) {
            this.log("venue.stalled", { venue: this.spec.venue });
            socket.terminate();
          }
        }, 5_000),
      );
    });
    socket.on("message", (data) => {
      this.lastMessage = this.now();
      this.sink.alive(this.spec.venue, this.lastMessage);
      const text = data.toString();
      if (text === "pong") return;
      try {
        this.handle(JSON.parse(text));
      } catch {
        // Non-JSON heartbeat frames.
      }
    });
    socket.on("error", (error) => this.log("venue.error", { venue: this.spec.venue, error: error.message }));
    socket.on("close", () => {
      this.clearTimers();
      this.retry();
    });
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}

/** Group every configured market by venue. Unknown venues are reported, not fatal. */
export function marketsByVenue(methods: { markets: { venue: string; market: string }[] }[]): Map<string, string[]> {
  const byVenue = new Map<string, Set<string>>();
  for (const method of methods) {
    for (const m of method.markets) {
      if (!byVenue.has(m.venue)) byVenue.set(m.venue, new Set());
      byVenue.get(m.venue)!.add(m.market);
    }
  }
  return new Map([...byVenue].map(([venue, set]) => [venue, [...set]]));
}
