import { randomUUID } from "node:crypto";

import { ReceiveClock, type ReceiveStamp } from "../../domain/receive-time.js";
import { Money } from "../../domain/money.js";

export const PUBLIC_ENDPOINTS = Object.freeze({
  gammaMarketBySlug: "https://gamma-api.polymarket.com/markets/slug/",
  clobBook: "https://clob.polymarket.com/book",
  clobMarketWebSocket: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  rtdsWebSocket: "wss://ws-live-data.polymarket.com",
  binanceSpotBookTickerWebSocket: "wss://data-stream.binance.vision/ws/btcusdt@bookTicker",
  binancePerpetualBookTickerWebSocket: "wss://fstream.binance.com/ws/btcusdt@bookTicker",
});

export interface PublicBtcFiveMinuteMarket {
  readonly marketId: string;
  readonly conditionId: string;
  readonly slug: string;
  readonly intervalStart: string;
  readonly intervalEnd: string;
  readonly upTokenId: string;
  readonly downTokenId: string;
  readonly active: boolean | null;
  readonly closed: boolean | null;
  readonly acceptingOrders: boolean | null;
  readonly collectible: boolean;
  readonly takerFeeRate: string | null;
  readonly rawPayload: string;
}

export interface PublicHttpResponse {
  readonly rawPayload: string;
  readonly byteLength: number;
  readonly receiveTime: string;
  readonly receiveStamp: ReceiveStamp;
  readonly status: number;
}

export interface CapturedFrame {
  readonly rawPayload: string;
  readonly receiveTime: string;
  readonly receiveStamp: ReceiveStamp;
}

export interface PublicSocketAuditEvent {
  readonly eventType:
    | "connection_open"
    | "subscription_sent"
    | "capture_complete"
    | "capture_timeout"
    | "connection_error"
    | "connection_closed_early"
    | "heartbeat_ping"
    | "heartbeat_pong";
  readonly receiveTime: string;
  readonly receiveStamp: ReceiveStamp;
  readonly details: Readonly<Record<string, string | number | boolean>>;
}

interface PublicSocketCaptureCommon {
  readonly timeoutMilliseconds: number;
  readonly maxFrames: number;
  readonly maxFrameBytes: number;
  readonly maxTotalBytes: number;
  readonly accept: (frame: CapturedFrame) => Promise<boolean>;
  readonly audit?: (event: PublicSocketAuditEvent) => Promise<void>;
}

export type PublicSocketSource =
  | "clob-market"
  | "rtds-chainlink"
  | "rtds-binance"
  | "binance-spot-book"
  | "binance-perpetual-book";
export type BinanceTransportMode = "btc-only" | "all-symbols-quarantine";

export type PublicSocketRequest =
  | { readonly source: "clob-market"; readonly assetIds: readonly string[] }
  | { readonly source: "rtds-chainlink" }
  | { readonly source: "rtds-binance"; readonly transportMode?: BinanceTransportMode }
  | { readonly source: "binance-spot-book" }
  | { readonly source: "binance-perpetual-book" };

export type PublicSocketCaptureOptions = PublicSocketCaptureCommon & PublicSocketRequest;

export interface PublicSocketCapturePlan {
  readonly source: PublicSocketSource;
  readonly url: string;
  readonly subscription: Readonly<Record<string, unknown>> | null;
  readonly heartbeatMilliseconds: 5_000 | 10_000 | null;
}

export interface PublicSocketRuntime {
  readonly createWebSocket: (url: string) => WebSocket;
  readonly now: () => string;
  readonly receiveClock?: ReceiveClock;
}

export interface PublicHttpRequestOptions {
  readonly timeoutMilliseconds?: number;
  readonly maxResponseBytes?: number;
}

export interface PublicHttpRuntime {
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly now: () => string;
  readonly receiveClock?: ReceiveClock;
}

const SLUG = /^btc-updown-5m-([0-9]+)$/;
const CHAINLINK_BTC_USD_URL = "https://data.chain.link/streams/btc-usd";
const TOKEN_ID = /^[1-9][0-9]*$/;
const DEFAULT_HTTP_TIMEOUT_MILLISECONDS = 10_000;
const MAX_HTTP_TIMEOUT_MILLISECONDS = 60_000;
const DEFAULT_HTTP_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_HTTP_RESPONSE_BYTES = 50 * 1024 * 1024;
const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  "address",
  "apikey",
  "auth",
  "credentials",
  "gammaauth",
  "mnemonic",
  "passphrase",
  "privatekey",
  "secret",
  "seed",
  "seedphrase",
  "wallet",
]);

