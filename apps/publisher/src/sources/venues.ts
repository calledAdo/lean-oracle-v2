//! Exchange websocket specs: URL, subscription messages and a pure parser per venue.
//! Market symbols in the committee config are each venue's native symbol.
//! Parsers were written against the venues' public API documentation; verify each against live
//! traffic before mainnet (see tests/venues.test.mjs for the message shapes assumed).

import https from "node:https";

/** Set by the source manager when exchange DNS goes through DoH. */
export const venueNetwork: { lookup?: import("node:net").LookupFunction } = {};

function postJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: "POST", timeout: 10_000, ...(venueNetwork.lookup ? { lookup: venueNetwork.lookup } : {}) }, (response) => {
      let body = "";
      response.setEncoding("utf8").on("data", (c) => (body += c)).on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("request timeout")));
    request.on("error", reject);
    request.end();
  });
}

export type VenueEvent =
  | { kind: "quote"; market: string; bid: string | number; ask: string | number; bidSize?: string | number; askSize?: string | number }
  | { kind: "trade"; market: string; price: string | number; qty: string | number };

export interface VenueSpec {
  venue: string;
  /** May be async, e.g. when the venue issues a connection token first. */
  url(markets: string[]): string | Promise<string>;
  subscribe(markets: string[]): unknown[];
  parse(message: unknown): VenueEvent[];
  ping?: { intervalMs: number; payload: unknown | (() => unknown) };
}

type Json = Record<string, any>;
const arr = (value: unknown): any[] => (Array.isArray(value) ? value : []);

export const binance: VenueSpec = {
  venue: "binance",
  url: (markets) =>
    `wss://data-stream.binance.vision/stream?streams=${markets.flatMap((m) => [`${m.toLowerCase()}@bookTicker`, `${m.toLowerCase()}@aggTrade`]).join("/")}`,
  subscribe: () => [],
  parse: (m: Json) => {
    const d = m?.data;
    if (!d) return [];
    if (typeof m.stream === "string" && m.stream.endsWith("@bookTicker")) return [{ kind: "quote", market: d.s, bid: d.b, ask: d.a, bidSize: d.B, askSize: d.A }];
    if (d.e === "aggTrade") return [{ kind: "trade", market: d.s, price: d.p, qty: d.q }];
    return [];
  },
};

/** Top of book for one market, kept from a snapshot plus incremental changes. */
export class TopOfBook {
  private readonly bids = new Map<string, string>();
  private readonly asks = new Map<string, string>();
  private bestBid: string | undefined;
  private bestAsk: string | undefined;

  snapshot(bids: [string, string][], asks: [string, string][]): void {
    this.bids.clear();
    this.asks.clear();
    for (const [price, size] of bids) if (Number(size) > 0) this.bids.set(price, size);
    for (const [price, size] of asks) if (Number(size) > 0) this.asks.set(price, size);
    this.bestBid = this.scan(this.bids, "buy");
    this.bestAsk = this.scan(this.asks, "sell");
  }

  change(side: "buy" | "sell", price: string, size: string): void {
    const book = side === "buy" ? this.bids : this.asks;
    const best = side === "buy" ? this.bestBid : this.bestAsk;
    const better = (a: string, b: string | undefined) => b === undefined || (side === "buy" ? Number(a) > Number(b) : Number(a) < Number(b));
    if (Number(size) > 0) {
      book.set(price, size);
      if (better(price, best)) this.setBest(side, price);
    } else {
      book.delete(price);
      if (price === best) this.setBest(side, this.scan(book, side));
    }
  }

  top(): { bid: string; ask: string; bidSize: string; askSize: string } | undefined {
    if (this.bestBid === undefined || this.bestAsk === undefined) return undefined;
    return { bid: this.bestBid, ask: this.bestAsk, bidSize: this.bids.get(this.bestBid)!, askSize: this.asks.get(this.bestAsk)! };
  }

  private setBest(side: "buy" | "sell", price: string | undefined): void {
    if (side === "buy") this.bestBid = price;
    else this.bestAsk = price;
  }

  private scan(book: Map<string, string>, side: "buy" | "sell"): string | undefined {
    let best: string | undefined;
    for (const price of book.keys()) if (best === undefined || (side === "buy" ? Number(price) > Number(best) : Number(price) < Number(best))) best = price;
    return best;
  }
}

