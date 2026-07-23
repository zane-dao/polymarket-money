import { createHash } from "node:crypto";
import { parseBinanceBookTicker, type ParsedBinanceBookTicker } from "../core/src/adapters/market-data/parsers.js";
import { PUBLIC_ENDPOINTS, publicSocketCapturePlan } from "../core/src/adapters/market-data/public-sources.js";
import type { ReadOnlyMarketSocket } from "./public-clob-feed.js";

export type BinanceSpotObservationV1 = Readonly<ParsedBinanceBookTicker & { receivedAtUtc: string; connectionId: string; inputHash: string }>;
export type PublicBinanceSpotObserver = Readonly<{
  ticker: (value: BinanceSpotObservationV1) => void;
  connection: (connected: boolean, observedAtUtc: string, detail: string) => void;
  error: (error: unknown, observedAtUtc: string) => void;
}>;
export interface PublicBinanceSpotSource {
  readonly source: "PUBLIC_BINANCE_SPOT";
  readonly access: "READ_ONLY";
  start(observer: PublicBinanceSpotObserver): Promise<void>;
  stop(): Promise<void>;
  latest(): BinanceSpotObservationV1 | null;
}
export type PublicBinanceSpotRuntime = Readonly<{ createWebSocket: (url: string) => ReadOnlyMarketSocket; now: () => string; randomId: () => string }>;
export type PublicBinanceSpotRestRuntime = Readonly<{
  fetch?: typeof fetch;
  setInterval?: (callback: () => void, milliseconds: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}>;
const DEFAULT_RUNTIME: PublicBinanceSpotRuntime & Required<PublicBinanceSpotRestRuntime> = Object.freeze({
  createWebSocket: (url) => new WebSocket(url),
  now: () => new Date().toISOString(),
  randomId: () => crypto.randomUUID(),
  fetch: (input, init) => fetch(input, init),
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
});

function eventData(event: Event): unknown { return (event as Event & { readonly data?: unknown }).data; }
async function frameText(value: unknown): Promise<string> {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (value instanceof Blob) return value.text();
  throw new Error("unsupported public Binance WebSocket frame type");
}

/** Credential-free Binance Spot BTCUSDT bookTicker input. Construction performs no I/O. */
export class PublicBinanceSpotFeed implements PublicBinanceSpotSource {
  readonly source = "PUBLIC_BINANCE_SPOT" as const;
  readonly access = "READ_ONLY" as const;
  readonly #runtime: PublicBinanceSpotRuntime & PublicBinanceSpotRestRuntime;
  readonly #useWebSocket: boolean;
  #socket: ReadOnlyMarketSocket | null = null;
  #observer: PublicBinanceSpotObserver | null = null;
  #latest: BinanceSpotObservationV1 | null = null;
  #generation = 0;
  #connectionId: string | null = null;
  #messageChain = Promise.resolve();
  #restPolling: unknown = null;
  #restAbort: AbortController | null = null;

  constructor(runtime: PublicBinanceSpotRuntime & PublicBinanceSpotRestRuntime = DEFAULT_RUNTIME, options: Readonly<{ useWebSocket?: boolean }> = {}) { this.#runtime = runtime; this.#useWebSocket = options.useWebSocket ?? true; }
  async start(observer: PublicBinanceSpotObserver): Promise<void> {
    if (this.#observer !== null) throw new Error("public Binance Spot feed is already started");
    const plan = publicSocketCapturePlan({ source: "binance-spot-book" });
    if (plan.url !== PUBLIC_ENDPOINTS.binanceSpotBookTickerWebSocket || plan.subscription !== null || plan.heartbeatMilliseconds !== null) throw new Error("refusing a non-public Binance Spot socket plan");
    const generation = ++this.#generation; const connectionId = this.#runtime.randomId();
    this.#observer = observer; this.#connectionId = connectionId; this.#latest = null;
    if (this.#useWebSocket) {
      const socket = this.#runtime.createWebSocket(plan.url); this.#socket = socket;
      socket.addEventListener("open", () => { if (this.#active(socket, generation)) { this.#stopRestPolling(); observer.connection(true, this.#runtime.now(), "public Binance Spot bookTicker WebSocket connected"); } });
      socket.addEventListener("message", (event) => { this.#messageChain = this.#messageChain.then(async () => {
        const raw = await frameText(eventData(event)); const parsed = parseBinanceBookTicker(raw);
        if (!this.#active(socket, generation)) return;
        const value = Object.freeze({ ...parsed, receivedAtUtc: this.#runtime.now(), connectionId, inputHash: createHash("sha256").update(raw).digest("hex") }); this.#latest = value; observer.ticker(value);
      }).catch((error: unknown) => { if (this.#active(socket, generation)) observer.error(error, this.#runtime.now()); }); });
      socket.addEventListener("error", () => { if (this.#active(socket, generation)) { observer.error(new Error("public Binance Spot WebSocket error; REST polling remains active"), this.#runtime.now()); void this.#startRestPolling(observer, connectionId, generation); } });
      socket.addEventListener("close", () => { if (!this.#active(socket, generation)) return; this.#socket = null; if (this.#restPolling === null) { this.#latest = null; this.#connectionId = null; observer.connection(false, this.#runtime.now(), "public Binance Spot bookTicker disconnected"); } });
    }
    await this.#startRestPolling(observer, connectionId, generation);
  }
  async stop(): Promise<void> { ++this.#generation; const socket = this.#socket; this.#socket = null; this.#stopRestPolling(); this.#latest = null; this.#connectionId = null; this.#observer = null; socket?.close(1000, "caller stopped read-only Binance feed"); await this.#messageChain.catch(() => undefined); }
  latest(): BinanceSpotObservationV1 | null { return this.#latest; }
  #active(socket: ReadOnlyMarketSocket, generation: number): boolean { return this.#socket === socket && this.#generation === generation && this.#observer !== null; }
  async #startRestPolling(observer: PublicBinanceSpotObserver, connectionId: string, generation: number): Promise<void> {
    if (this.#restPolling !== null || this.#runtime.fetch === undefined || this.#runtime.setInterval === undefined) return;
    const update = async (): Promise<void> => {
      if (this.#generation !== generation || this.#observer === null || this.#runtime.fetch === undefined) return;
      const controller = new AbortController(); this.#restAbort = controller;
      try {
        const response = await this.#runtime.fetch(PUBLIC_ENDPOINTS.binanceSpotBookTickerRest, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const raw = await response.text();
        const value = JSON.parse(raw) as Record<string, unknown>;
        const translated = JSON.stringify({ u: Date.parse(this.#runtime.now()), s: value.symbol, b: value.bidPrice, B: value.bidQty, a: value.askPrice, A: value.askQty });
        const parsed = parseBinanceBookTicker(translated);
        const observed = Object.freeze({ ...parsed, receivedAtUtc: this.#runtime.now(), connectionId, inputHash: createHash("sha256").update(raw).digest("hex") });
        this.#latest = observed;
        observer.ticker(observed);
      } catch (error) {
        if (this.#generation === generation && this.#observer !== null && !controller.signal.aborted) observer.error(new Error(`Binance REST polling failed: ${error instanceof Error ? error.message : String(error)}`), this.#runtime.now());
      } finally {
        if (this.#restAbort === controller) this.#restAbort = null;
      }
    };
    await update();
    if (this.#generation !== generation || this.#observer === null || this.#runtime.setInterval === undefined) return;
    observer.connection(true, this.#runtime.now(), this.#useWebSocket ? "public Binance Spot REST polling active (WebSocket upgrade pending)" : "public Binance Spot REST polling active");
    this.#restPolling = this.#runtime.setInterval(() => { void update(); }, 1_000);
  }
  #stopRestPolling(): void {
    this.#restAbort?.abort(); this.#restAbort = null;
    if (this.#restPolling !== null) this.#runtime.clearInterval?.(this.#restPolling);
    this.#restPolling = null;
  }
}
