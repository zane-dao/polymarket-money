import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { BookState, PublicOrderBook } from "../../execution/src/adapters/market-data/book-state.js";
import {
  parseClobMarketFrame,
  parseClobMarketMessage,
  parseRtdsPriceMessage,
} from "../../execution/src/adapters/market-data/parsers.js";
import {
  assertCredentialFreePublicPayload,
  capturePublicSocket,
  clobMarketSubscription,
  fetchPublicMarketBySlug,
  fetchPublicOrderBook,
  publicSocketCapturePlan,
  validatePublicBtcFiveMinuteMarket,
  type PublicHttpRuntime,
  type PublicSocketAuditEvent,
  type PublicSocketRuntime,
} from "../../execution/src/adapters/market-data/public-sources.js";

const root = new URL("../../../", import.meta.url);

function clobBook(assetId: string, timestamp: string, market = "condition-1"): string {
  return JSON.stringify({
    event_type: "book",
    asset_id: assetId,
    market,
    bids: [{ price: ".48", size: "30" }],
    asks: [{ price: ".52", size: "25" }],
    timestamp,
    hash: `hash-${assetId}-${timestamp}`,
  });
}

function priceChange(assetId: string, timestamp: string, market = "condition-1"): string {
  return JSON.stringify({
    event_type: "price_change",
    market,
    timestamp,
    price_changes: [
      {
        asset_id: assetId,
        price: ".47",
        size: "10",
        side: "BUY",
        hash: `change-${assetId}-${timestamp}`,
        best_bid: ".48",
        best_ask: ".52",
      },
    ],
  });
}

class FakeWebSocket {
  readyState = 0;
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(data: unknown): void {
    this.emit("message", { data });
  }
}

test("CLOB accepts documented leading-dot decimals while retaining raw payload", () => {
  const raw = clobBook("1", "1757908892000");
  const parsed = parseClobMarketMessage(raw);
  assert.equal(parsed.parserStatus, "parsed");
  assert.equal(parsed.bids?.[0]?.price, ".48");
  assert.equal(parsed.rawPayload, raw);

  const book = new PublicOrderBook({
    expectedConditionId: "condition-1",
    expectedAssetIds: ["1"],
    staleAfterMilliseconds: 1_000,
  });
  book.connected("connection-1", "2026-07-15T00:00:00.000Z");
  book.applySnapshot(parsed, "connection-1", "2026-07-15T00:00:00.100Z");
  assert.equal(book.bestBid("1"), "0.48");
});

test("public socket plans bind endpoint, subscription, and heartbeat to a closed source union", () => {
  const clob = publicSocketCapturePlan({ source: "clob-market", assetIds: ["123", "456"] });
  const chainlink = publicSocketCapturePlan({ source: "rtds-chainlink" });
  const binance = publicSocketCapturePlan({ source: "rtds-binance" });
  assert.equal(clob.heartbeatMilliseconds, 10_000);
  assert.equal(chainlink.heartbeatMilliseconds, 5_000);
  assert.equal(binance.heartbeatMilliseconds, 5_000);
  assert.match(JSON.stringify(clob.subscription), /"type":"market"/);
  assert.match(JSON.stringify(chainlink.subscription), /btc\/usd/);
  assert.match(JSON.stringify(binance.subscription), /btcusdt/);
  assert.throws(
    () => publicSocketCapturePlan({ source: "unknown" } as never),
    /unsupported public socket source/,
  );
});

test("public payload guard recursively rejects credential-like fields", () => {
  assert.doesNotThrow(() => assertCredentialFreePublicPayload({ nested: [{ topic: "crypto_prices" }] }));
  assert.throws(
    () => assertCredentialFreePublicPayload({ nested: [{ gamma_auth: { address: "0x123" } }] }),
    /credential-like field/,
  );
  assert.throws(
    () => assertCredentialFreePublicPayload({ nested: { deeper: { apiKey: "do-not-send" } } }),
    /credential-like field/,
  );
});

