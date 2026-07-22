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
const DEFAULT_RUNTIME: PublicBinanceSpotRuntime = Object.freeze({ createWebSocket: (url) => new WebSocket(url), now: () => new Date().toISOString(), randomId: () => crypto.randomUUID() });

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
  readonly #runtime: PublicBinanceSpotRuntime;
  #socket: ReadOnlyMarketSocket | null = null;
  #observer: PublicBinanceSpotObserver | null = null;
  #latest: BinanceSpotObservationV1 | null = null;
  #generation = 0;
  #connectionId: string | null = null;
  #messageChain = Promise.resolve();

  constructor(runtime: PublicBinanceSpotRuntime = DEFAULT_RUNTIME) { this.#runtime = runtime; }
  async start(observer: PublicBinanceSpotObserver): Promise<void> {
    if (this.#socket !== null) throw new Error("public Binance Spot feed is already started");
    const plan = publicSocketCapturePlan({ source: "binance-spot-book" });
    if (plan.url !== PUBLIC_ENDPOINTS.binanceSpotBookTickerWebSocket || plan.subscription !== null || plan.heartbeatMilliseconds !== null) throw new Error("refusing a non-public Binance Spot socket plan");
    const generation = ++this.#generation; const connectionId = this.#runtime.randomId();
    const socket = this.#runtime.createWebSocket(plan.url); this.#socket = socket; this.#observer = observer; this.#connectionId = connectionId; this.#latest = null;
    socket.addEventListener("open", () => { if (this.#active(socket, generation)) observer.connection(true, this.#runtime.now(), "public Binance Spot bookTicker connected"); });
    socket.addEventListener("message", (event) => { this.#messageChain = this.#messageChain.then(async () => {
      const raw = await frameText(eventData(event)); const parsed = parseBinanceBookTicker(raw);
      if (!this.#active(socket, generation)) return;
      const value = Object.freeze({ ...parsed, receivedAtUtc: this.#runtime.now(), connectionId, inputHash: createHash("sha256").update(raw).digest("hex") }); this.#latest = value; observer.ticker(value);
    }).catch((error: unknown) => { if (this.#active(socket, generation)) observer.error(error, this.#runtime.now()); }); });
    socket.addEventListener("error", () => { if (this.#active(socket, generation)) observer.error(new Error("public Binance Spot WebSocket error"), this.#runtime.now()); });
    socket.addEventListener("close", () => { if (!this.#active(socket, generation)) return; this.#latest = null; this.#socket = null; this.#connectionId = null; observer.connection(false, this.#runtime.now(), "public Binance Spot bookTicker disconnected"); });
  }
  async stop(): Promise<void> { ++this.#generation; const socket = this.#socket; this.#socket = null; this.#latest = null; this.#connectionId = null; this.#observer = null; socket?.close(1000, "caller stopped read-only Binance feed"); await this.#messageChain.catch(() => undefined); }
  latest(): BinanceSpotObservationV1 | null { return this.#latest; }
  #active(socket: ReadOnlyMarketSocket, generation: number): boolean { return this.#socket === socket && this.#generation === generation && this.#observer !== null; }
}