const PUBLIC_RECEIVE_CLOCK = new ReceiveClock({
  clockDomain: `public-runtime-${process.pid}-${randomUUID()}`,
});
const INJECTED_RUNTIME_CLOCKS = new WeakMap<object, ReceiveClock>();

/** Shared by the default HTTP, WebSocket, and runtime timer boundaries. */
export function publicReceiveClock(): ReceiveClock {
  return PUBLIC_RECEIVE_CLOCK;
}

function receiveClock(runtime: PublicSocketRuntime | PublicHttpRuntime): ReceiveClock {
  if (runtime.receiveClock !== undefined) return runtime.receiveClock;
  let clock = INJECTED_RUNTIME_CLOCKS.get(runtime);
  if (clock === undefined) {
    clock = new ReceiveClock({
      clockDomain: `injected-public-runtime-${randomUUID()}`,
      wallNow: runtime.now,
    });
    INJECTED_RUNTIME_CLOCKS.set(runtime, clock);
  }
  return clock;
}

const DEFAULT_SOCKET_RUNTIME: PublicSocketRuntime = Object.freeze({
  createWebSocket: (url: string) => new WebSocket(url),
  now: () => new Date().toISOString(),
  receiveClock: PUBLIC_RECEIVE_CLOCK,
});

const DEFAULT_HTTP_RUNTIME: PublicHttpRuntime = Object.freeze({
  fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
  now: () => new Date().toISOString(),
  receiveClock: PUBLIC_RECEIVE_CLOCK,
});

export function assertCredentialFreePublicPayload(value: unknown): void {
  const seen = new WeakSet<object>();
  const visit = (current: unknown, path: string): void => {
    if (current === null || typeof current !== "object") return;
    if (seen.has(current)) throw new Error(`cyclic public payload at ${path}`);
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (FORBIDDEN_CREDENTIAL_KEYS.has(normalizedKey)) {
        throw new Error(`credential-like field ${path}.${key} is forbidden on public sources`);
      }
      visit(child, `${path}.${key}`);
    }
  };
  visit(value, "$public");
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value;
}

function tokenId(value: unknown, field: string): string {
  const parsed = text(value, field);
  if (!TOKEN_ID.test(parsed)) throw new Error(`${field} must be a decimal CLOB token ID`);
  return parsed;
}