/** Coinbase: quotes from `level2_batch` (book snapshot + 50 ms changes), trades from `ticker`. */
export function coinbaseSpec(): VenueSpec {
  const books = new Map<string, TopOfBook>();
  const book = (market: string) => books.get(market) ?? books.set(market, new TopOfBook()).get(market)!;
  const quote = (market: string): VenueEvent[] => {
    const top = books.get(market)?.top();
    return top ? [{ kind: "quote", market, ...top }] : [];
  };
  return {
    venue: "coinbase",
    url: () => "wss://ws-feed.exchange.coinbase.com",
    subscribe: (markets) => [{ type: "subscribe", product_ids: markets, channels: ["level2_batch", "ticker"] }],
    parse: (m: Json) => {
      if (m?.type === "snapshot") {
        book(m.product_id).snapshot(arr(m.bids), arr(m.asks));
        return quote(m.product_id);
      }
      if (m?.type === "l2update") {
        for (const [side, price, size] of arr(m.changes)) book(m.product_id).change(side, price, size);
        return quote(m.product_id);
      }
      if (m?.type === "ticker" && m.last_size) return [{ kind: "trade", market: m.product_id, price: m.price, qty: m.last_size }];
      return [];
    },
  };
}

export const coinbase: VenueSpec = coinbaseSpec();

export const kraken: VenueSpec = {
  venue: "kraken",
  url: () => "wss://ws.kraken.com/v2",
  subscribe: (markets) => [
    { method: "subscribe", params: { channel: "ticker", symbol: markets, event_trigger: "bbo" } },
    { method: "subscribe", params: { channel: "trade", symbol: markets } },
  ],
  parse: (m: Json) => {
    if (m?.channel === "ticker") return arr(m.data).map((d) => ({ kind: "quote" as const, market: d.symbol, bid: d.bid, ask: d.ask, bidSize: d.bid_qty, askSize: d.ask_qty }));
    if (m?.channel === "trade") return arr(m.data).map((d) => ({ kind: "trade" as const, market: d.symbol, price: d.price, qty: d.qty }));
    return [];
  },
  ping: { intervalMs: 30_000, payload: { method: "ping" } },
};

export const bitstamp: VenueSpec = {
  venue: "bitstamp",
  url: () => "wss://ws.bitstamp.net",
  subscribe: (markets) =>
    markets.flatMap((m) => [
      { event: "bts:subscribe", data: { channel: `order_book_${m}` } },
      { event: "bts:subscribe", data: { channel: `live_trades_${m}` } },
    ]),
  parse: (m: Json) => {
    const channel: string = m?.channel ?? "";
    if (m?.event === "data" && channel.startsWith("order_book_")) {
      const bid = m.data?.bids?.[0];
      const ask = m.data?.asks?.[0];
      return bid && ask ? [{ kind: "quote", market: channel.slice("order_book_".length), bid: bid[0], ask: ask[0], bidSize: bid[1], askSize: ask[1] }] : [];
    }
    if (m?.event === "trade" && channel.startsWith("live_trades_")) {
      return [{ kind: "trade", market: channel.slice("live_trades_".length), price: m.data.price_str ?? m.data.price, qty: m.data.amount_str ?? m.data.amount }];
    }
    return [];
  },
};

export const okx: VenueSpec = {
  venue: "okx",
  url: () => "wss://ws.okx.com:8443/ws/v5/public",
  subscribe: (markets) => [
    { op: "subscribe", args: markets.flatMap((instId) => [{ channel: "tickers", instId }, { channel: "trades", instId }]) },
  ],
  parse: (m: Json) => {
    if (m?.arg?.channel === "tickers") return arr(m.data).map((d) => ({ kind: "quote" as const, market: d.instId, bid: d.bidPx, ask: d.askPx, bidSize: d.bidSz, askSize: d.askSz }));
    if (m?.arg?.channel === "trades") return arr(m.data).map((d) => ({ kind: "trade" as const, market: d.instId, price: d.px, qty: d.sz }));
    return [];
  },
  ping: { intervalMs: 25_000, payload: "ping" },
};

export const bybit: VenueSpec = {
  venue: "bybit",
  url: () => "wss://stream.bybit.com/v5/public/spot",
  // Bybit spot accepts at most 10 topics per subscribe request.
  subscribe: (markets) => {
    const topics = markets.flatMap((m) => [`orderbook.1.${m}`, `publicTrade.${m}`]);
    const requests = [];
    for (let i = 0; i < topics.length; i += 10) requests.push({ op: "subscribe", args: topics.slice(i, i + 10) });
    return requests;
  },
  parse: (m: Json) => {
    const topic: string = m?.topic ?? "";
    if (topic.startsWith("orderbook.1.")) {
      const bid = m.data?.b?.[0];
      const ask = m.data?.a?.[0];
      return bid && ask ? [{ kind: "quote", market: m.data.s, bid: bid[0], ask: ask[0], bidSize: bid[1], askSize: ask[1] }] : [];
    }
    if (topic.startsWith("publicTrade.")) return arr(m.data).map((d) => ({ kind: "trade" as const, market: d.s, price: d.p, qty: d.v }));
    return [];
  },
  ping: { intervalMs: 20_000, payload: { op: "ping" } },
};

