import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PublicClobPaperMarketFeed,
  type PublicClobFeedRuntime,
  type PublicPaperFeedObserver,
  type ReadOnlyMarketSocket,
} from "../paper-session/index.js";
import type { PaperMarketSnapshotV1 } from "../paper-simulation/index.js";

const NOW = "2026-04-03T01:50:01.000Z";
const UP = "43327618351213667646391460691177105630991180325414735346402735306929604801558";
const DOWN = "239155430611845419074853127543677303617673506907031331685640059318336493355";

class FakeSocket implements ReadOnlyMarketSocket {
  readyState = 0;
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Set<(event: Event) => void>>();

  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: Event) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }
  removeEventListener(type: "open" | "message" | "error" | "close", listener: (event: Event) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.emit("close", new Event("close")); }
  open(): void { this.readyState = 1; this.emit("open", new Event("open")); }
  message(data: string): void { this.emit("message", new MessageEvent("message", { data })); }
  emit(type: string, event: Event): void { for (const listener of this.#listeners.get(type) ?? []) listener(event); }
}

async function gammaFixture(): Promise<string> {
  const path = new URL("../../../data/fixtures/batch-2/gamma-btc-5m.json", import.meta.url);
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  return JSON.stringify({ ...value, closed: false, acceptingOrders: true });
}

function restBook(token: string, ask: string): string {
  return JSON.stringify({
    market: "0x29789033e9636c68c85f55bc4731d6ffbe8f41d37caf0df655a383b626e29c23",
    asset_id: token,
    bids: [{ price: "0.48", size: "20" }],
    asks: [{ price: ask, size: "25" }],
    timestamp: "1775181000900",
    hash: `rest-${token.slice(0, 5)}`,
  });
}

test("credential-free public feed discovers tokens, seeds REST books, handles market WS and emits Paper snapshots", async () => {
  const gamma = await gammaFixture();
  const socket = new FakeSocket();
  const intervalCallbacks: Array<() => void> = [];
  const requested: string[] = [];
  const runtime: PublicClobFeedRuntime = {
    now: () => NOW,
    createWebSocket: (url) => {
      assert.equal(url, "wss://ws-subscriptions-clob.polymarket.com/ws/market");
      return socket;
    },
    fetch: async (input, init) => {
      assert.equal(init?.method, "GET");
      assert.equal((init?.headers as Record<string, string>).accept, "application/json");
      const url = String(input);
      requested.push(url);
      if (url.includes("gamma-api.polymarket.com")) return new Response(gamma, { status: 200 });
      const token = new URL(url).searchParams.get("token_id");
      if (token === UP) return new Response(restBook(UP, "0.52"), { status: 200 });
      if (token === DOWN) return new Response(restBook(DOWN, "0.51"), { status: 200 });
      return new Response("missing fixture", { status: 404 });
    },
    setInterval: (callback) => { intervalCallbacks.push(callback); return callback; },
    clearInterval: () => undefined,
  };
  const snapshots: PaperMarketSnapshotV1[] = [];
  const connections: boolean[] = [];
  const gaps: string[] = [];
  const errors: unknown[] = [];
  const observer: PublicPaperFeedObserver = {
    snapshot: (snapshot) => snapshots.push(snapshot),
    connection: (connected) => connections.push(connected),
    gap: (_marketId, _time, detail) => gaps.push(detail),
    error: (error) => errors.push(error),
  };
  const feed = new PublicClobPaperMarketFeed({ slug: "btc-updown-5m-1775181000" }, runtime);

  assert.equal(requested.length, 0, "construction must be inert");
  await feed.start(observer);
  assert.equal(requested.length, 3);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.eligible, true);
  assert.deepEqual(snapshots[0]?.yesAsks, [{ price: "0.52", quantity: "25" }]);
  assert.deepEqual(snapshots[0]?.noAsks, [{ price: "0.51", quantity: "25" }]);

  socket.open();
  assert.deepEqual(connections, [true]);
  const subscription = JSON.parse(socket.sent[0] ?? "null") as Record<string, unknown>;
  assert.equal(subscription.type, "market");
  assert.deepEqual(subscription.assets_ids, [UP, DOWN]);
  assert.equal(Object.hasOwn(subscription, "auth"), false);
  intervalCallbacks[0]?.();
  assert.equal(socket.sent.at(-1), "PING");
  socket.message("PONG");
  socket.message(JSON.stringify({
    event_type: "price_change",
    market: "0x29789033e9636c68c85f55bc4731d6ffbe8f41d37caf0df655a383b626e29c23",
    timestamp: "1775181000950",
    price_changes: [{
      asset_id: UP, price: "0.52", size: "0", side: "SELL", hash: "up-2", best_bid: "0.48", best_ask: "0.53",
    }, {
      asset_id: UP, price: "0.53", size: "30", side: "SELL", hash: "up-3", best_bid: "0.48", best_ask: "0.53",
    }],
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots.at(-1)?.yesAsks, [{ price: "0.53", quantity: "30" }]);
  assert.deepEqual(gaps, []);
  assert.deepEqual(errors, []);

  await feed.stop();
  assert.deepEqual(connections, [true, false]);
});

test("feed fails closed on discovery/REST status and stop aborts an in-flight injected request", async () => {
  const socket = new FakeSocket();
  let requestSignal: AbortSignal | null = null;
  const runtime: PublicClobFeedRuntime = {
    now: () => NOW,
    createWebSocket: () => socket,
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal ?? null;
      requestSignal?.addEventListener("abort", () => reject(new Error("fixture request aborted")), { once: true });
    }),
    setInterval: () => 1,
    clearInterval: () => undefined,
  };
  const observer: PublicPaperFeedObserver = {
    snapshot: () => undefined,
    connection: () => undefined,
    gap: () => undefined,
    error: () => undefined,
  };
  const feed = new PublicClobPaperMarketFeed({ slug: "btc-updown-5m-1775181000" }, runtime);
  const starting = feed.start(observer);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((requestSignal as AbortSignal | null)?.aborted, false);
  await feed.stop();
  await assert.rejects(starting, /fixture request aborted/);
  assert.equal((requestSignal as AbortSignal | null)?.aborted, true);
  assert.equal(socket.sent.length, 0);
});
