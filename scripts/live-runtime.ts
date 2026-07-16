import { randomUUID, createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { BookState, PublicOrderBook } from "../execution/src/adapters/market-data/book-state.js";
import {
  parseClobMarketFrame,
  parseRtdsPriceMessage,
} from "../execution/src/adapters/market-data/parsers.js";
import {
  PUBLIC_ENDPOINTS,
  clobMarketSubscription,
  fetchPublicMarketBySlug,
  rtdsSubscription,
  validatePublicBtcFiveMinuteMarket,
  type PublicBtcFiveMinuteMarket,
} from "../execution/src/adapters/market-data/public-sources.js";
import { createEnvelopeDraft, type ParserStatus } from "../execution/src/domain/raw-event.js";
import {
  completeSetArbitrageObserver,
  leadLagObserver,
  makerEnvelopeObserver,
  noTradeObserver,
  type PaperAudit,
  type PaperSnapshot,
  type ObserverName,
} from "../execution/src/runtime/paper.js";
import {
  MIN_FREE_BYTES,
  SharedByteBudget,
  validateRecordingOptions,
  type RecordMode,
  type RecordingOptions,
} from "../execution/src/runtime/recording.js";
import {
  RawByteLimitReached,
  RawSegmentWriter,
  type ClosedSegment,
} from "../execution/src/storage/raw-segment.js";

type Mode = "monitor" | "paper";
type StreamName = "clob" | "chainlink" | "polymarket_binance" | "binance_spot" | "binance_perpetual" | "gamma";

interface RuntimeOptions {
  readonly mode: Mode;
  readonly durationMilliseconds: number;
  readonly record: RecordingOptions;
  readonly outputPath: string | null;
  readonly summaryPath: string | null;
  readonly json: boolean;
  readonly collectorGitCommit: string;
}

interface StreamStats {
  events: number;
  payloadBytes: number;
  reconnects: number;
  quarantines: number;
  latencies: number[];
}

interface PriceState {
  value: string;
  sourceTime: string | null;
  serverTime: string | null;
  receiveTime: string;
}

interface BookTickerState extends PriceState {
  bid: string;
  bidSize: string;
  ask: string;
  askSize: string;
}

interface CompressedSegmentResult {
  readonly source: string;
  readonly stream: string;
  readonly eventCount: number;
  readonly uncompressedBytes: number;
  readonly uncompressedSha256: string;
  readonly compressedBytes: number;
  readonly compressedSha256: string;
  readonly compressionRatio: number;
}

const STREAMS: readonly StreamName[] = [
  "gamma",
  "clob",
  "chainlink",
  "polymarket_binance",
  "binance_spot",
  "binance_perpetual",
];

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInteger(value: string | undefined, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer`);
  return parsed;
}

function isoFromMilliseconds(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? new Date(parsed).toISOString() : null;
}

function payloadBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? null;
}

function parseMode(value: string | undefined): Mode {
  if (value === "monitor" || value === "paper") return value;
  throw new Error("live runtime mode must be monitor or paper");
}

async function filesystemType(path: string): Promise<string> {
  const command = BunLikeSpawn("findmnt", ["-T", path, "-n", "-o", "FSTYPE"]);
  return command.trim();
}

function BunLikeSpawn(command: string, args: readonly string[]): string {
  const result = process.getBuiltinModule("node:child_process").spawnSync(command, args, {
    encoding: "utf8",
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error(`${command} failed while checking storage`);
  }
  return result.stdout;
}

async function options(): Promise<RuntimeOptions> {
  const mode = parseMode(process.argv[2]);
  const durationSeconds = positiveInteger(argument("--duration-seconds"), "duration-seconds");
  const recordValue = argument("--record") ?? "metrics";
  if (recordValue !== "none" && recordValue !== "metrics" && recordValue !== "raw") {
    throw new Error("--record must be none, metrics, or raw");
  }
  const recordMode = recordValue as RecordMode;
  const configuredOutput = argument("--output");
  let record: RecordingOptions;
  let outputPath: string | null = configuredOutput === undefined ? null : resolve(configuredOutput);
  if (recordMode === "raw") {
    if (configuredOutput === undefined || argument("--max-bytes") === undefined || argument("--duration-seconds") === undefined) {
      throw new Error("raw mode requires explicit --duration-seconds, --max-bytes, and --output");
    }
    await mkdir(outputPath!, { recursive: true, mode: 0o700 });
    const storage = await statfs(outputPath!);
    record = validateRecordingOptions({
      mode: "raw",
      durationMilliseconds: durationSeconds * 1_000,
      maxBytes: positiveInteger(argument("--max-bytes"), "max-bytes"),
      outputPath: outputPath!,
      filesystemType: await filesystemType(outputPath!),
      freeBytes: storage.bavail * storage.bsize,
    });
  } else {
    record = validateRecordingOptions({ mode: recordMode });
    if (recordMode === "metrics") {
      outputPath ??= "/root/polymarket-money-data/runtime-metrics";
      await mkdir(outputPath, { recursive: true, mode: 0o700 });
    }
  }
  const commit = argument("--git-commit");
  if (commit === undefined || !/^[0-9a-f]{40,64}$/u.test(commit)) {
    throw new Error("--git-commit must be the committed collector object ID");
  }
  return {
    mode,
    durationMilliseconds: durationSeconds * 1_000,
    record,
    outputPath,
    summaryPath: argument("--summary") === undefined ? null : resolve(argument("--summary")!),
    json: process.argv.includes("--json"),
    collectorGitCommit: commit,
  };
}

class RuntimeRecorder {
  readonly #config: RuntimeOptions;
  readonly #runId: string;
  readonly #budget: SharedByteBudget | null;
  readonly #writers = new Map<StreamName, RawSegmentWriter>();
  readonly #closed: ClosedSegment[] = [];
  readonly #metrics: Record<string, unknown>[] = [];
  stoppedByLimit = false;

  constructor(config: RuntimeOptions, runId: string) {
    this.#config = config;
    this.#runId = runId;
    this.#budget = config.record.mode === "raw" ? new SharedByteBudget(config.record.maxBytes) : null;
  }

  async open(): Promise<void> {
    if (this.#config.record.mode !== "raw") return;
    const date = new Date().toISOString().slice(0, 10);
    const mapping: Readonly<Record<StreamName, readonly [string, string]>> = {
      gamma: ["polymarket.gamma", "market-discovery"],
      clob: ["polymarket.clob.market", "market-channel"],
      chainlink: ["polymarket.rtds.chainlink", "crypto-prices"],
      polymarket_binance: ["polymarket.rtds.binance", "crypto-prices"],
      binance_spot: ["binance.spot", "book-ticker"],
      binance_perpetual: ["binance.perpetual", "book-ticker"],
    };
    for (const stream of STREAMS) {
      const [source, name] = mapping[stream];
      this.#writers.set(stream, await RawSegmentWriter.open({
        dataRoot: this.#config.record.outputPath,
        segmentId: `${this.#runId}-${stream.replaceAll("_", "-")}`,
        source,
        stream: name,
        partitionDate: date,
        reserveBytes: this.#budget!.reserve,
      }));
    }
  }

  async raw(
    stream: StreamName,
    input: {
      readonly eventType: string;
      readonly rawPayload: string;
      readonly receiveTime: string;
      readonly sourceTime?: string | null;
      readonly serverTime?: string | null;
      readonly sourceSequence?: string | null;
      readonly market?: PublicBtcFiveMinuteMarket | null;
      readonly assetId?: string | null;
      readonly parserStatus: ParserStatus;
      readonly parserError?: string | null;
      readonly connectionId: string;
    },
  ): Promise<void> {
    if (this.#config.record.mode !== "raw" || this.stoppedByLimit) return;
    const writer = this.#writers.get(stream);
    if (writer === undefined) throw new Error(`raw writer missing for ${stream}`);
    try {
      await writer.append(createEnvelopeDraft({
        eventId: randomUUID(),
        source: stream === "gamma" ? "polymarket.gamma" : stream === "clob" ? "polymarket.clob.market" : stream === "chainlink" ? "polymarket.rtds.chainlink" : stream === "polymarket_binance" ? "polymarket.rtds.binance" : stream === "binance_spot" ? "binance.spot" : "binance.perpetual",
        stream: stream === "gamma" ? "market-discovery" : stream === "clob" ? "market-channel" : stream.includes("binance_") && !stream.startsWith("polymarket") ? "book-ticker" : "crypto-prices",
        eventType: input.eventType,
        connectionId: input.connectionId,
        subscriptionId: `${this.#runId}-${stream}-public-only`,
        marketId: input.market?.marketId ?? null,
        conditionId: input.market?.conditionId ?? null,
        assetId: input.assetId ?? null,
        sourceTime: input.sourceTime ?? null,
        serverTime: input.serverTime ?? null,
        receiveTime: input.receiveTime,
        processTime: new Date().toISOString(),
        sourceSequence: input.sourceSequence ?? null,
        rawPayload: input.rawPayload,
        parserStatus: input.parserStatus,
        parserError: input.parserError ?? null,
      }));
    } catch (error) {
      if (error instanceof RawByteLimitReached) {
        this.stoppedByLimit = true;
        return;
      }
      throw error;
    }
  }

  metric(value: Record<string, unknown>): void {
    if (this.#config.record.writesMetrics) this.#metrics.push(value);
  }

  async close(): Promise<readonly CompressedSegmentResult[]> {
    if (this.#config.record.mode === "raw") {
      for (const writer of this.#writers.values()) {
        try {
          this.#closed.push(await writer.close());
        } catch (error) {
          await writer.leaveIncomplete().catch(() => undefined);
          if (!(error instanceof Error && /empty segment/u.test(error.message))) throw error;
        }
      }
    }
    if (this.#config.record.writesMetrics && this.#config.outputPath !== null) {
      const path = join(this.#config.outputPath, `${this.#runId}-metrics.jsonl`);
      const body = this.#metrics.map((item) => JSON.stringify(item)).join("\n") + (this.#metrics.length ? "\n" : "");
      await writeFile(path, body, { flag: "wx", mode: 0o400 });
    }
    const compressed: CompressedSegmentResult[] = [];
    if (this.#config.record.mode === "raw") {
      for (const segment of this.#closed) {
        const path = join(this.#config.record.outputPath, ...segment.relativePath.split("/"));
        const bytes = await readFile(path);
        const gz = gzipSync(bytes, { level: 6 });
        await writeFile(`${path}.gz`, gz, { flag: "wx", mode: 0o400 });
        compressed.push({
          source: segment.source,
          stream: segment.stream,
          eventCount: segment.eventCount,
          uncompressedBytes: segment.byteCount,
          uncompressedSha256: segment.sha256,
          compressedBytes: gz.byteLength,
          compressedSha256: createHash("sha256").update(gz).digest("hex"),
          compressionRatio: gz.byteLength / segment.byteCount,
        });
      }
    }
    return compressed;
  }

  get usedRawBytes(): number {
    return this.#budget?.used ?? 0;
  }
}

class RuntimeState {
  currentMarket: PublicBtcFiveMinuteMarket | null = null;
  nextMarket: PublicBtcFiveMinuteMarket | null = null;
  orderBook: PublicOrderBook | null = null;
  chainlink: PriceState | null = null;
  polymarketBinance: PriceState | null = null;
  spot: BookTickerState | null = null;
  perpetual: BookTickerState | null = null;
  previousSpot: BookTickerState | null = null;
  staleCount = 0;
  readonly opportunities = new Map<ObserverName, number>();
  readonly opportunityDurations: number[] = [];
  readonly paperAudits: PaperAudit[] = [];
}

function newStats(): Record<StreamName, StreamStats> {
  const create = (): StreamStats => ({ events: 0, payloadBytes: 0, reconnects: 0, quarantines: 0, latencies: [] });
  return {
    gamma: create(),
    clob: create(),
    chainlink: create(),
    polymarket_binance: create(),
    binance_spot: create(),
    binance_perpetual: create(),
  };
}

function observe(stats: StreamStats, raw: string, receiveTime: string, referenceTime: string | null): void {
  stats.events += 1;
  stats.payloadBytes += payloadBytes(raw);
  if (referenceTime !== null) stats.latencies.push(Date.parse(receiveTime) - Date.parse(referenceTime));
}

async function discover(epoch: number, recorder: RuntimeRecorder, stats: StreamStats): Promise<PublicBtcFiveMinuteMarket | null> {
  const slug = `btc-updown-5m-${epoch}`;
  const response = await fetchPublicMarketBySlug(slug, { timeoutMilliseconds: 10_000, maxResponseBytes: 2 * 1024 * 1024 });
  observe(stats, response.rawPayload, response.receiveTime, null);
  let market: PublicBtcFiveMinuteMarket | null = null;
  let status: ParserStatus = "parsed";
  let error: string | null = null;
  try {
    if (response.status !== 200) throw new Error(`Gamma HTTP ${response.status}`);
    market = validatePublicBtcFiveMinuteMarket(response.rawPayload);
  } catch (reason) {
    status = response.status === 404 ? "unparsed" : "error";
    error = status === "error" ? (reason instanceof Error ? reason.message : String(reason)) : null;
    if (status !== "unparsed") stats.quarantines += 1;
  }
  await recorder.raw("gamma", {
    eventType: market === null ? "market_unavailable" : "market_metadata",
    rawPayload: response.rawPayload,
    receiveTime: response.receiveTime,
    market,
    parserStatus: status,
    parserError: error,
    connectionId: `gamma-http-${slug}`,
  });
  return market;
}

interface SocketPlan {
  readonly stream: StreamName;
  readonly url: string;
  readonly subscription: Readonly<Record<string, unknown>> | null;
  readonly heartbeatMilliseconds: number | null;
  readonly market: PublicBtcFiveMinuteMarket | null;
  readonly until: number;
  readonly connectionId?: string;
  readonly handle: (raw: string, receiveTime: string, connectionId: string) => Promise<void>;
}

async function socketOnce(plan: SocketPlan, stats: StreamStats): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    const socket = new WebSocket(plan.url);
    const connectionId = plan.connectionId ?? `${plan.stream}-${randomUUID()}`;
    let settled = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let chain = Promise.resolve();
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(endTimer);
      if (heartbeat !== null) clearInterval(heartbeat);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, "bounded research runtime interval complete");
      }
      void chain.finally(resolvePromise);
    };
    const endTimer = setTimeout(finish, Math.max(1, plan.until - Date.now()));
    socket.addEventListener("open", () => {
      if (plan.subscription !== null) socket.send(JSON.stringify(plan.subscription));
      if (plan.heartbeatMilliseconds !== null) {
        heartbeat = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send("PING");
        }, plan.heartbeatMilliseconds);
      }
    });
    socket.addEventListener("message", (event) => {
      if (settled || typeof event.data !== "string" || event.data === "PONG") return;
      const receiveTime = new Date().toISOString();
      chain = chain.then(() => plan.handle(event.data as string, receiveTime, connectionId));
      void chain.catch(() => {
        stats.quarantines += 1;
      });
    });
    socket.addEventListener("error", finish);
    socket.addEventListener("close", finish);
  });
}

