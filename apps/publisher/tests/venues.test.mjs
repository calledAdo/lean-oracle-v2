// Message shapes each venue parser assumes (from the venues' public API docs). If a venue changes
// its format, update the sample here first.
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDecimal } from "../dist/fixed.js";
import { MarketData } from "../dist/marketData.js";
import { decimalText, marketsByVenue, VenueConnection } from "../dist/sources/runner.js";
import { VENUES } from "../dist/sources/venues.js";

const samples = {
  binance: [
    [{ stream: "btcusdt@bookTicker", data: { u: 1, s: "BTCUSDT", b: "65000.10", B: "1", a: "65000.20", A: "1" } }, "BTCUSDT", "quote"],
    [{ stream: "btcusdt@aggTrade", data: { e: "aggTrade", s: "BTCUSDT", p: "65000.15", q: "0.5", T: 1 } }, "BTCUSDT", "trade"],
  ],
  coinbase: [
    [{ type: "snapshot", product_id: "BTC-USD", bids: [["65000.10", "1"]], asks: [["65000.20", "1"]] }, "BTC-USD", "quote"],
    [{ type: "ticker", product_id: "BTC-USD", price: "65000.15", best_bid: "65000.10", best_ask: "65000.20", last_size: "0.01" }, "BTC-USD", "trade"],
  ],
  kraken: [
    [{ channel: "ticker", type: "update", data: [{ symbol: "BTC/USD", bid: 65000.1, ask: 65000.2 }] }, "BTC/USD", "quote"],
    [{ channel: "trade", type: "update", data: [{ symbol: "BTC/USD", price: 65000.15, qty: 0.01 }] }, "BTC/USD", "trade"],
  ],
  bitstamp: [
    [{ event: "data", channel: "order_book_btcusd", data: { bids: [["65000.10", "1"]], asks: [["65000.20", "1"]] } }, "btcusd", "quote"],
    [{ event: "trade", channel: "live_trades_btcusd", data: { price_str: "65000.15", amount_str: "0.01" } }, "btcusd", "trade"],
  ],
  okx: [
    [{ arg: { channel: "tickers", instId: "BTC-USDT" }, data: [{ instId: "BTC-USDT", bidPx: "65000.1", askPx: "65000.2" }] }, "BTC-USDT", "quote"],
    [{ arg: { channel: "trades", instId: "BTC-USDT" }, data: [{ instId: "BTC-USDT", px: "65000.15", sz: "0.01" }] }, "BTC-USDT", "trade"],
  ],
  bybit: [
    [{ topic: "orderbook.1.BTCUSDT", data: { s: "BTCUSDT", b: [["65000.1", "1"]], a: [["65000.2", "1"]] } }, "BTCUSDT", "quote"],
    [{ topic: "publicTrade.BTCUSDT", data: [{ s: "BTCUSDT", p: "65000.15", v: "0.01" }] }, "BTCUSDT", "trade"],
  ],
  gate: [
    [{ channel: "spot.book_ticker", event: "update", result: { s: "CKB_USDT", b: "0.0012700", a: "0.0012720" } }, "CKB_USDT", "quote"],
    [{ channel: "spot.trades", event: "update", result: { currency_pair: "CKB_USDT", price: "0.0012710", amount: "5000" } }, "CKB_USDT", "trade"],
  ],
  bitget: [
    [{ arg: { instType: "SPOT", channel: "ticker", instId: "CKBUSDT" }, data: [{ bidPr: "0.00127", askPr: "0.001272" }] }, "CKBUSDT", "quote"],
    [{ arg: { instType: "SPOT", channel: "trade", instId: "CKBUSDT" }, data: [{ price: "0.001271", size: "5000" }] }, "CKBUSDT", "trade"],
  ],
  upbit: [
    [{ type: "orderbook", code: "KRW-CKB", orderbook_units: [{ ask_price: 1.73, bid_price: 1.72 }] }, "KRW-CKB", "quote"],
    [{ type: "trade", code: "KRW-CKB", trade_price: 1.725, trade_volume: 1000 }, "KRW-CKB", "trade"],
  ],
};

test("every venue parser handles its documented message shapes", () => {
  for (const [venue, cases] of Object.entries(samples)) {
    for (const [message, market, kind] of cases) {
      const events = VENUES[venue].parse(message);
      assert.equal(events.length >= 1, true, `${venue} ${kind}`);
      assert.equal(events[0].kind, kind, venue);
      assert.equal(events[0].market, market, venue);
    }
    assert.deepEqual(VENUES[venue].parse({ unrelated: true }), [], `${venue} ignores other messages`);
  }
});

test("connection pushes parsed quotes and trades with the local receive time", () => {
  const data = new MarketData();
  const connection = new VenueConnection(VENUES.kraken, ["BTC/USD"], data, undefined, () => 5_000);
  connection.handle(samples.kraken[0][0]);
  connection.handle(samples.kraken[1][0]);
  assert.deepEqual(data.latestQuote("kraken", "BTC/USD", 5_000), { bid: parseDecimal("65000.1"), ask: parseDecimal("65000.2"), timeMs: 5_000 });
  assert.equal(data.tradesIn("kraken", "BTC/USD", 0, 5_000).length, 1);
  assert.equal(decimalText(1e-7), "0.0000001");
  assert.deepEqual([...marketsByVenue([{ markets: [{ venue: "a", market: "x" }, { venue: "a", market: "x" }, { venue: "b", market: "y" }] }])], [["a", ["x"]], ["b", ["y"]]]);
});

test("Coinbase top of book follows snapshot and changes", async () => {
  const { coinbaseSpec } = await import("../dist/sources/venues.js");
  const cb = coinbaseSpec();
  cb.parse({ type: "snapshot", product_id: "X", bids: [["10", "1"], ["9", "1"]], asks: [["11", "1"], ["12", "1"]] });
  const top = (m) => { const q = cb.parse(m); return q.length ? `${q[0].bid}/${q[0].ask}` : "none"; };
  assert.equal(top({ type: "l2update", product_id: "X", changes: [["buy", "10.5", "2"]] }), "10.5/11");
  assert.equal(top({ type: "l2update", product_id: "X", changes: [["buy", "10.5", "0"]] }), "10/11");
  assert.equal(top({ type: "l2update", product_id: "X", changes: [["sell", "11", "0"], ["sell", "10.8", "3"]] }), "10/10.8");
  assert.equal(top({ type: "l2update", product_id: "X", changes: [["buy", "10", "0"], ["buy", "9", "0"]] }), "none");
});
