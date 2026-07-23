import { randomUUID } from "node:crypto";

import { BookState, PublicOrderBook } from "../core/src/adapters/market-data/book-state.js";
import {
  parseClobMarketFrame,
  parseRestOrderBook,
  type ParsedClobMarketMessage,
} from "../core/src/adapters/market-data/parsers.js";
import {
  fetchPublicMarketBySlug,
  fetchPublicOrderBook,
  PUBLIC_ENDPOINTS,
  publicSocketCapturePlan,
  validatePublicBtcFiveMinuteMarket,
  type PublicBtcFiveMinuteMarket,
  type PublicHttpRuntime,
} from "../core/src/adapters/market-data/public-sources.js";
import type { PaperMarketSnapshotV1 } from "../paper-simulation/index.js";
import type { PublicPaperFeedObserver, PublicPaperMarketFeed } from "./host.js";

export interface ReadOnlyMarketSocket {
  readonly readyState: number;
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: Event) => void): void;
  removeEventListener(type: "open" | "message" | "error" | "close", listener: (event: Event) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type PublicClobFeedRuntime = Readonly<{
  fetch: PublicHttpRuntime["fetch"];
  createWebSocket: (url: string) => ReadOnlyMarketSocket;
  now: () => string;
  setInterval: (callback: () => void, milliseconds: number) => unknown;
  clearInterval: (handle: unknown) => void;
}>;

export type PublicClobPaperFeedOptions = Readonly<{
  slug: string;
  staleAfterMilliseconds?: number;
  httpTimeoutMilliseconds?: number;
  maxResponseBytes?: number;
  useWebSocket?: boolean;
}>;

export type PublicClobStrategyObservationV1 = Readonly<{
  market: PublicBtcFiveMinuteMarket;
  receivedAtUtc: string;
  state: "ACTIVE_UNVERIFIED";
  continuity: "UNVERIFIED";
  up: Readonly<{ bid: string; ask: string; bidSize: string; askSize: string }>;
  down: Readonly<{ bid: string; ask: string; bidSize: string; askSize: string }>;
}>;

export interface PublicClobStrategySource extends PublicPaperMarketFeed {
  latestStrategyObservation(): PublicClobStrategyObservationV1 | null;
}

const DEFAULT_RUNTIME: PublicClobFeedRuntime = Object.freeze({
  fetch: (input, init) => fetch(input, init),
  createWebSocket: (url) => new WebSocket(url),
  now: () => new Date().toISOString(),
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
});

function eventData(event: Event): unknown {
  return (event as Event & { readonly data?: unknown }).data;
}

async function frameText(value: unknown): Promise<string> {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (value instanceof Blob) return value.text();
  throw new Error("unsupported public CLOB WebSocket frame type");
}

function observedTime(message: ParsedClobMarketMessage, fallback: string): string {
  if (message.providerTimestampRaw !== null && /^[0-9]+$/u.test(message.providerTimestampRaw)) {
    const milliseconds = Number(message.providerTimestampRaw);
    if (Number.isSafeInteger(milliseconds)) return new Date(milliseconds).toISOString();
  }
  return fallback;
}

/**
 * Concrete credential-free feed for one exact BTC five-minute market.
 * Construction is inert. `start` is the only method that performs public I/O.
 */
export class PublicClobPaperMarketFeed implements PublicClobStrategySource {
  readonly feedId: string;
  readonly source = "PUBLIC_MARKET_DATA" as const;
  readonly access = "READ_ONLY" as const;
  readonly #options: Required<PublicClobPaperFeedOptions>;
  readonly #runtime: PublicClobFeedRuntime;
  #observer: PublicPaperFeedObserver | null = null;
  #abort: AbortController | null = null;
  #socket: ReadOnlyMarketSocket | null = null;
  #heartbeat: unknown = null;
  #restPolling: unknown = null;
  #market: PublicBtcFiveMinuteMarket | null = null;
  #book: PublicOrderBook | null = null;
  #connectionId: string | null = null;
  #messageChain = Promise.resolve();
  #strategyObservation: PublicClobStrategyObservationV1 | null = null;

  constructor(options: PublicClobPaperFeedOptions, runtime: PublicClobFeedRuntime = DEFAULT_RUNTIME) {
    if (!/^btc-updown-5m-[0-9]+$/u.test(options.slug)) throw new Error("an exact BTC five-minute slug is required");
    this.feedId = `public-clob-${options.slug}`;
    this.#options = Object.freeze({
      slug: options.slug,
      staleAfterMilliseconds: options.staleAfterMilliseconds ?? 15_000,
      httpTimeoutMilliseconds: options.httpTimeoutMilliseconds ?? 10_000,
      maxResponseBytes: options.maxResponseBytes ?? 5 * 1024 * 1024,
      useWebSocket: options.useWebSocket ?? true,
    });
    this.#runtime = runtime;
  }

  async start(observer: PublicPaperFeedObserver): Promise<void> {
    if (this.#abort !== null) throw new Error("public CLOB feed is already started");
    const abort = new AbortController();
    this.#abort = abort;
    this.#observer = observer;
    this.#strategyObservation = null;
    try {
      const httpRuntime: PublicHttpRuntime = {
        now: this.#runtime.now,
        fetch: (input, init = {}) => this.#runtime.fetch(input, {
          ...init,
          signal: init.signal == null ? abort.signal : AbortSignal.any([init.signal, abort.signal]),
        }),
      };
      const httpOptions = {
        timeoutMilliseconds: this.#options.httpTimeoutMilliseconds,
        maxResponseBytes: this.#options.maxResponseBytes,
      };
      const gamma = await fetchPublicMarketBySlug(this.#options.slug, httpOptions, httpRuntime);
      if (gamma.status !== 200) throw new Error(`Gamma market discovery returned HTTP ${gamma.status}`);
      const market = validatePublicBtcFiveMinuteMarket(gamma.rawPayload);
      this.#market = market;
      this.#book = new PublicOrderBook({
        expectedConditionId: market.conditionId,
        expectedAssetIds: [market.upTokenId, market.downTokenId],
        staleAfterMilliseconds: this.#options.staleAfterMilliseconds,
      });
      this.#connectionId = randomUUID();
      this.#book.connected(this.#connectionId, this.#runtime.now());
      await this.#bootstrapBooks(httpRuntime, httpOptions);
      if (abort.signal.aborted) throw new Error("public CLOB feed start aborted");
      this.#startRestPolling(httpRuntime, httpOptions);
      if (this.#options.useWebSocket) this.#openSocket(market);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const abort = this.#abort;
    this.#abort = null;
    abort?.abort();
    if (this.#heartbeat !== null) this.#runtime.clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    if (this.#restPolling !== null) this.#runtime.clearInterval(this.#restPolling);
    this.#restPolling = null;
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) socket.close(1000, "caller stopped read-only feed");
    this.#book?.disconnected();
    this.#connectionId = null;
    this.#market = null;
    this.#book = null;
    this.#observer = null;
    this.#strategyObservation = null;
    await this.#messageChain.catch(() => undefined);
  }

  latestStrategyObservation(): PublicClobStrategyObservationV1 | null { return this.#strategyObservation; }

  async #bootstrapBooks(
    runtime: PublicHttpRuntime,
    options: Readonly<{ timeoutMilliseconds: number; maxResponseBytes: number }>,
  ): Promise<void> {
    const market = this.#market;
    const book = this.#book;
    const connectionId = this.#connectionId;
    if (market === null || book === null || connectionId === null) throw new Error("market feed is not initialized");
    const responses = await Promise.all([
      fetchPublicOrderBook(market.upTokenId, options, runtime),
      fetchPublicOrderBook(market.downTokenId, options, runtime),
    ]);
    for (const response of responses) {
      if (response.status !== 200) throw new Error(`CLOB REST book returned HTTP ${response.status}`);
      const parsed = parseRestOrderBook(response.rawPayload);
      if (parsed.parserStatus !== "parsed") throw new Error(parsed.parserError ?? "CLOB REST book parse failed");
      book.applySnapshot(parsed, connectionId, response.receiveTime);
    }
    this.#emitSnapshot(this.#runtime.now());
  }

  #openSocket(market: PublicBtcFiveMinuteMarket): void {
    const plan = publicSocketCapturePlan({
      source: "clob-market",
      assetIds: [market.upTokenId, market.downTokenId],
    });
    if (plan.url !== PUBLIC_ENDPOINTS.clobMarketWebSocket || plan.subscription === null) {
      throw new Error("refusing a non-public CLOB market socket plan");
    }
    const socket = this.#runtime.createWebSocket(plan.url);
    this.#socket = socket;
    const onOpen = (): void => {
      if (this.#socket !== socket || this.#abort?.signal.aborted !== false) return;
      if (this.#restPolling !== null) this.#runtime.clearInterval(this.#restPolling);
      this.#restPolling = null;
      socket.send(JSON.stringify(plan.subscription));
      this.#observer?.connection(true, this.#runtime.now(), "public CLOB market WebSocket connected");
      this.#heartbeat = this.#runtime.setInterval(() => {
        if (this.#socket === socket && socket.readyState === 1) socket.send("PING");
      }, plan.heartbeatMilliseconds ?? 10_000);
    };
    const onMessage = (event: Event): void => {
      this.#messageChain = this.#messageChain
        .then(async () => this.#handleFrame(await frameText(eventData(event))))
        .catch((error: unknown) => this.#observer?.error(error, this.#runtime.now()));
    };
    const onError = (): void => {
      this.#observer?.error(new Error("public CLOB market WebSocket error"), this.#runtime.now());
      const abort = this.#abort;
      if (abort !== null) {
        this.#startRestPolling({
          now: this.#runtime.now,
          fetch: (input, init = {}) => this.#runtime.fetch(input, {
            ...init,
            signal: init.signal == null ? abort.signal : AbortSignal.any([init.signal, abort.signal]),
          }),
        }, {
          timeoutMilliseconds: this.#options.httpTimeoutMilliseconds,
          maxResponseBytes: this.#options.maxResponseBytes,
        });
      }
    };
    const onClose = (): void => {
      if (this.#heartbeat !== null) this.#runtime.clearInterval(this.#heartbeat);
      this.#heartbeat = null;
      const abort = this.#abort;
      if (abort !== null) this.#startRestPolling({
        now: this.#runtime.now,
        fetch: (input, init = {}) => this.#runtime.fetch(input, {
          ...init,
          signal: init.signal == null ? abort.signal : AbortSignal.any([init.signal, abort.signal]),
        }),
      }, {
        timeoutMilliseconds: this.#options.httpTimeoutMilliseconds,
        maxResponseBytes: this.#options.maxResponseBytes,
      });
      if (this.#restPolling === null) {
        this.#book?.disconnected();
        this.#observer?.connection(false, this.#runtime.now(), "public CLOB market feed disconnected");
      }
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  }

  #startRestPolling(
    runtime: PublicHttpRuntime,
    options: Readonly<{ timeoutMilliseconds: number; maxResponseBytes: number }>,
  ): void {
    if (this.#restPolling !== null || this.#abort?.signal.aborted !== false) return;
    this.#observer?.connection(true, this.#runtime.now(), this.#options.useWebSocket ? "public CLOB REST polling active (WebSocket upgrade pending)" : "public CLOB REST polling active");
    this.#restPolling = this.#runtime.setInterval(() => {
      void this.#bootstrapBooks(runtime, options).catch((error: unknown) => {
        if (this.#abort?.signal.aborted === false) this.#observer?.error(new Error(`CLOB REST polling failed: ${error instanceof Error ? error.message : String(error)}`), this.#runtime.now());
      });
    }, 1_000);
  }

  async #handleFrame(rawPayload: string): Promise<void> {
    if (rawPayload === "PONG") return;
    const frame = parseClobMarketFrame(rawPayload);
    if (frame.shape === "error") throw new Error(frame.parserError ?? "public CLOB frame parse failed");
    const book = this.#book;
    const connectionId = this.#connectionId;
    if (book === null || connectionId === null) return;
    for (const message of frame.messages) {
      const receivedAtUtc = this.#runtime.now();
      try {
        if (message.eventType === "book") book.applySnapshot(message, connectionId, receivedAtUtc);
        else if (message.eventType === "price_change") book.applyPriceChange(message, connectionId, receivedAtUtc);
        else continue;
        this.#emitSnapshot(observedTime(message, receivedAtUtc));
      } catch (error) {
        this.#observer?.gap(this.#market?.marketId ?? null, receivedAtUtc, error instanceof Error ? error.message : String(error));
        throw error;
      }
    }
  }

  #emitSnapshot(observedAtUtc: string): void {
    const market = this.#market;
    const book = this.#book;
    if (market === null || book === null || !book.allExpectedAssetsReady || book.state !== BookState.ACTIVE_UNVERIFIED) return;
    const yesPrice = book.bestAsk(market.upTokenId);
    const yesQuantity = book.bestAskSize(market.upTokenId);
    const noPrice = book.bestAsk(market.downTokenId);
    const noQuantity = book.bestAskSize(market.downTokenId);
    const yesBid = book.bestBid(market.upTokenId); const yesBidSize = book.bestBidSize(market.upTokenId);
    const noBid = book.bestBid(market.downTokenId); const noBidSize = book.bestBidSize(market.downTokenId);
    const receivedAtUtc = this.#runtime.now();
    const normalizedObservedAtUtc = Date.parse(observedAtUtc) > Date.parse(receivedAtUtc) ? receivedAtUtc : observedAtUtc;
    if (yesPrice !== null && yesQuantity !== null && noPrice !== null && noQuantity !== null && yesBid !== null && yesBidSize !== null && noBid !== null && noBidSize !== null) this.#strategyObservation = Object.freeze({ market, receivedAtUtc, state: "ACTIVE_UNVERIFIED", continuity: "UNVERIFIED", up: Object.freeze({ bid: yesBid, ask: yesPrice, bidSize: yesBidSize, askSize: yesQuantity }), down: Object.freeze({ bid: noBid, ask: noPrice, bidSize: noBidSize, askSize: noQuantity }) });
    const snapshot: PaperMarketSnapshotV1 = Object.freeze({
      schemaVersion: "paper-market-snapshot-v1",
      marketId: market.marketId,
      observedAtUtc: normalizedObservedAtUtc,
      receivedAtUtc,
      eligible: market.collectible,
      yesAsks: yesPrice === null || yesQuantity === null ? Object.freeze([]) : Object.freeze([{ price: yesPrice, quantity: yesQuantity }]),
      noAsks: noPrice === null || noQuantity === null ? Object.freeze([]) : Object.freeze([{ price: noPrice, quantity: noQuantity }]),
    });
    this.#observer?.snapshot(snapshot);
  }
}