async function reconnectingSocket(plan: Omit<SocketPlan, "until">, end: number, stats: StreamStats, recorder: RuntimeRecorder): Promise<void> {
  let first = true;
  while (Date.now() < end && !recorder.stoppedByLimit) {
    if (!first) stats.reconnects += 1;
    first = false;
    await socketOnce({ ...plan, until: end }, stats);
    if (Date.now() < end) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
}

function directTicker(raw: string, receiveTime: string): BookTickerState {
  const value = JSON.parse(raw) as Record<string, unknown>;
  for (const key of ["b", "B", "a", "A", "s"]) {
    if (typeof value[key] !== "string") throw new Error(`bookTicker.${key} is required`);
  }
  if (value.s !== "BTCUSDT") throw new Error("bookTicker symbol is not BTCUSDT");
  const bid = value.b as string;
  const ask = value.a as string;
  return {
    value: String((Number(bid) + Number(ask)) / 2),
    bid,
    bidSize: value.B as string,
    ask,
    askSize: value.A as string,
    sourceTime: isoFromMilliseconds(value.T),
    serverTime: isoFromMilliseconds(value.E),
    receiveTime,
  };
}

function clobHandler(state: RuntimeState, recorder: RuntimeRecorder, stats: StreamStats, market: PublicBtcFiveMinuteMarket) {
  return async (raw: string, receiveTime: string, connectionId: string): Promise<void> => {
    observe(stats, raw, receiveTime, null);
    const parsed = parseClobMarketFrame(raw);
    let status: ParserStatus = parsed.shape === "error" ? "error" : "parsed";
    let error = parsed.parserError;
    for (const message of parsed.messages) {
      if (message.parserStatus === "error") {
        status = "error";
        error ??= message.parserError;
        continue;
      }
      try {
        if (message.eventType === "book") state.orderBook?.applySnapshot(message, connectionId, receiveTime);
        else if (message.eventType === "price_change" && state.orderBook?.allExpectedAssetsReady) {
          state.orderBook.applyPriceChange(message, connectionId, receiveTime);
        }
      } catch (reason) {
        status = "quarantined";
        stats.quarantines += 1;
        error = reason instanceof Error ? reason.message : String(reason);
      }
    }
    await recorder.raw("clob", {
      eventType: parsed.messages[0]?.eventType ?? "clob_batch_unverified",
      rawPayload: raw,
      receiveTime,
      market,
      parserStatus: status,
      parserError: status === "error" ? (error ?? "CLOB parse failed") : null,
      connectionId,
    });
  };
}

function rtdsHandler(source: "chainlink" | "binance", state: RuntimeState, recorder: RuntimeRecorder, stats: StreamStats) {
  const stream: StreamName = source === "chainlink" ? "chainlink" : "polymarket_binance";
  return async (raw: string, receiveTime: string, connectionId: string): Promise<void> => {
    const parsed = parseRtdsPriceMessage(raw, source);
    observe(stats, raw, receiveTime, parsed.serverTime ?? parsed.sourceTime);
    if (parsed.parserStatus === "parsed" && parsed.valueDecimal !== null) {
      const price = { value: parsed.valueDecimal, sourceTime: parsed.sourceTime, serverTime: parsed.serverTime, receiveTime };
      if (source === "chainlink") state.chainlink = price;
      else state.polymarketBinance = price;
    } else if (parsed.parserStatus === "quarantined" || parsed.parserStatus === "error") {
      stats.quarantines += 1;
    }
    await recorder.raw(stream, {
      eventType: parsed.eventType,
      rawPayload: raw,
      receiveTime,
      sourceTime: parsed.sourceTime,
      serverTime: parsed.serverTime,
      parserStatus: parsed.parserStatus,
      parserError: parsed.parserError,
      connectionId,
    });
  };
}

function directHandler(stream: "binance_spot" | "binance_perpetual", state: RuntimeState, recorder: RuntimeRecorder, stats: StreamStats) {
  return async (raw: string, receiveTime: string, connectionId: string): Promise<void> => {
    try {
      const ticker = directTicker(raw, receiveTime);
      observe(stats, raw, receiveTime, ticker.serverTime ?? ticker.sourceTime);
      if (stream === "binance_spot") {
        state.previousSpot = state.spot;
        state.spot = ticker;
      } else state.perpetual = ticker;
      await recorder.raw(stream, {
        eventType: "book_ticker",
        rawPayload: raw,
        receiveTime,
        sourceTime: ticker.sourceTime,
        serverTime: ticker.serverTime,
        sourceSequence: (JSON.parse(raw) as Record<string, unknown>).u?.toString() ?? null,
        parserStatus: "parsed",
        connectionId,
      });
    } catch (reason) {
      stats.quarantines += 1;
      await recorder.raw(stream, {
        eventType: "book_ticker_parse_error",
        rawPayload: raw,
        receiveTime,
        parserStatus: "error",
        parserError: reason instanceof Error ? reason.message : String(reason),
        connectionId,
      });
    }
  };
}

async function marketLoop(end: number, state: RuntimeState, recorder: RuntimeRecorder, stats: Record<StreamName, StreamStats>): Promise<void> {
  while (Date.now() < end && !recorder.stoppedByLimit) {
    const epoch = Math.floor(Date.now() / 300_000) * 300;
    const current = await discover(epoch, recorder, stats.gamma);
    const next = await discover(epoch + 300, recorder, stats.gamma);
    const chosen = current?.collectible === true ? current : next?.collectible === true ? next : null;
    state.currentMarket = chosen;
    state.nextMarket = chosen === current ? next : await discover(epoch + 600, recorder, stats.gamma);
    if (chosen === null) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
      continue;
    }
    state.orderBook = new PublicOrderBook({
      expectedConditionId: chosen.conditionId,
      expectedAssetIds: [chosen.upTokenId, chosen.downTokenId],
      staleAfterMilliseconds: 5_000,
    });
    const marketEnd = Math.min(end, Date.parse(chosen.intervalEnd));
    let first = true;
    while (Date.now() < marketEnd && !recorder.stoppedByLimit) {
      if (!first) stats.clob.reconnects += 1;
      first = false;
      const connectionId = `clob-${randomUUID()}`;
      state.orderBook.connected(connectionId, new Date().toISOString());
      await socketOnce({
        stream: "clob",
        url: PUBLIC_ENDPOINTS.clobMarketWebSocket,
        subscription: clobMarketSubscription([chosen.upTokenId, chosen.downTokenId]),
        heartbeatMilliseconds: 10_000,
        market: chosen,
        until: marketEnd,
        connectionId,
        handle: clobHandler(state, recorder, stats.clob, chosen),
      }, stats.clob);
      state.orderBook.disconnected();
      if (Date.now() < marketEnd) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    }
  }
}