test("PONG is transport audit data and does not consume a capture frame", async () => {
  const socket = new FakeWebSocket();
  const audits: PublicSocketAuditEvent[] = [];
  let clock = 0;
  const runtime: PublicSocketRuntime = {
    createWebSocket: () => socket as unknown as WebSocket,
    now: () => `2026-07-15T00:00:00.${String(clock++).padStart(3, "0")}Z`,
  };
  const capture = capturePublicSocket(
    {
      source: "rtds-chainlink",
      timeoutMilliseconds: 1_000,
      maxFrames: 1,
      maxFrameBytes: 100,
      maxTotalBytes: 100,
      accept: async (frame) => frame.rawPayload === "target",
      audit: async (event) => {
        audits.push(event);
      },
    },
    runtime,
  );
  socket.open();
  socket.message("PONG");
  socket.message("target");
  assert.equal(await capture, 1);
  assert.ok(audits.some((event) => event.eventType === "heartbeat_pong"));
});

test("HTTP receive time is captured at headers and requests have bounded timeout", async () => {
  let bodyRead = false;
  let observedSignal: AbortSignal | null = null;
  const runtime: PublicHttpRuntime = {
    fetch: async (_input, init) => {
      observedSignal = init?.signal instanceof AbortSignal ? init.signal : null;
      return {
        status: 200,
        headers: new Headers(),
        body: null,
        text: async () => {
          bodyRead = true;
          return "{}";
        },
      } as Response;
    },
    now: () => {
      assert.equal(bodyRead, false);
      return "2026-07-15T00:00:00.100Z";
    },
  };
  const response = await fetchPublicMarketBySlug(
    "btc-updown-5m-1775181000",
    { timeoutMilliseconds: 2_000 },
    runtime,
  );
  assert.equal(response.receiveTime, "2026-07-15T00:00:00.100Z");
  assert.equal(response.byteLength, 2);
  assert.notEqual(observedSignal, null);
  await assert.rejects(
    fetchPublicMarketBySlug("btc-updown-5m-1775181000", { timeoutMilliseconds: 0 }, runtime),
    /HTTP timeout/,
  );
  await assert.rejects(fetchPublicOrderBook("token-up", {}, runtime), /decimal CLOB token ID/);
});

test("HTTP refuses oversized declared and streamed response bodies", async () => {
  let fetchCalls = 0;
  const declaredRuntime: PublicHttpRuntime = {
    fetch: async () => {
      fetchCalls += 1;
      return new Response("{}", {
        status: 200,
        headers: { "content-length": "100" },
      });
    },
    now: () => "2026-07-15T00:00:00.100Z",
  };
  await assert.rejects(
    fetchPublicOrderBook("1", { maxResponseBytes: 10 }, declaredRuntime),
    /Content-Length 100 exceeds/,
  );

  const streamedRuntime: PublicHttpRuntime = {
    fetch: async () => {
      fetchCalls += 1;
      return new Response("123456", { status: 200 });
    },
    now: () => "2026-07-15T00:00:00.100Z",
  };
  await assert.rejects(
    fetchPublicOrderBook("1", { maxResponseBytes: 5 }, streamedRuntime),
    /response body exceeds maxResponseBytes=5/,
  );
  await assert.rejects(
    fetchPublicOrderBook("1", { maxResponseBytes: 0 }, streamedRuntime),
    /HTTP maxResponseBytes/,
  );
  assert.equal(fetchCalls, 2, "invalid response limits must fail before network I/O");
});