function nullableBoolean(value: unknown, field: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean when present`);
  return value;
}

function stringArray(value: unknown, field: string): readonly string[] {
  const decoded = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(decoded) || !decoded.every((item) => typeof item === "string" && item !== "")) {
    throw new Error(`${field} must be a string array`);
  }
  return decoded;
}

function isoSecond(epochSeconds: number): string {
  return new Date(epochSeconds * 1_000).toISOString().replace(".000Z", "Z");
}

function requireEpochSecond(value: unknown, field: string): number {
  const raw = text(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?Z$/.test(raw)) {
    throw new Error(`${field} must use a whole-second UTC ISO representation`);
  }
  const milliseconds = Date.parse(raw);
  const canonical = raw.endsWith(".000Z") ? raw : raw.replace("Z", ".000Z");
  if (
    !Number.isFinite(milliseconds)
    || milliseconds % 1_000 !== 0
    || new Date(milliseconds).toISOString() !== canonical
  ) {
    throw new Error(`${field} must be a valid whole-second UTC instant`);
  }
  return milliseconds / 1_000;
}

export function validatePublicBtcFiveMinuteMarket(rawPayload: string): PublicBtcFiveMinuteMarket {
  const market = object(JSON.parse(rawPayload), "Gamma market");
  const slug = text(market.slug, "slug");
  const match = SLUG.exec(slug);
  if (match?.[1] === undefined) throw new Error("slug is not an exact BTC five-minute slug");
  const epoch = Number(match[1]);
  if (!Number.isSafeInteger(epoch) || epoch % 300 !== 0) {
    throw new Error("slug epoch must be a five-minute Unix-second boundary");
  }
  const startEpoch = requireEpochSecond(market.eventStartTime, "eventStartTime");
  const endEpoch = requireEpochSecond(market.endDate, "endDate");
  if (startEpoch !== epoch) throw new Error("slug epoch does not match eventStartTime");
  if (endEpoch !== epoch + 300) throw new Error("endDate is not eventStartTime plus 300 seconds");
  const intervalStart = isoSecond(startEpoch);
  const intervalEnd = isoSecond(endEpoch);
  const resolutionSource = text(market.resolutionSource, "resolutionSource").replace(/\/$/, "");
  if (resolutionSource !== CHAINLINK_BTC_USD_URL) {
    throw new Error("resolution source is not Chainlink BTC/USD");
  }
  const description = text(market.description, "description").toLowerCase();
  if (!description.includes("greater than or equal") || !description.includes('resolve to \"down\"')) {
    throw new Error("market rules do not prove tie=Up and otherwise=Down");
  }
  if (market.enableOrderBook !== true) throw new Error("orderbook is not enabled");
  const labels = stringArray(market.outcomes, "outcomes");
  const tokenIds = stringArray(market.clobTokenIds, "clobTokenIds");
  if (labels.length !== 2 || tokenIds.length !== 2 || new Set(tokenIds).size !== 2) {
    throw new Error("market must contain two distinct outcome tokens");
  }
  const tokens = new Map<string, string>();
  labels.forEach((label, index) => {
    const rawTokenId = tokenIds[index];
    if (rawTokenId === undefined) throw new Error("outcome/token arrays are misaligned");
    const parsedTokenId = tokenId(rawTokenId, `clobTokenIds[${index}]`);
    const normalized = label.trim().toLowerCase();
    if (normalized !== "up" && normalized !== "down") throw new Error(`unsupported outcome ${label}`);
    if (tokens.has(normalized)) throw new Error(`duplicate outcome ${label}`);
    tokens.set(normalized, parsedTokenId);
  });
  const upTokenId = tokens.get("up");
  const downTokenId = tokens.get("down");
  if (upTokenId === undefined || downTokenId === undefined) throw new Error("Up/Down mapping is incomplete");
  const conditionId = text(market.conditionId, "conditionId");
  if (!/^0x[0-9a-fA-F]{64}$/.test(conditionId)) throw new Error("conditionId is malformed");
  const active = nullableBoolean(market.active, "active");
  const closed = nullableBoolean(market.closed, "closed");
  const acceptingOrders = nullableBoolean(market.acceptingOrders, "acceptingOrders");
  const takerFeeRate = (() => {
    if (market.feesEnabled === false) return "0";
    if (market.feeSchedule === undefined || market.feeSchedule === null) return null;
    const schedule = object(market.feeSchedule, "feeSchedule");
    const rawRate = schedule.rate;
    if (typeof rawRate !== "string") throw new Error("feeSchedule.rate must be a canonical decimal string");
    let parsed: Money;
    try {
      parsed = Money.from(rawRate);
    } catch (error) {
      throw new Error("feeSchedule.rate must be a canonical decimal string", { cause: error });
    }
    if (parsed.comparedTo(Money.from("0")) < 0 || parsed.comparedTo(Money.from("1")) > 0) {
      throw new Error("feeSchedule.rate must be between 0 and 1");
    }
    return parsed.toCanonical();
  })();
  return Object.freeze({
    marketId: text(market.id, "id"),
    conditionId,
    slug,
    intervalStart,
    intervalEnd,
    upTokenId,
    downTokenId,
    active,
    closed,
    acceptingOrders,
    collectible: active === true && closed === false && acceptingOrders === true,
    takerFeeRate,
    rawPayload,
  });
}

export function clobMarketSubscription(assetIds: readonly string[]): Readonly<Record<string, unknown>> {
  if (assetIds.length === 0) {
    throw new Error("at least one public asset ID is required");
  }
  const parsedAssetIds = assetIds.map((assetId, index) => tokenId(assetId, `assetIds[${index}]`));
  if (new Set(parsedAssetIds).size !== parsedAssetIds.length) throw new Error("public asset IDs must be unique");
  return Object.freeze({
    assets_ids: Object.freeze(parsedAssetIds),
    type: "market",
    custom_feature_enabled: true,
  });
}

export function rtdsSubscription(
  source: "chainlink" | "binance",
  binanceTransportMode: BinanceTransportMode = "btc-only",
): Readonly<Record<string, unknown>> {
  const subscription = source === "chainlink"
    ? { topic: "crypto_prices_chainlink", type: "*", filters: '{"symbol":"btc/usd"}' }
    : binanceTransportMode === "btc-only"
      ? { topic: "crypto_prices", type: "update", filters: "btcusdt" }
      : { topic: "crypto_prices", type: "update" };
  return Object.freeze({ action: "subscribe", subscriptions: Object.freeze([Object.freeze(subscription)]) });
}

export function publicSocketCapturePlan(request: PublicSocketRequest): PublicSocketCapturePlan {
  let plan: PublicSocketCapturePlan;
  if (request.source === "clob-market") {
    plan = {
      source: request.source,
      url: PUBLIC_ENDPOINTS.clobMarketWebSocket,
      subscription: clobMarketSubscription(request.assetIds),
      heartbeatMilliseconds: 10_000,
    };
  } else if (request.source === "rtds-chainlink" || request.source === "rtds-binance") {
    const rtdsSource = request.source === "rtds-chainlink" ? "chainlink" : "binance";
    plan = {
      source: request.source,
      url: PUBLIC_ENDPOINTS.rtdsWebSocket,
      subscription: rtdsSubscription(
        rtdsSource,
        request.source === "rtds-binance" ? request.transportMode : undefined,
      ),
      heartbeatMilliseconds: 5_000,
    };
  } else if (request.source === "binance-spot-book" || request.source === "binance-perpetual-book") {
    plan = {
      source: request.source,
      url: request.source === "binance-spot-book"
        ? PUBLIC_ENDPOINTS.binanceSpotBookTickerWebSocket
        : PUBLIC_ENDPOINTS.binancePerpetualBookTickerWebSocket,
      subscription: null,
      heartbeatMilliseconds: null,
    };
  } else {
    throw new Error("unsupported public socket source");
  }
  if (plan.subscription !== null) assertCredentialFreePublicPayload(plan.subscription);
  return Object.freeze(plan);
}

function boundedHttpTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_HTTP_TIMEOUT_MILLISECONDS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_HTTP_TIMEOUT_MILLISECONDS) {
    throw new Error(`HTTP timeout must be an integer between 1 and ${MAX_HTTP_TIMEOUT_MILLISECONDS} ms`);
  }
  return timeout;
}

function boundedHttpResponseBytes(value: number | undefined): number {
  const maximum = value ?? DEFAULT_HTTP_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > MAX_HTTP_RESPONSE_BYTES) {
    throw new Error(`HTTP maxResponseBytes must be an integer between 1 and ${MAX_HTTP_RESPONSE_BYTES}`);
  }
  return maximum;
}

function declaredContentLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null) return null;
  if (!/^[0-9]+$/.test(raw)) throw new Error("HTTP Content-Length must be a non-negative decimal integer");
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error("HTTP Content-Length exceeds the safe integer range");
  return parsed;
}

async function boundedResponseText(
  response: Response,
  maxResponseBytes: number,
): Promise<Readonly<{ rawPayload: string; byteLength: number }>> {
  const contentLength = declaredContentLength(response);
  if (contentLength !== null && contentLength > maxResponseBytes) {
    throw new Error(
      `HTTP Content-Length ${contentLength} exceeds maxResponseBytes=${maxResponseBytes}`,
    );
  }

  if (response.body === null) {
    const rawPayload = await response.text();
    const byteLength = new TextEncoder().encode(rawPayload).byteLength;
    if (byteLength > maxResponseBytes) {
      throw new Error(`HTTP response body exceeds maxResponseBytes=${maxResponseBytes}`);
    }
    return Object.freeze({ rawPayload, byteLength });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      if (byteLength > maxResponseBytes - chunk.byteLength) {
        const sizeError = new Error(`HTTP response body exceeds maxResponseBytes=${maxResponseBytes}`);
        try {
          await reader.cancel(sizeError.message);
        } catch (cancelError) {
          throw new AggregateError([sizeError, cancelError], "oversized HTTP body and reader cancel both failed");
        }
        throw sizeError;
      }
      byteLength += chunk.byteLength;
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Object.freeze({
    rawPayload: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    byteLength,
  });
}

export async function fetchPublicMarketBySlug(
  slug: string,
  options: PublicHttpRequestOptions = {},
  runtime: PublicHttpRuntime = DEFAULT_HTTP_RUNTIME,
): Promise<PublicHttpResponse> {
  if (!SLUG.test(slug)) throw new Error("refusing a non-BTC-five-minute market slug");
  const timeoutMilliseconds = boundedHttpTimeout(options.timeoutMilliseconds);
  const maxResponseBytes = boundedHttpResponseBytes(options.maxResponseBytes);
  const response = await runtime.fetch(`${PUBLIC_ENDPOINTS.gammaMarketBySlug}${encodeURIComponent(slug)}`, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMilliseconds),
  });
  const receiveStamp = receiveClock(runtime).capture();
  const receiveTime = receiveStamp.localWallReceiveTime;
  const bounded = await boundedResponseText(response, maxResponseBytes);
  return Object.freeze({ ...bounded, receiveTime, receiveStamp, status: response.status });
}

export async function fetchPublicOrderBook(
  rawTokenId: string,
  options: PublicHttpRequestOptions = {},
  runtime: PublicHttpRuntime = DEFAULT_HTTP_RUNTIME,
): Promise<PublicHttpResponse> {
  const parsedTokenId = tokenId(rawTokenId, "tokenId");
  const timeoutMilliseconds = boundedHttpTimeout(options.timeoutMilliseconds);
  const maxResponseBytes = boundedHttpResponseBytes(options.maxResponseBytes);
  const url = new URL(PUBLIC_ENDPOINTS.clobBook);
  url.searchParams.set("token_id", parsedTokenId);
  const response = await runtime.fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMilliseconds),
  });
  const receiveStamp = receiveClock(runtime).capture();
  const receiveTime = receiveStamp.localWallReceiveTime;
  const bounded = await boundedResponseText(response, maxResponseBytes);
  return Object.freeze({ ...bounded, receiveTime, receiveStamp, status: response.status });
}

function frameByteLength(value: unknown): number {
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof Blob) return value.size;
  throw new Error("unsupported WebSocket frame type");
}

async function frameText(value: unknown): Promise<string> {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (value instanceof Blob) return value.text();
  throw new Error("unsupported WebSocket frame type");
}

export function capturePublicSocket(
  options: PublicSocketCaptureOptions,
  runtime: PublicSocketRuntime = DEFAULT_SOCKET_RUNTIME,
): Promise<number> {
  if (
    !Number.isSafeInteger(options.maxFrames) ||
    !Number.isSafeInteger(options.timeoutMilliseconds) ||
    !Number.isSafeInteger(options.maxFrameBytes) ||
    !Number.isSafeInteger(options.maxTotalBytes) ||
    options.maxFrames <= 0 ||
    options.timeoutMilliseconds <= 0 ||
    options.maxFrameBytes <= 0 ||
    options.maxTotalBytes <= 0
  ) {
    return Promise.reject(new Error("bounded capture limits must be positive safe integers"));
  }
  if (options.maxFrameBytes > options.maxTotalBytes) {
    return Promise.reject(new Error("maxFrameBytes must not exceed maxTotalBytes"));
  }
  const plan = publicSocketCapturePlan(options);
  return new Promise<number>((resolvePromise, rejectPromise) => {
    const socket = runtime.createWebSocket(plan.url);
    let frameCount = 0;
    let totalReceivedBytes = 0;
    let finished = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let chain = Promise.resolve();
    const finish = (error?: unknown, auditType: PublicSocketAuditEvent["eventType"] = "capture_complete"): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (heartbeat !== undefined) clearInterval(heartbeat);
      // A slow or stuck consumer must not prevent a byte-limit, timeout, or
      // transport failure from closing and settling the bounded capture.
      void chain.catch((chainError) => {
        process.stderr.write(`public capture consumer failed after terminal transition: ${String(chainError)}\n`);
      });
      void (async () => {
        let terminalError = error;
        try {
          if (options.audit !== undefined) {
            const receiveStamp = receiveClock(runtime).capture();
            await options.audit({
              eventType: auditType,
              receiveTime: receiveStamp.localWallReceiveTime,
              receiveStamp,
              details: { frameCount, successful: error === undefined, totalReceivedBytes },
            });
          }
        } catch (auditError) {
          terminalError =
            terminalError === undefined
              ? auditError
              : new AggregateError([terminalError, auditError], "capture and final audit both failed");
        }
        try {
          if (socket.readyState === 1 || socket.readyState === 0) {
            socket.close(1000, "bounded smoke capture complete");
          }
        } catch (closeError) {
          terminalError =
            terminalError === undefined
              ? closeError
              : new AggregateError([terminalError, closeError], "capture and socket close both failed");
        }
        if (terminalError === undefined) resolvePromise(frameCount);
        else rejectPromise(terminalError);
      })().catch(rejectPromise);
    };
    const timeout = setTimeout(
      () =>
        finish(
          new Error(`public socket capture timed out after ${options.timeoutMilliseconds} ms`),
          "capture_timeout",
        ),
      options.timeoutMilliseconds,
    );
    socket.addEventListener("open", () => {
      if (finished) return;
      let openedAt: ReceiveStamp | null;
      let subscribedAt: ReceiveStamp | null;
      try {
        openedAt = options.audit === undefined ? null : receiveClock(runtime).capture();
        if (plan.subscription !== null) socket.send(JSON.stringify(plan.subscription));
        subscribedAt = options.audit === undefined || plan.subscription === null
          ? null
          : receiveClock(runtime).capture();
      } catch (error) {
        finish(error, "connection_error");
        return;
      }
      chain = chain
        .then(() => openedAt === null ? undefined : options.audit?.({
            eventType: "connection_open",
            receiveTime: openedAt.localWallReceiveTime,
            receiveStamp: openedAt,
            details: { endpoint: plan.url, source: plan.source },
          }))
        .then(() => subscribedAt === null ? undefined : options.audit?.({
          eventType: "subscription_sent",
          receiveTime: subscribedAt.localWallReceiveTime,
          receiveStamp: subscribedAt,
          details: { public: true, source: plan.source },
        }));
      void chain.catch(finish);
      if (plan.heartbeatMilliseconds !== null) {
        heartbeat = setInterval(() => {
          if (!finished && socket.readyState === 1) {
            let sentAt: ReceiveStamp | null;
            try {
              sentAt = options.audit === undefined ? null : receiveClock(runtime).capture();
              socket.send("PING");
            } catch (error) {
              finish(error, "connection_error");
              return;
            }
            chain = chain.then(() => sentAt === null ? undefined : options.audit?.({
                eventType: "heartbeat_ping",
                receiveTime: sentAt.localWallReceiveTime,
                receiveStamp: sentAt,
                details: { source: plan.source },
              }));
            void chain.catch(finish);
          }
        }, plan.heartbeatMilliseconds);
      }
    });
    socket.addEventListener("message", (event) => {
      if (finished) return;
      let receiveStamp: ReceiveStamp;
      let receiveTime: string;
      let byteLength: number;
      try {
        receiveStamp = receiveClock(runtime).capture();
        receiveTime = receiveStamp.localWallReceiveTime;
        byteLength = frameByteLength(event.data);
      } catch (error) {
        finish(error);
        return;
      }
      if (totalReceivedBytes > Number.MAX_SAFE_INTEGER - byteLength) {
        finish(new Error("public socket byte counter exceeds the safe integer range"));
        return;
      }
      totalReceivedBytes += byteLength;
      if (byteLength > options.maxFrameBytes) {
        finish(
          new Error(`public socket frame bytes ${byteLength} exceed maxFrameBytes=${options.maxFrameBytes}`),
        );
        return;
      }
      if (totalReceivedBytes > options.maxTotalBytes) {
        finish(
          new Error(`public socket total bytes ${totalReceivedBytes} exceed maxTotalBytes=${options.maxTotalBytes}`),
        );
        return;
      }
      const isHeartbeatPong = typeof event.data === "string" && event.data === "PONG";
      if (!isHeartbeatPong && frameCount >= options.maxFrames) {
        finish(new Error(`public socket exceeded maxFrames=${options.maxFrames}`));
        return;
      }
      const frameOrdinal = isHeartbeatPong ? null : frameCount + 1;
      if (frameOrdinal !== null) {
        frameCount = frameOrdinal;
      }
      chain = chain
        .then(async () => {
          if (finished) return;
          const rawPayload = await frameText(event.data);
          if (isHeartbeatPong) {
            await options.audit?.({
              eventType: "heartbeat_pong",
              receiveTime,
              receiveStamp,
              details: { source: plan.source },
            });
            return;
          }
          const accepted = await options.accept(Object.freeze({ rawPayload, receiveTime, receiveStamp }));
          if (accepted) finish();
          else if (frameOrdinal === options.maxFrames) {
            finish(new Error(`public socket reached maxFrames=${options.maxFrames} without target event`));
          }
        })
        .catch(finish);
    });
    socket.addEventListener("error", () =>
      finish(new Error("public WebSocket error"), "connection_error"),
    );
    socket.addEventListener("close", (event) => {
      if (!finished) {
        finish(
          new Error(`public WebSocket closed before target event: ${event.code}`),
          "connection_closed_early",
        );
      }
    });
  });
}
