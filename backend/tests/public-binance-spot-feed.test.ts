import assert from "node:assert/strict";
import test from "node:test";
import { PublicBinanceSpotFeed, type PublicBinanceSpotRuntime, type ReadOnlyMarketSocket } from "../paper-session/index.js";

class FakeSocket implements ReadOnlyMarketSocket {
  readyState = 0; readonly #listeners = new Map<string, Set<(event: Event) => void>>();
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: Event) => void): void { const set = this.#listeners.get(type) ?? new Set(); set.add(listener); this.#listeners.set(type, set); }
  removeEventListener(type: "open" | "message" | "error" | "close", listener: (event: Event) => void): void { this.#listeners.get(type)?.delete(listener); }
  send(): void { throw new Error("Binance direct stream must not send a subscription"); }
  close(): void { this.readyState = 3; this.emit("close", new Event("close")); }
  open(): void { this.readyState = 1; this.emit("open", new Event("open")); }
  message(data: string): void { this.emit("message", new MessageEvent("message", { data })); }
  emit(type: string, event: Event): void { for (const listener of this.#listeners.get(type) ?? []) listener(event); }
}

test("public Binance Spot feed is inert, allowlisted, fail-closed on disconnect and ignores late frames", async () => {
  const socket = new FakeSocket(); let sockets = 0; const connections: boolean[] = []; const ticks: string[] = []; const errors: unknown[] = [];
  const runtime: PublicBinanceSpotRuntime = { now: () => "2026-07-21T14:00:00.000Z", randomId: () => "binance-test-1", createWebSocket: (url) => { sockets += 1; assert.equal(url, "wss://data-stream.binance.vision/ws/btcusdt@bookTicker"); return socket; } };
  const feed = new PublicBinanceSpotFeed(runtime); assert.equal(sockets, 0);
  await feed.start({ ticker: (value) => ticks.push(value.bid), connection: (connected) => connections.push(connected), error: (error) => errors.push(error) });
  assert.equal(sockets, 1); assert.equal(feed.latest(), null); socket.open();
  socket.message(JSON.stringify({ u: 1, s: "BTCUSDT", b: "67000", B: "1", a: "67001", A: "2", T: 1_753_103_600_000, E: 1_753_103_600_001 }));
  await new Promise((resolve) => setImmediate(resolve)); assert.deepEqual(ticks, ["67000"]); assert.equal(feed.latest()?.connectionId, "binance-test-1");
  socket.close(); assert.deepEqual(connections, [true, false]); assert.equal(feed.latest(), null);
  socket.message(JSON.stringify({ u: 2, s: "BTCUSDT", b: "1", B: "1", a: "2", A: "2", T: 1_753_103_600_000, E: 1_753_103_600_001 }));
  await new Promise((resolve) => setImmediate(resolve)); assert.deepEqual(ticks, ["67000"]); assert.deepEqual(errors, []);
  await feed.stop();
});

test("public Binance Spot feed uses credential-free REST polling while WebSocket is unavailable", async () => {
  const socket = new FakeSocket();
  const intervals: Array<() => void> = [];
  const connections: string[] = [];
  const ticks: string[] = [];
  const feed = new PublicBinanceSpotFeed({
    now: () => "2026-07-21T14:00:00.000Z",
    randomId: () => "binance-rest-1",
    createWebSocket: () => socket,
    fetch: async (input, init) => {
      assert.equal(String(input), "https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=BTCUSDT");
      assert.equal(init?.method, "GET");
      return new Response(JSON.stringify({ symbol: "BTCUSDT", bidPrice: "67000", bidQty: "1", askPrice: "67001", askQty: "2" }), { status: 200 });
    },
    setInterval: (callback) => { intervals.push(callback); return callback; },
    clearInterval: () => undefined,
  });
  await feed.start({
    ticker: (value) => ticks.push(value.bid),
    connection: (connected, _at, detail) => connections.push(`${connected}:${detail}`),
    error: (error) => { throw error; },
  });
  assert.deepEqual(ticks, ["67000"]);
  assert.match(connections[0] ?? "", /true:public Binance Spot REST polling active/);
  assert.equal(intervals.length, 1);
  await feed.stop();
});