export const gate: VenueSpec = {
  venue: "gate",
  url: () => "wss://api.gateio.ws/ws/v4/",
  subscribe: (markets) => {
    const time = Math.floor(Date.now() / 1000);
    return [
      { time, channel: "spot.book_ticker", event: "subscribe", payload: markets },
      { time, channel: "spot.trades", event: "subscribe", payload: markets },
    ];
  },
  parse: (m: Json) => {
    if (m?.event !== "update") return [];
    if (m.channel === "spot.book_ticker") return [{ kind: "quote", market: m.result.s, bid: m.result.b, ask: m.result.a, bidSize: m.result.B, askSize: m.result.A }];
    if (m.channel === "spot.trades") return [{ kind: "trade", market: m.result.currency_pair, price: m.result.price, qty: m.result.amount }];
    return [];
  },
  ping: { intervalMs: 20_000, payload: { channel: "spot.ping" } },
};

export const bitget: VenueSpec = {
  venue: "bitget",
  url: () => "wss://ws.bitget.com/v2/ws/public",
  subscribe: (markets) => [
    { op: "subscribe", args: markets.flatMap((instId) => [{ instType: "SPOT", channel: "ticker", instId }, { instType: "SPOT", channel: "trade", instId }]) },
  ],
  parse: (m: Json) => {
    const instId = m?.arg?.instId;
    if (m?.arg?.channel === "ticker") return arr(m.data).map((d) => ({ kind: "quote" as const, market: instId, bid: d.bidPr, ask: d.askPr, bidSize: d.bidSz, askSize: d.askSz }));
    if (m?.arg?.channel === "trade") return arr(m.data).map((d) => ({ kind: "trade" as const, market: instId, price: d.price, qty: d.size }));
    return [];
  },
  ping: { intervalMs: 30_000, payload: "ping" },
};

export const upbit: VenueSpec = {
  venue: "upbit",
  url: () => "wss://api.upbit.com/websocket/v1",
  subscribe: (markets) => [[{ ticket: "lean-oracle" }, { type: "orderbook", codes: markets }, { type: "trade", codes: markets }]],
  parse: (m: Json) => {
    if (m?.type === "orderbook") {
      const unit = m.orderbook_units?.[0];
      return unit ? [{ kind: "quote", market: m.code, bid: unit.bid_price, ask: unit.ask_price, bidSize: unit.bid_size, askSize: unit.ask_size }] : [];
    }
    if (m?.type === "trade") return [{ kind: "trade", market: m.code, price: m.trade_price, qty: m.trade_volume }];
    return [];
  },
};

/** KuCoin: a public token from `bullet-public`, then `/market/ticker` (best bid/ask) and `/market/match` (trades). */
export const kucoin: VenueSpec = {
  venue: "kucoin",
  url: async () => {
    const body = (await postJson("https://api.kucoin.com/api/v1/bullet-public")) as { data?: { token: string; instanceServers: { endpoint: string }[] } };
    const server = body.data?.instanceServers[0];
    if (!body.data || !server) throw new Error("kucoin: no websocket token");
    return `${server.endpoint}?token=${body.data.token}&connectId=${Date.now()}`;
  },
  subscribe: (markets) => [
    { id: `${Date.now()}1`, type: "subscribe", topic: `/market/ticker:${markets.join(",")}`, response: true },
    { id: `${Date.now()}2`, type: "subscribe", topic: `/market/match:${markets.join(",")}`, response: true },
  ],
  parse: (m: Json) => {
    if (m?.type !== "message") return [];
    const market = String(m.topic ?? "").split(":")[1] ?? "";
    if (m.subject === "trade.ticker") return [{ kind: "quote", market, bid: m.data.bestBid, ask: m.data.bestAsk, bidSize: m.data.bestBidSize, askSize: m.data.bestAskSize }];
    if (m.subject === "trade.l3match") return [{ kind: "trade", market: m.data.symbol ?? market, price: m.data.price, qty: m.data.size }];
    return [];
  },
  ping: { intervalMs: 18_000, payload: () => ({ id: String(Date.now()), type: "ping" }) },
};

export const VENUES: Record<string, VenueSpec> = Object.fromEntries(
  [binance, coinbase, kraken, bitstamp, okx, bybit, gate, bitget, upbit, kucoin].map((spec) => [spec.venue, spec]),
);