test("socket byte limits fail before retaining oversized or excess frames", async () => {
  const oversizedSocket = new FakeWebSocket();
  let accepts = 0;
  const oversizedCapture = capturePublicSocket(
    {
      source: "rtds-chainlink",
      timeoutMilliseconds: 1_000,
      maxFrames: 10,
      maxFrameBytes: 4,
      maxTotalBytes: 10,
      accept: async () => {
        accepts += 1;
        return false;
      },
    },
    {
      createWebSocket: () => oversizedSocket as unknown as WebSocket,
      now: () => "2026-07-15T00:00:00.100Z",
    },
  );
  oversizedSocket.open();
  oversizedSocket.message("12345");
  await assert.rejects(oversizedCapture, /exceed maxFrameBytes=4/);
  assert.equal(accepts, 0);

  const totalSocket = new FakeWebSocket();
  let consumerStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    consumerStarted = resolve;
  });
  const totalCapture = capturePublicSocket(
    {
      source: "rtds-chainlink",
      timeoutMilliseconds: 1_000,
      maxFrames: 10,
      maxFrameBytes: 4,
      maxTotalBytes: 5,
      accept: async () => {
        consumerStarted();
        return new Promise<boolean>(() => undefined);
      },
    },
    {
      createWebSocket: () => totalSocket as unknown as WebSocket,
      now: () => "2026-07-15T00:00:00.100Z",
    },
  );
  totalSocket.open();
  totalSocket.message("1234");
  await started;
  totalSocket.message("12");
  await assert.rejects(totalCapture, /exceed maxTotalBytes=5/);
});

test("a throwing final socket audit rejects capture instead of hanging", async () => {
  const socket = new FakeWebSocket();
  const capture = capturePublicSocket(
    {
      source: "rtds-chainlink",
      timeoutMilliseconds: 1_000,
      maxFrames: 1,
      maxFrameBytes: 100,
      maxTotalBytes: 100,
      accept: async () => true,
      audit: async (event) => {
        if (event.eventType === "capture_complete") throw new Error("audit exploded");
      },
    },
    {
      createWebSocket: () => socket as unknown as WebSocket,
      now: () => "2026-07-15T00:00:00.100Z",
    },
  );
  socket.open();
  socket.message("target");
  await assert.rejects(capture, /audit exploded/);
});

test("RTDS enforces update type and binds the numeric lexeme to payload.value", () => {
  const raw =
    '{"topic":"crypto_prices_chainlink","type":"snapshot","timestamp":1753314088421,' +
    '"payload":{"symbol":"btc/usd","timestamp":1753314088395,"value":67234.50},' +
    '"vendor_extra":{"value":999.999}}';
  const parsed = parseRtdsPriceMessage(raw, "chainlink");
  assert.equal(parsed.parserStatus, "quarantined");
  assert.match(parsed.quarantineReason ?? "", /unexpected type snapshot/);
  assert.equal(parsed.valueDecimal, "67234.50");
});

test("CLOB array frames are explicit unverified batches and retain the outer raw frame", () => {
  const raw = `[${clobBook("1", "100")},${clobBook("2", "100")}]`;
  const frame = parseClobMarketFrame(raw);
  assert.equal(frame.shape, "batch_unverified");
  assert.equal(frame.rawPayload, raw);
  assert.equal(frame.messages.length, 2);
  assert.ok(frame.messages.every((message) => message.parserStatus === "parsed"));
  assert.equal(parseClobMarketFrame(clobBook("1", "100")).shape, "single");
  assert.equal(parseClobMarketFrame("[]").shape, "error");
});

test("market identity exposes lifecycle and rejects non-decimal token IDs", async () => {
  const raw = await readFile(new URL("data/fixtures/batch-2/gamma-btc-5m.json", root), "utf8");
  const historical = validatePublicBtcFiveMinuteMarket(raw);
  assert.equal(historical.active, true);
  assert.equal(historical.closed, true);
  assert.equal(historical.acceptingOrders, null);
  assert.equal(historical.collectible, false);

  const current = JSON.parse(raw) as Record<string, unknown>;
  current.closed = false;
  current.acceptingOrders = true;
  assert.equal(validatePublicBtcFiveMinuteMarket(JSON.stringify(current)).collectible, true);
  current.eventStartTime = "2026-04-03T01:50:00.000Z";
  current.endDate = "2026-04-03T01:55:00.000Z";
  assert.equal(validatePublicBtcFiveMinuteMarket(JSON.stringify(current)).intervalStart, "2026-04-03T01:50:00Z");

  current.clobTokenIds = '["token-up","2"]';
  assert.throws(() => validatePublicBtcFiveMinuteMarket(JSON.stringify(current)), /decimal CLOB token ID/);
  assert.throws(() => clobMarketSubscription(["123", "not-a-token"]), /decimal CLOB token ID/);
});