function snapshot(state: RuntimeState): PaperSnapshot | null {
  const market = state.currentMarket;
  const book = state.orderBook;
  if (market === null || book === null || book.state !== BookState.ACTIVE_UNVERIFIED) return null;
  const values = {
    upBid: book.bestBid(market.upTokenId),
    upAsk: book.bestAsk(market.upTokenId),
    upBidSize: book.bestBidSize(market.upTokenId),
    upAskSize: book.bestAskSize(market.upTokenId),
    downBid: book.bestBid(market.downTokenId),
    downAsk: book.bestAsk(market.downTokenId),
    downBidSize: book.bestBidSize(market.downTokenId),
    downAskSize: book.bestAskSize(market.downTokenId),
  };
  if (Object.values(values).some((value) => value === null)) return null;
  return {
    observedAt: new Date().toISOString(),
    marketId: market.marketId,
    up: { bid: values.upBid!, ask: values.upAsk!, bidSize: values.upBidSize!, askSize: values.upAskSize! },
    down: { bid: values.downBid!, ask: values.downAsk!, bidSize: values.downBidSize!, askSize: values.downAskSize! },
    chainlink: state.chainlink?.value ?? null,
    binanceSpot: state.spot?.value ?? state.polymarketBinance?.value ?? null,
    binancePerpetual: state.perpetual?.value ?? null,
    continuity: "UNVERIFIED",
  };
}

