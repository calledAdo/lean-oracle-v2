//! In-memory market data: latest quote, recent quote history and trades per (venue, market).

export interface Quote {
  bid: bigint;
  ask: bigint;
  timeMs: number;
  /** Top-of-book sizes in base units (18 decimals), when the venue reports them. */
  bidSize?: bigint;
  askSize?: bigint;
}

export interface Trade {
  price: bigint;
  qty: bigint;
  timeMs: number;
}

export interface MarketDataSink {
  quote(venue: string, market: string, quote: Quote): void;
  trade(venue: string, market: string, trade: Trade): void;
  /** The venue connection delivered something (any message, heartbeat or successful poll). */
  alive(venue: string, timeMs: number): void;
}

const key = (venue: string, market: string) => `${venue}\u0000${market}`;

export class MarketData implements MarketDataSink {
  private readonly quotes = new Map<string, Quote[]>();
  private readonly trades = new Map<string, Trade[]>();
  private readonly lastAlive = new Map<string, number>();

  /** `retentionMs` bounds history; it must cover the longest configured window. */
  constructor(private readonly retentionMs = 300_000) {}

  alive(venue: string, timeMs: number): void {
    if ((this.lastAlive.get(venue) ?? 0) < timeMs) this.lastAlive.set(venue, timeMs);
  }

  /** Last time the venue's connection delivered anything. */
  lastAliveMs(venue: string): number | undefined {
    return this.lastAlive.get(venue);
  }

  quote(venue: string, market: string, quote: Quote): void {
    if (quote.bid <= 0n || quote.ask < quote.bid) return;
    this.alive(venue, quote.timeMs);
    this.push(this.quotes, key(venue, market), quote);
  }

  trade(venue: string, market: string, trade: Trade): void {
    if (trade.price <= 0n || trade.qty <= 0n) return;
    this.alive(venue, trade.timeMs);
    this.push(this.trades, key(venue, market), trade);
  }

  /** Most recent quote at or before `atMs`. */
  latestQuote(venue: string, market: string, atMs: number): Quote | undefined {
    const list = this.quotes.get(key(venue, market)) ?? [];
    for (let i = list.length - 1; i >= 0; i--) if (list[i]!.timeMs <= atMs) return list[i];
    return undefined;
  }

  quotesIn(venue: string, market: string, fromMs: number, toMs: number): Quote[] {
    return (this.quotes.get(key(venue, market)) ?? []).filter((q) => q.timeMs > fromMs && q.timeMs <= toMs);
  }

  tradesIn(venue: string, market: string, fromMs: number, toMs: number): Trade[] {
    return (this.trades.get(key(venue, market)) ?? []).filter((t) => t.timeMs > fromMs && t.timeMs <= toMs);
  }

  private push<T extends { timeMs: number }>(map: Map<string, T[]>, k: string, item: T): void {
    const list = map.get(k) ?? [];
    list.push(item);
    const cutoff = item.timeMs - this.retentionMs;
    let drop = 0;
    while (drop < list.length && list[drop]!.timeMs < cutoff) drop++;
    map.set(k, drop > 0 ? list.slice(drop) : list);
  }
}