test("book waits for every expected asset, binds condition, uses per-asset clocks, and expires locally", () => {
  const book = new PublicOrderBook({
    expectedConditionId: "condition-1",
    expectedAssetIds: ["1", "2"],
    staleAfterMilliseconds: 1_000,
  });
  book.connected("connection-1", "2026-07-15T00:00:00.000Z");
  book.applySnapshot(
    parseClobMarketMessage(clobBook("1", "200")),
    "connection-1",
    "2026-07-15T00:00:00.100Z",
  );
  assert.equal(book.state, BookState.WAITING_FOR_SNAPSHOT);
  assert.equal(book.bestBid("1"), null);
  book.applyPriceChange(
    parseClobMarketMessage(priceChange("1", "201")),
    "connection-1",
    "2026-07-15T00:00:00.200Z",
  );
  book.applySnapshot(
    parseClobMarketMessage(clobBook("2", "100")),
    "connection-1",
    "2026-07-15T00:00:00.300Z",
  );
  assert.equal(book.state, BookState.ACTIVE_UNVERIFIED);
  assert.equal(book.allExpectedAssetsReady, true);
  assert.equal(book.qualityEvents.some((event) => event.includes("REVERSED:2")), false);

  book.applyPriceChange(
    parseClobMarketMessage(priceChange("1", "199")),
    "connection-1",
    "2026-07-15T00:00:00.400Z",
  );
  assert.ok(book.qualityEvents.includes("CLOB_PROVIDER_TIMESTAMP_REVERSED:1"));
  assert.equal(book.markStaleIfExpired("2026-07-15T00:00:01.399Z"), false);
  assert.equal(book.markStaleIfExpired("2026-07-15T00:00:01.400Z"), true);
  assert.equal(book.state, BookState.STALE);
  assert.equal(book.bestAsk("1"), null);
});

test("book fails closed for unexpected condition or asset", () => {
  const wrongCondition = new PublicOrderBook({
    expectedConditionId: "condition-1",
    expectedAssetIds: ["1"],
    staleAfterMilliseconds: 1_000,
  });
  wrongCondition.connected("connection-1", "2026-07-15T00:00:00.000Z");
  assert.throws(
    () =>
      wrongCondition.applySnapshot(
        parseClobMarketMessage(clobBook("1", "100", "condition-2")),
        "connection-1",
        "2026-07-15T00:00:00.100Z",
      ),
    /condition/,
  );
  assert.equal(wrongCondition.state, BookState.RESET_REQUIRED);

  const wrongAsset = new PublicOrderBook({
    expectedConditionId: "condition-1",
    expectedAssetIds: ["1"],
    staleAfterMilliseconds: 1_000,
  });
  wrongAsset.connected("connection-1", "2026-07-15T00:00:00.000Z");
  assert.throws(
    () =>
      wrongAsset.applySnapshot(
        parseClobMarketMessage(clobBook("2", "100")),
        "connection-1",
        "2026-07-15T00:00:00.100Z",
      ),
    /unexpected asset/,
  );
});

test("CLOB lifecycle and trade cross-fields are validated", () => {
  const invalidTrade = JSON.stringify({
    asset_id: "1",
    event_type: "last_trade_price",
    fee_rate_bps: "0",
    market: "condition-1",
    price: ".456",
    side: "HOLD",
    size: "1",
    timestamp: "100",
  });
  assert.equal(parseClobMarketMessage(invalidTrade).parserStatus, "error");

  const invalidResolution = JSON.stringify({
    id: "market-1",
    question: "BTC Up or Down",
    market: "condition-1",
    slug: "btc-updown-5m-1775181000",
    assets_ids: ["1", "2"],
    outcomes: ["Up", "Down"],
    winning_asset_id: "1",
    winning_outcome: "Down",
    timestamp: "100",
    event_type: "market_resolved",
  });
  assert.equal(parseClobMarketMessage(invalidResolution).parserStatus, "error");
});