function opportunityAudits(value: PaperSnapshot, state: RuntimeState): readonly PaperAudit[] {
  const complete = completeSetArbitrageObserver(value, { feeRate: "0.07", latencyMilliseconds: 1_000 });
  let change = "0";
  if (state.spot !== null && state.previousSpot !== null) {
    change = String(((Number(state.spot.value) / Number(state.previousSpot.value)) - 1) * 10_000);
  }
  const leadLag = leadLagObserver(value, { referenceChangeBps: change, thresholdBps: "5" });
  const maker = makerEnvelopeObserver(value, { markoutPrice: state.previousSpot === null ? null : value.up.bid });
  return [noTradeObserver(value), complete, leadLag, maker];
}

function trackOpportunities(audits: readonly PaperAudit[], state: RuntimeState, now: number): void {
  const active = new Set(
    audits
      .filter((audit) => audit.fills.length > 0 || audit.details.detected === true)
      .map((audit) => audit.observer),
  );
  for (const name of active) if (!state.opportunities.has(name)) state.opportunities.set(name, now);
  for (const [name, started] of state.opportunities) {
    if (!active.has(name)) {
      state.opportunityDurations.push(now - started);
      state.opportunities.delete(name);
    }
  }
}

async function dashboardLoop(config: RuntimeOptions, end: number, started: number, state: RuntimeState, recorder: RuntimeRecorder, stats: Record<StreamName, StreamStats>): Promise<void> {
  let previousBookState: BookState | null = null;
  while (Date.now() < end && !recorder.stoppedByLimit) {
    const now = new Date().toISOString();
    const bookState = state.orderBook?.state ?? BookState.DISCONNECTED;
    state.orderBook?.markStaleIfExpired(now);
    if (bookState === BookState.STALE && previousBookState !== BookState.STALE) state.staleCount += 1;
    previousBookState = bookState;
    const paperSnapshot = snapshot(state);
    const audits = paperSnapshot === null ? [] : opportunityAudits(paperSnapshot, state);
    trackOpportunities(audits, state, Date.now());
    if (config.mode === "paper") state.paperAudits.push(...audits);
    const storage = config.outputPath === null ? null : await statfs(config.outputPath);
    const elapsedHours = Math.max((Date.now() - started) / 3_600_000, 1 / 3_600_000);
    const view = {
      type: "runtime_snapshot",
      at: now,
      mode: config.mode,
      currentMarket: state.currentMarket?.slug ?? null,
      nextMarket: state.nextMarket?.slug ?? null,
      bookState: state.orderBook?.state ?? "DISCONNECTED",
      snapshotReady: paperSnapshot !== null,
      continuity: "UNVERIFIED",
      up: paperSnapshot?.up ?? null,
      down: paperSnapshot?.down ?? null,
      chainlink: state.chainlink?.value ?? null,
      binanceSpot: state.spot?.value ?? state.polymarketBinance?.value ?? null,
      binancePerpetual: state.perpetual?.value ?? null,
      latency: Object.fromEntries(STREAMS.map((name) => [name, { p50Ms: percentile(stats[name].latencies, 0.5), p95Ms: percentile(stats[name].latencies, 0.95) }])),
      opportunities: audits,
      diskFreeBytes: storage === null ? null : storage.bavail * storage.bsize,
      rawWriteBytesPerHour: recorder.usedRawBytes / elapsedHours,
    };
    recorder.metric(view);
    if (config.json || !process.stdout.isTTY) process.stdout.write(`${JSON.stringify(view)}\n`);
    else {
      process.stdout.write(`\u001b[2J\u001b[Hpoly-lab ${config.mode}  ${now}\nmarket ${view.currentMarket ?? "unavailable"}  next ${view.nextMarket ?? "unavailable"}\nbook ${view.bookState} continuity UNVERIFIED\nUP ${paperSnapshot?.up.bid ?? "-"}/${paperSnapshot?.up.ask ?? "-"}  DOWN ${paperSnapshot?.down.bid ?? "-"}/${paperSnapshot?.down.ask ?? "-"}\nChainlink ${view.chainlink ?? "-"}  Binance spot ${view.binanceSpot ?? "-"}  perpetual ${view.binancePerpetual ?? "-"}\nopportunities ${audits.filter((audit) => audit.fills.length || audit.details.detected === true).length}  raw bytes ${recorder.usedRawBytes}\n`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
}

async function main(): Promise<void> {
  const config = await options();
  const runId = `runtime-${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const recorder = new RuntimeRecorder(config, runId);
  await recorder.open();
  const state = new RuntimeState();
  const stats = newStats();
  const started = Date.now();
  const end = started + config.durationMilliseconds;
  const external = [
    reconnectingSocket({
      stream: "chainlink",
      url: PUBLIC_ENDPOINTS.rtdsWebSocket,
      subscription: rtdsSubscription("chainlink"),
      heartbeatMilliseconds: 5_000,
      market: null,
      handle: rtdsHandler("chainlink", state, recorder, stats.chainlink),
    }, end, stats.chainlink, recorder),
    reconnectingSocket({
      stream: "polymarket_binance",
      url: PUBLIC_ENDPOINTS.rtdsWebSocket,
      subscription: rtdsSubscription("binance"),
      heartbeatMilliseconds: 5_000,
      market: null,
      handle: rtdsHandler("binance", state, recorder, stats.polymarket_binance),
    }, end, stats.polymarket_binance, recorder),
    reconnectingSocket({
      stream: "binance_spot",
      url: "wss://data-stream.binance.vision/ws/btcusdt@bookTicker",
      subscription: null,
      heartbeatMilliseconds: null,
      market: null,
      handle: directHandler("binance_spot", state, recorder, stats.binance_spot),
    }, end, stats.binance_spot, recorder),
    reconnectingSocket({
      stream: "binance_perpetual",
      url: "wss://fstream.binance.com/ws/btcusdt@bookTicker",
      subscription: null,
      heartbeatMilliseconds: null,
      market: null,
      handle: directHandler("binance_perpetual", state, recorder, stats.binance_perpetual),
    }, end, stats.binance_perpetual, recorder),
  ];
  await Promise.all([marketLoop(end, state, recorder, stats), dashboardLoop(config, end, started, state, recorder, stats), ...external]);
  for (const startedAt of state.opportunities.values()) state.opportunityDurations.push(Date.now() - startedAt);
  const segments = await recorder.close();
  const elapsedSeconds = (Date.now() - started) / 1_000;
  const totalUncompressed = segments.reduce((sum, item) => sum + item.uncompressedBytes, 0);
  const totalCompressed = segments.reduce((sum, item) => sum + item.compressedBytes, 0);
  const rawBytesPerHour = elapsedSeconds > 0 ? totalUncompressed * 3_600 / elapsedSeconds : 0;
  const projectedGiBDay = rawBytesPerHour * 24 / 1024 ** 3;
  const summary = {
    type: "runtime_summary",
    runId,
    mode: config.mode,
    recordMode: config.record.mode,
    startedAt: new Date(started).toISOString(),
    endedAt: new Date().toISOString(),
    elapsedSeconds,
    stoppedByByteLimit: recorder.stoppedByLimit,
    stoppedByDuration: !recorder.stoppedByLimit,
    streams: Object.fromEntries(STREAMS.map((name) => [name, {
      events: stats[name].events,
      payloadBytes: stats[name].payloadBytes,
      eventsPerHour: stats[name].events * 3_600 / elapsedSeconds,
      payloadBytesPerHour: stats[name].payloadBytes * 3_600 / elapsedSeconds,
      reconnects: stats[name].reconnects,
      quarantines: stats[name].quarantines,
      receiveLatencyP50Ms: percentile(stats[name].latencies, 0.5),
      receiveLatencyP95Ms: percentile(stats[name].latencies, 0.95),
    }])),
    staleCount: state.staleCount,
    opportunityDurationMilliseconds: state.opportunityDurations,
    paperAuditCount: state.paperAudits.length,
    theoreticalFillCount: state.paperAudits.flatMap((audit) => audit.fills).length,
    realOrderCount: 0,
    raw: {
      segments,
      totalUncompressedBytes: totalUncompressed,
      totalCompressedBytes: totalCompressed,
      compressionRatio: totalUncompressed ? totalCompressed / totalUncompressed : null,
      bytesPerHour: rawBytesPerHour,
      projectedGiBPerDay: projectedGiBDay,
      projectedGiB7Days: projectedGiBDay * 7,
      projectedGiB14Days: projectedGiBDay * 14,
    },
    safety: {
      liveClientConstructed: false,
      userChannelConnected: false,
      credentialsRead: false,
      ordersSent: 0,
      minimumFreeBytes: MIN_FREE_BYTES,
    },
    collectorGitCommit: config.collectorGitCommit,
  };
  if (config.summaryPath !== null) await writeFile(config.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o400 });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

await main();
