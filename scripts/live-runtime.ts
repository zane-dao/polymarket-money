import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, statfs, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import { BookState, PublicOrderBook } from "../execution/src/adapters/market-data/book-state.js";
import {
  canonicalDecimalString,
  parseClobMarketFrame,
  parseRtdsPriceMessage,
} from "../execution/src/adapters/market-data/parsers.js";
import {
  createKJOfficialSettlementFromGamma,
  GammaResolutionPending,
} from "../execution/src/adapters/settlement/gamma-resolution.js";
import {
  capturePublicSocket,
  clobMarketSubscription,
  fetchPublicMarketBySlug,
  publicReceiveClock,
  rtdsSubscription,
  validatePublicBtcFiveMinuteMarket,
  type PublicBtcFiveMinuteMarket,
  type PublicSocketRequest,
} from "../execution/src/adapters/market-data/public-sources.js";
import { createEnvelopeDraftV2, rawSha256, type ParserStatus } from "../execution/src/domain/raw-event.js";
import type { ReceiveStamp } from "../execution/src/domain/receive-time.js";
import { Money } from "../execution/src/domain/money.js";
import {
  canonicalOpportunityFacts,
  createOpportunityObservationV1,
  createRouteEvaluationV1,
  type OpportunityObservationV1,
  type RouteEvaluationV1,
} from "../execution/src/domain/opportunity-observation.js";
import { FeeEdgeCalculator } from "../execution/src/runtime/fee-edge.js";
import { classifyClobBookObservation } from "../execution/src/runtime/clob-book-observation.js";
import {
  createOpportunityRuntimeConfig,
  type OpportunityRuntimeConfig,
} from "../execution/src/runtime/opportunity-config.js";
import {
  createRuntimeIncident,
  FailClosedRuntime,
  type EmergencyTerminalReceipt,
  type RuntimeIncidentV1,
} from "../execution/src/runtime/incidents.js";
import {
  DEFAULT_LEAD_LAG_CONFIG,
  LeadLagEngine,
  externalConnectionId,
  polymarketConnectionId,
  type HorizonObservation,
  type LeadLagSource,
  type LeadLagStamp,
  type LeadLagTrigger,
  type TriggerRejection,
} from "../execution/src/runtime/lead-lag.js";
import {
  completeSetArbitrageObserver,
  makerEnvelopeObserver,
  noTradeObserver,
  type PaperAudit,
  type PaperSnapshot,
  type ObserverName,
} from "../execution/src/runtime/paper.js";
import { createKJStrategyContext } from "../execution/src/strategy/kj-context.js";
import {
  KJ_PAPER_ENGINE_VERSION,
  KJPaperEngine,
} from "../execution/src/runtime/kj-paper-engine.js";
import {
  MIN_FREE_BYTES,
  SharedByteBudget,
  validateRecordingOptions,
  type RecordMode,
  type RecordingOptions,
} from "../execution/src/runtime/recording.js";
import { loadR2Preregistration, type R2Preregistration } from "../execution/src/runtime/r2-preregistration.js";
import {
  RawByteLimitReached,
  DatasetManifestWriter,
  RawSegmentWriter,
  type ClosedSegment,
} from "../execution/src/storage/raw-segment.js";
import { KJPaperJournal } from "../execution/src/storage/kj-paper-journal.js";

type Mode = "monitor" | "paper";
type StreamName = "clob" | "chainlink" | "polymarket_binance" | "binance_spot" | "binance_perpetual" | "gamma";
type KJSignalSource = "BINANCE_SPOT" | "CHAINLINK";

interface RuntimeOptions {
  readonly mode: Mode;
  readonly durationMilliseconds: number;
  readonly record: RecordingOptions;
  readonly outputPath: string | null;
  readonly summaryPath: string | null;
  readonly kjPaperJournalPath: string | null;
  readonly kjSettlementGraceMilliseconds: number;
  readonly kjMarketStartAtMilliseconds: number | null;
  readonly kjMarketStartBeforeMilliseconds: number | null;
  readonly kjSignalSource: KJSignalSource;
  readonly json: boolean;
  readonly collectorGitCommit: string;
  readonly preregistration: R2Preregistration | null;
}

interface StreamStats {
  events: number;
  payloadBytes: number;
  reconnects: number;
  quarantines: number;
  providerToLocalWallDeltas: number[];
}

interface PriceState {
  value: string;
  sourceTime: string | null;
  serverTime: string | null;
  receiveTime: string;
  receiveStamp: ReceiveStamp;
  connectionId: string;
  externalEventId: string;
  parentInputReference: string;
  inputHash: string;
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

class RuntimeStorageError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "RuntimeStorageError";
  }
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

function leadLagStamp(receiveStamp: ReceiveStamp): LeadLagStamp {
  return Object.freeze({
    clock_domain: receiveStamp.clockDomain,
    local_monotonic_receive_ns: receiveStamp.localMonotonicReceiveNs,
    local_receive_ordinal: receiveStamp.localReceiveOrdinal,
  });
}

function sourceForStream(stream: Exclude<StreamName, "gamma" | "clob">): LeadLagSource {
  if (stream === "chainlink") return "POLYMARKET_RTDS_CHAINLINK";
  if (stream === "polymarket_binance") return "POLYMARKET_RTDS_BINANCE";
  if (stream === "binance_spot") return "BINANCE_SPOT";
  return "BINANCE_PERPETUAL";
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
    const linuxFreeBytes = storage.bavail * storage.bsize;
    const windowsD = process.env.WSL_DISTRO_NAME === undefined
      ? null
      : await statfs("/mnt/d").catch((storageError) => {
          process.stderr.write(`Windows storage binding unavailable: ${String(storageError)}\n`);
          return null;
        });
    const bindingFreeBytes = windowsD === null
      ? linuxFreeBytes
      : Math.min(linuxFreeBytes, windowsD.bavail * windowsD.bsize);
    record = validateRecordingOptions({
      mode: "raw",
      durationMilliseconds: durationSeconds * 1_000,
      maxBytes: positiveInteger(argument("--max-bytes"), "max-bytes"),
      outputPath: outputPath!,
      filesystemType: await filesystemType(outputPath!),
      freeBytes: bindingFreeBytes,
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
  const experimentConfigPath = argument("--experiment-config");
  const preregistration = experimentConfigPath === undefined
    ? null
    : await loadR2Preregistration(resolve(experimentConfigPath));
  if (preregistration !== null) {
    if (recordMode !== "metrics") throw new Error("R2 preregistration requires record=metrics");
    if (mode !== "paper") throw new Error("R2 preregistration requires observer-only paper mode");
    if (durationSeconds !== preregistration.maximum_runtime_minutes * 60) throw new Error("R2 duration differs from frozen maximum_runtime_minutes");
    const dataRoot = process.env.POLY_DATA_ROOT;
    if (dataRoot === undefined || dataRoot.length === 0) throw new Error("POLY_DATA_ROOT is required for R2");
    const expectedOutput = resolve(dataRoot, "experiments", preregistration.experiment_id);
    if (outputPath !== expectedOutput) throw new Error("R2 output differs from the frozen output_path");
  }
  const configuredKJJournal = argument("--kj-paper-journal");
  if (configuredKJJournal !== undefined && !isAbsolute(configuredKJJournal)) {
    throw new Error("--kj-paper-journal must be an absolute path");
  }
  const kjPaperJournalPath = configuredKJJournal === undefined
    ? null
    : resolve(configuredKJJournal);
  if (kjPaperJournalPath !== null && mode !== "paper") {
    throw new Error("--kj-paper-journal is available only in paper mode");
  }
  if (kjPaperJournalPath !== null && preregistration !== null) {
    throw new Error("frozen R2 sessions cannot enable the K/J paper journal");
  }
  const configuredKJSignalSource = argument("--kj-signal-source") ?? "binance";
  const kjSignalSource: KJSignalSource = configuredKJSignalSource === "binance"
    ? "BINANCE_SPOT"
    : configuredKJSignalSource === "chainlink"
      ? "CHAINLINK"
      : (() => { throw new Error("--kj-signal-source must be binance or chainlink"); })();
  if (argument("--kj-signal-source") !== undefined && kjPaperJournalPath === null) {
    throw new Error("--kj-signal-source requires --kj-paper-journal");
  }
  const settlementGraceValue = argument("--settlement-grace-seconds");
  if (settlementGraceValue !== undefined && kjPaperJournalPath === null) {
    throw new Error("--settlement-grace-seconds requires --kj-paper-journal");
  }
  const settlementGraceSeconds = kjPaperJournalPath === null
    ? 0
    : positiveInteger(settlementGraceValue ?? "600", "settlement-grace-seconds");
  if (settlementGraceSeconds > 1_800) {
    throw new Error("settlement-grace-seconds must not exceed 1800");
  }
  const marketStartAtValue = argument("--kj-market-start-at");
  if (marketStartAtValue !== undefined && kjPaperJournalPath === null) {
    throw new Error("--kj-market-start-at requires --kj-paper-journal");
  }
  const marketStartAt = marketStartAtValue === undefined ? null : Date.parse(marketStartAtValue);
  if (marketStartAtValue !== undefined && (!marketStartAtValue.endsWith("Z") || !Number.isFinite(marketStartAt))) {
    throw new Error("--kj-market-start-at must be explicit UTC");
  }
  const marketStartBeforeValue = argument("--kj-market-start-before");
  if (marketStartBeforeValue !== undefined && kjPaperJournalPath === null) {
    throw new Error("--kj-market-start-before requires --kj-paper-journal");
  }
  const marketStartBefore = marketStartBeforeValue === undefined
    ? null
    : Date.parse(marketStartBeforeValue);
  if (marketStartBeforeValue !== undefined && (
    !marketStartBeforeValue.endsWith("Z") || !Number.isFinite(marketStartBefore)
  )) {
    throw new Error("--kj-market-start-before must be explicit UTC");
  }
  return {
    mode,
    durationMilliseconds: durationSeconds * 1_000,
    record,
    outputPath,
    summaryPath: argument("--summary") === undefined ? null : resolve(argument("--summary")!),
    kjPaperJournalPath,
    kjSettlementGraceMilliseconds: settlementGraceSeconds * 1_000,
    kjMarketStartAtMilliseconds: marketStartAt,
    kjMarketStartBeforeMilliseconds: marketStartBefore,
    kjSignalSource,
    json: process.argv.includes("--json"),
    collectorGitCommit: commit,
    preregistration,
  };
}

class RuntimeRecorder {
  readonly #config: RuntimeOptions;
  readonly #runId: string;
  readonly #budget: SharedByteBudget | null;
  readonly #writers = new Map<string, RawSegmentWriter>();
  readonly #gammaSlugs = new Map<string, string>();
  readonly #clobAssets = new Set<string>();
  readonly #closed: Array<{ readonly key: string; readonly stream: StreamName; readonly segment: ClosedSegment }> = [];
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
    for (const stream of STREAMS.filter((name) => name !== "gamma")) {
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
      readonly eventId?: string;
      readonly rawPayload: string;
      readonly receiveStamp: ReceiveStamp;
      readonly sourceTime?: string | null;
      readonly serverTime?: string | null;
      readonly sourceSequence?: string | null;
      readonly market?: PublicBtcFiveMinuteMarket | null;
      readonly assetId?: string | null;
      readonly marketSlug?: string | null;
      readonly parserStatus: ParserStatus;
      readonly parserError?: string | null;
      readonly connectionId: string;
    },
  ): Promise<string> {
    const eventId = input.eventId ?? randomUUID();
    if (this.#config.record.mode !== "raw" || this.stoppedByLimit) return eventId;
    if (stream === "clob" && input.market !== null && input.market !== undefined) {
      this.#clobAssets.add(input.market.upTokenId);
      this.#clobAssets.add(input.market.downTokenId);
    }
    const key = stream === "gamma" ? `gamma:${input.marketSlug ?? ""}` : stream;
    if (stream === "gamma" && input.marketSlug === undefined) {
      throw new Error("Gamma raw event requires its exact market slug");
    }
    if (stream === "gamma" && !this.#writers.has(key)) {
      this.#gammaSlugs.set(key, input.marketSlug!);
      this.#writers.set(key, await RawSegmentWriter.open({
        dataRoot: this.#config.record.outputPath,
        segmentId: `${this.#runId}-gamma-${input.marketSlug}`,
        source: "polymarket.gamma",
        stream: "market-discovery",
        partitionDate: input.receiveStamp.localWallReceiveTime.slice(0, 10),
        reserveBytes: this.#budget!.reserve,
      }));
    }
    const writer = this.#writers.get(key);
    if (writer === undefined) throw new Error(`raw writer missing for ${stream}`);
    try {
      await writer.append(createEnvelopeDraftV2({
        eventId,
        source: stream === "gamma" ? "polymarket.gamma" : stream === "clob" ? "polymarket.clob.market" : stream === "chainlink" ? "polymarket.rtds.chainlink" : stream === "polymarket_binance" ? "polymarket.rtds.binance" : stream === "binance_spot" ? "binance.spot" : "binance.perpetual",
        stream: stream === "gamma" ? "market-discovery" : stream === "clob" ? "market-channel" : stream.includes("binance_") && !stream.startsWith("polymarket") ? "book-ticker" : "crypto-prices",
        eventType: input.eventType,
        transportConnectionId: input.connectionId,
        subscriptionId: `${this.#runId}-${stream}-public-only`,
        marketId: input.market?.marketId ?? null,
        conditionId: input.market?.conditionId ?? null,
        assetId: input.assetId ?? null,
        providerSourceTime: input.sourceTime ?? null,
        providerServerTime: input.serverTime ?? null,
        receiveStamp: input.receiveStamp,
        processTime: new Date().toISOString(),
        sourceSequence: input.sourceSequence ?? null,
        rawPayload: input.rawPayload,
        parserStatus: input.parserStatus,
        parserError: input.parserError ?? null,
      }));
    } catch (error) {
      if (error instanceof RawByteLimitReached) {
        this.stoppedByLimit = true;
        return eventId;
      }
      throw new RuntimeStorageError(`raw writer failed for ${stream}`, error);
    }
    return eventId;
  }

  metric(value: Record<string, unknown>): void {
    if (this.#config.record.writesMetrics) this.#metrics.push(value);
  }

  async close(): Promise<readonly CompressedSegmentResult[]> {
    if (this.#config.record.mode === "raw") {
      for (const [key, writer] of this.#writers) {
        try {
          const segment = await writer.close();
          const stream = key.startsWith("gamma:") ? "gamma" : key as StreamName;
          this.#closed.push({ key, stream, segment });
        } catch (error) {
          try {
            await writer.leaveIncomplete();
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "segment close and incomplete cleanup both failed");
          }
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
      const manifestWriter = new DatasetManifestWriter(this.#config.record.outputPath);
      for (const closed of this.#closed) {
        const { segment } = closed;
        const subscription = closed.stream === "gamma"
          ? { endpoint: "gamma-market-by-slug", slug: this.#gammaSlugs.get(closed.key)! }
          : closed.stream === "clob"
            ? clobMarketSubscription([...this.#clobAssets])
            : closed.stream === "chainlink"
              ? rtdsSubscription("chainlink")
              : closed.stream === "polymarket_binance"
                ? rtdsSubscription("binance")
                : { endpoint: "market-data-only", stream: "bookTicker", symbol: "btcusdt" };
        await manifestWriter.publish({
          datasetId: `${segment.segmentId}-dataset`,
          source: segment.source,
          stream: segment.stream,
          subscription,
          collectorGitCommit: this.#config.collectorGitCommit,
          collectionStart: segment.firstReceiveTime,
          collectionEnd: segment.lastReceiveTime,
          segments: [segment],
          sanitizedConfig: {
            endpointClass: "public-read-only",
            ...(["polymarket.rtds.binance", "binance.spot", "binance.perpetual"].includes(segment.source)
              ? { symbolFilter: "btcusdt" }
              : {}),
            ...(segment.source === "polymarket.rtds.binance" ? { transportScope: "btc-only" } : {}),
            ...(segment.source === "polymarket.rtds.chainlink" ? { symbolFilter: "btc/usd" } : {}),
          },
        });
        const path = join(this.#config.record.outputPath, ...segment.relativePath.split("/"));
        const hash = createHash("sha256");
        let compressedBytes = 0;
        const sink = new Writable({
          write(chunk: Buffer, _encoding, callback) {
            compressedBytes += chunk.byteLength;
            hash.update(chunk);
            callback();
          },
        });
        await pipeline(createReadStream(path), createGzip({ level: 6 }), sink);
        compressed.push({
          source: segment.source,
          stream: segment.stream,
          eventCount: segment.eventCount,
          uncompressedBytes: segment.byteCount,
          uncompressedSha256: segment.sha256,
          compressedBytes,
          compressedSha256: hash.digest("hex"),
          compressionRatio: compressedBytes / segment.byteCount,
        });
      }
    }
    return compressed;
  }

  get usedRawBytes(): number {
    return this.#budget?.used ?? 0;
  }
}

class RuntimeIncidentFileWriter {
  readonly #path: string;

  constructor(directory: string, runId: string) {
    this.#path = join(directory, `${runId}-runtime-incidents.jsonl`);
  }

  write(incident: RuntimeIncidentV1): Promise<void> {
    return appendFile(this.#path, `${JSON.stringify(incident)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

class EmergencyReceiptFileSink {
  readonly #path: string;

  constructor(directory: string, runId: string) {
    this.#path = join(directory, `${runId}-terminal-failure.json`);
  }

  write(receipt: EmergencyTerminalReceipt): Promise<void> {
    return writeFile(this.#path, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o400 });
  }
}

class RuntimeState {
  readonly sessionId: string;
  readonly gitCommit: string;
  currentMarket: PublicBtcFiveMinuteMarket | null = null;
  nextMarket: PublicBtcFiveMinuteMarket | null = null;
  orderBook: PublicOrderBook | null = null;
  chainlink: PriceState | null = null;
  polymarketBinance: PriceState | null = null;
  spot: BookTickerState | null = null;
  perpetual: BookTickerState | null = null;
  readonly leadLagEngine = new LeadLagEngine(DEFAULT_LEAD_LAG_CONFIG);
  readonly horizonObservations: HorizonObservation[] = [];
  readonly leadLagObservations: OpportunityObservationV1[] = [];
  readonly observations: OpportunityObservationV1[] = [];
  readonly routeEvaluations: RouteEvaluationV1[] = [];
  readonly horizonTimers = new Set<ReturnType<typeof setTimeout>>();
  readonly maintenanceTimers = new Set<ReturnType<typeof setTimeout>>();
  readonly leadLagMarketIds = new Set<string>();
  readonly triggerRejections: TriggerRejection[] = [];
  rawTriggerCount = 0;
  latestPolymarketInput: {
    readonly parentInputReference: string;
    readonly inputHash: string;
    readonly receiveStamp: ReceiveStamp;
  } | null = null;
  staleCount = 0;
  readonly opportunities = new Map<ObserverName, number>();
  readonly opportunityDurations: number[] = [];
  readonly paperAudits: PaperAudit[] = [];
  readonly kjPaperJournal: KJPaperJournal | null;
  readonly kjPaperEngine: KJPaperEngine | null;
  kjPaperEventCursor: number;
  readonly kjSettlementCandidates = new Map<string, PublicBtcFiveMinuteMarket>();
  readonly kjSettlementAttempts = new Map<string, number>();
  kjSettledMarketCount = 0;
  readonly opportunityConfig: OpportunityRuntimeConfig;
  completeSetCandidateSince: number | null = null;

  constructor(
    sessionId: string,
    gitCommit: string,
    opportunityConfig: OpportunityRuntimeConfig,
    kjPaperJournal: KJPaperJournal | null,
  ) {
    this.sessionId = sessionId;
    this.gitCommit = gitCommit;
    this.opportunityConfig = opportunityConfig;
    this.kjPaperJournal = kjPaperJournal;
    this.kjPaperEngine = kjPaperJournal?.engine ?? null;
    this.kjPaperEventCursor = this.kjPaperEngine?.events().length ?? 0;
    for (const market of kjPaperJournal?.unsettledMarkets() ?? []) {
      this.kjSettlementCandidates.set(market.marketId, market);
    }
  }
}

function newStats(): Record<StreamName, StreamStats> {
  const create = (): StreamStats => ({
    events: 0,
    payloadBytes: 0,
    reconnects: 0,
    quarantines: 0,
    providerToLocalWallDeltas: [],
  });
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
  if (referenceTime !== null) {
    stats.providerToLocalWallDeltas.push(Date.parse(receiveTime) - Date.parse(referenceTime));
  }
}

async function discover(epoch: number, recorder: RuntimeRecorder, stats: StreamStats): Promise<PublicBtcFiveMinuteMarket | null> {
  const slug = `btc-updown-5m-${epoch}`;
  let response;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetchPublicMarketBySlug(slug, { timeoutMilliseconds: 10_000, maxResponseBytes: 2 * 1024 * 1024 });
      break;
    } catch (error) {
      stats.reconnects += 1;
      if (attempt === 3) {
        stats.quarantines += 1;
        return null;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500 * attempt));
    }
  }
  if (response === undefined) return null;
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
    receiveStamp: response.receiveStamp,
    market,
    marketSlug: slug,
    parserStatus: status,
    parserError: error,
    connectionId: `gamma-http-${slug}`,
  });
  return market;
}

interface RuntimeCapturePlan {
  readonly stream: StreamName;
  readonly request: PublicSocketRequest;
  readonly beforeAttempt?: (connectionId: string) => void;
  readonly afterAttempt?: (connectionId: string, receiveStamp: ReceiveStamp) => void;
  readonly handle: (raw: string, receiveStamp: ReceiveStamp, connectionId: string) => Promise<void>;
  readonly signal: AbortSignal;
}

async function captureUntil(
  plan: RuntimeCapturePlan,
  end: number,
  stats: StreamStats,
  recorder: RuntimeRecorder,
  failureRuntime: FailClosedRuntime,
): Promise<void> {
  let first = true;
  while (Date.now() < end && !recorder.stoppedByLimit && !failureRuntime.terminated && !plan.signal.aborted) {
    if (!first) stats.reconnects += 1;
    first = false;
    const connectionId = `${plan.stream}-${randomUUID()}`;
    const timeoutMilliseconds = Math.max(1, end - Date.now());
    plan.beforeAttempt?.(connectionId);
    try {
      await capturePublicSocket({
        ...plan.request,
        timeoutMilliseconds,
        maxFrames: 10_000_000,
        maxFrameBytes: 16 * 1024 * 1024,
        maxTotalBytes: 2 * 1024 * 1024 * 1024,
        signal: plan.signal,
        accept: async (frame) => {
          await plan.handle(frame.rawPayload, frame.receiveStamp, connectionId);
          return recorder.stoppedByLimit || Date.now() >= end || plan.signal.aborted;
        },
      });
    } catch (captureError) {
      const terminal = captureError instanceof RuntimeStorageError;
      if (!terminal && (Date.now() >= end || recorder.stoppedByLimit || plan.signal.aborted)) return;
      const received = publicReceiveClock().capture();
      const incident = createRuntimeIncident({
        errorClass: captureError instanceof Error ? captureError.name : "UnknownError",
        message: captureError instanceof Error ? captureError.message : String(captureError),
        stream: plan.stream,
        connectionRole: terminal ? "storage" : plan.stream === "clob" ? "polymarket" : "external",
        connectionId,
        receiveStamp: received,
        rawReference: null,
        actionTaken: terminal ? "TERMINATE_SESSION" : "RECONNECT",
        stopReason: terminal ? "RAW_WRITER_FAILED" : "PUBLIC_CAPTURE_RECONNECT",
      });
      if (terminal) await failureRuntime.terminate(incident);
      else await failureRuntime.recordIncident(incident);
      if (failureRuntime.terminated) return;
    } finally {
      if (plan.afterAttempt !== undefined) {
        plan.afterAttempt(connectionId, publicReceiveClock().capture());
      }
    }
    if (Date.now() < end) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
}

function directTicker(
  raw: string,
  receiveStamp: ReceiveStamp,
  connectionId: string,
  externalEventId: string,
): BookTickerState {
  const value = JSON.parse(raw) as Record<string, unknown>;
  for (const key of ["b", "B", "a", "A", "s"]) {
    if (typeof value[key] !== "string") throw new Error(`bookTicker.${key} is required`);
  }
  if (value.s !== "BTCUSDT") throw new Error("bookTicker symbol is not BTCUSDT");
  const bid = canonicalDecimalString(value.b as string);
  const ask = canonicalDecimalString(value.a as string);
  return {
    value: Money.from(bid).plus(Money.from(ask)).dividedBy(Money.from("2")).toCanonical(),
    bid,
    bidSize: value.B as string,
    ask,
    askSize: value.A as string,
    sourceTime: isoFromMilliseconds(value.T),
    serverTime: isoFromMilliseconds(value.E),
    receiveTime: receiveStamp.localWallReceiveTime,
    receiveStamp,
    connectionId,
    externalEventId,
    parentInputReference: `raw-event-v2:${externalEventId}`,
    inputHash: rawSha256(raw),
  };
}

function baselineWatermarks(receiveStamp: ReceiveStamp): Readonly<Record<"100" | "250" | "500", LeadLagStamp>> | null {
  const eventNs = BigInt(receiveStamp.localMonotonicReceiveNs);
  if (eventNs < 500_000_000n) return null;
  const target = (windowMs: 100 | 250 | 500): LeadLagStamp => Object.freeze({
    clock_domain: receiveStamp.clockDomain,
    local_monotonic_receive_ns: (eventNs - BigInt(windowMs) * 1_000_000n).toString(),
    local_receive_ordinal: receiveStamp.localReceiveOrdinal,
  });
  return Object.freeze({ "100": target(100), "250": target(250), "500": target(500) });
}

function recordLeadLagHorizonObservation(
  state: RuntimeState,
  trigger: LeadLagTrigger,
  horizon: HorizonObservation,
  observedAtWall: string,
  failureRuntime: FailClosedRuntime,
): void {
  const { next_update_after_horizon: _nextUpdate, ...fixedHorizon } = horizon;
  const polymarketParent = horizon.horizon_state_parent_input_reference
    ?? horizon.trigger_polymarket_parent_input_reference;
  const polymarketHash = horizon.horizon_state_input_hash ?? horizon.trigger_polymarket_input_hash;
  const polymarketStamp = horizon.state_observation_time ?? trigger.polymarket_snapshot_time;
  const rejectionReason = horizon.censor_reason ?? "CLOB_CONTINUITY_UNVERIFIED";
  const rejectionReasons = horizon.censor_reason === null
    ? ["CLOB_CONTINUITY_UNVERIFIED"]
    : [horizon.censor_reason, "CLOB_CONTINUITY_UNVERIFIED"];
  const opportunity = createOpportunityObservationV1({
    opportunityFamily: "CROSS_VENUE_LEAD_LAG",
    marketId: horizon.market_id,
    observedAtWall,
    receiveStamp: horizon.target_time,
    inputLineage: [{
      source: horizon.source,
      parent_input_reference: horizon.external_parent_input_reference,
      input_hash: horizon.external_input_hash,
      receive_stamp: trigger.trigger_receive_stamp,
    }, {
      source: "POLYMARKET_CLOB",
      parent_input_reference: polymarketParent,
      input_hash: polymarketHash,
      receive_stamp: polymarketStamp,
    }],
    provenance: {
      producer: "live-runtime-batch-4b-r1",
      gitCommit: state.gitCommit,
      sessionId: state.sessionId,
      configHash: state.opportunityConfig.config_hash,
    },
    quality: { status: "DEGRADED", rejectionReasons },
    feeEvidenceReference: null,
    continuity: "UNVERIFIED",
    grossEdge: null,
    scenarioNetEdge: null,
    visibleSize: "0",
    eligibility: "INELIGIBLE",
    rejectionReason,
    facts: canonicalOpportunityFacts({
      fixed_horizon: fixedHorizon as unknown as Record<string, unknown>,
      next_update_excluded_from_route_evidence: true,
    }),
  });
  failureRuntime.noteObservation();
  state.leadLagObservations.push(opportunity);
  state.observations.push(opportunity);
}

function scheduleHorizons(
  state: RuntimeState,
  trigger: LeadLagTrigger,
  failureRuntime: FailClosedRuntime,
): void {
  for (const horizonMs of DEFAULT_LEAD_LAG_CONFIG.horizons_ms) {
    const timer = setTimeout(() => {
      state.horizonTimers.delete(timer);
      void (async () => {
        if (failureRuntime.terminated) return;
        const timerStamp = publicReceiveClock().capture();
        const targetNs = BigInt(trigger.trigger_receive_stamp.local_monotonic_receive_ns)
          + BigInt(horizonMs) * 1_000_000n;
        try {
          const observation = state.leadLagEngine.evaluateHorizon({
            triggerId: trigger.trigger_id,
            horizonMs,
            targetWatermark: {
              clock_domain: trigger.clock_domain,
              local_monotonic_receive_ns: targetNs.toString(),
              local_receive_ordinal: timerStamp.localReceiveOrdinal,
            },
          });
          if (!failureRuntime.terminated) {
            state.horizonObservations.push(observation);
            recordLeadLagHorizonObservation(
              state,
              trigger,
              observation,
              timerStamp.localWallReceiveTime,
              failureRuntime,
            );
          }
        } catch (error) {
          await failureRuntime.terminate(createRuntimeIncident({
            errorClass: error instanceof Error ? error.name : "UnknownError",
            message: error instanceof Error ? error.message : String(error),
            stream: "lead-lag-horizon",
            connectionRole: "session",
            connectionId: trigger.polymarket_connection_id,
            receiveStamp: timerStamp,
            rawReference: null,
            actionTaken: "TERMINATE_SESSION",
            stopReason: "LEAD_LAG_HORIZON_EVALUATION_FAILED",
          }));
        }
      })().catch((error) => {
        process.stderr.write(`lead-lag timer terminal handler failed: ${String(error)}\n`);
        process.exitCode = 1;
      });
    }, horizonMs);
    state.horizonTimers.add(timer);
  }
}

function ingestExternalPrice(
  state: RuntimeState,
  stream: Exclude<StreamName, "gamma" | "clob">,
  price: PriceState,
  failureRuntime: FailClosedRuntime,
): void {
  const source = sourceForStream(stream);
  state.leadLagEngine.ingestExternal({
    external_event_id: price.externalEventId,
    source,
    price: canonicalDecimalString(price.value),
    receive_stamp: leadLagStamp(price.receiveStamp),
    external_connection_id: externalConnectionId(price.connectionId),
    parent_input_reference: price.parentInputReference,
    input_hash: price.inputHash,
    quality: { stale: false, disconnected: false, quarantined: false },
  });
  const market = state.currentMarket;
  const watermarks = baselineWatermarks(price.receiveStamp);
  const observedAt = Date.parse(price.receiveTime);
  if (market === null || watermarks === null
    || observedAt < Date.parse(market.intervalStart)
    || observedAt >= Date.parse(market.intervalEnd)) return;
  const batch = state.leadLagEngine.createTriggers({
    externalEventId: price.externalEventId,
    marketId: market.marketId,
    baselineWatermarks: watermarks,
  });
  state.rawTriggerCount += batch.triggers.length;
  state.triggerRejections.push(...batch.rejections);
  if (batch.triggers.length > 0) state.leadLagMarketIds.add(market.marketId);
  for (const trigger of batch.triggers) scheduleHorizons(state, trigger, failureRuntime);
}

function markExternalConnectionReset(
  state: RuntimeState,
  stream: Exclude<StreamName, "gamma" | "clob">,
  receiveStamp: ReceiveStamp,
): void {
  state.leadLagEngine.noteExternalConnectionReset({
    source: sourceForStream(stream),
    receive_stamp: leadLagStamp(receiveStamp),
  });
}

function ingestPolymarketBook(
  state: RuntimeState,
  market: PublicBtcFiveMinuteMarket,
  receiveStamp: ReceiveStamp,
  connectionId: string,
  eventId: string,
  inputHash: string,
  quarantined: boolean,
): void {
  const book = state.orderBook;
  const parentInputReference = `raw-event-v2:${eventId}`;
  const reject = (): void => state.leadLagEngine.notePolymarketQualityFailure({
    market_id: market.marketId,
    receive_stamp: leadLagStamp(receiveStamp),
    polymarket_connection_id: polymarketConnectionId(connectionId),
    parent_input_reference: parentInputReference,
    input_hash: inputHash,
  });
  if (book === null || quarantined || book.state !== BookState.ACTIVE_UNVERIFIED) {
    reject();
    return;
  }
  const bid = book.bestBid(market.upTokenId);
  const ask = book.bestAsk(market.upTokenId);
  if (bid === null || ask === null) {
    reject();
    return;
  }
  state.leadLagEngine.ingestPolymarket({
    market_id: market.marketId,
    bid,
    ask,
    mid_price: Money.from(bid).plus(Money.from(ask)).dividedBy(Money.from("2")).toCanonical(),
    receive_stamp: leadLagStamp(receiveStamp),
    polymarket_connection_id: polymarketConnectionId(connectionId),
    parent_input_reference: parentInputReference,
    input_hash: inputHash,
    quality: {
      snapshot: true,
      stale: false,
      disconnected: false,
      crossed: false,
      empty_side: false,
      quarantined: false,
    },
  });
  state.latestPolymarketInput = Object.freeze({
    parentInputReference,
    inputHash,
    receiveStamp,
  });
}

function clobHandler(
  state: RuntimeState,
  recorder: RuntimeRecorder,
  stats: StreamStats,
  market: PublicBtcFiveMinuteMarket,
  failureRuntime: FailClosedRuntime,
) {
  return async (raw: string, receiveStamp: ReceiveStamp, connectionId: string): Promise<void> => {
    const receiveTime = receiveStamp.localWallReceiveTime;
    observe(stats, raw, receiveTime, null);
    const parsed = parseClobMarketFrame(raw);
    let status: ParserStatus = parsed.shape === "error" ? "error" : "parsed";
    let error = parsed.parserError;
    let bookMutationApplied = false;
    for (const message of parsed.messages) {
      if (message.parserStatus === "error") {
        status = "error";
        error ??= message.parserError;
        continue;
      }
      try {
        if (message.eventType === "book") {
          state.orderBook?.applySnapshot(message, connectionId, receiveTime);
          bookMutationApplied = state.orderBook !== null;
        }
        else if (message.eventType === "price_change" && state.orderBook?.allExpectedAssetsReady) {
          state.orderBook.applyPriceChange(message, connectionId, receiveTime);
          bookMutationApplied = true;
        }
      } catch (reason) {
        status = "quarantined";
        stats.quarantines += 1;
        error = reason instanceof Error ? reason.message : String(reason);
      }
    }
    const eventId = randomUUID();
    await recorder.raw("clob", {
      eventId,
      eventType: parsed.messages[0]?.eventType ?? "clob_batch_unverified",
      rawPayload: raw,
      receiveStamp,
      market,
      assetId: parsed.messages[0]?.assetId ?? null,
      parserStatus: status,
      parserError: status === "error" ? (error ?? "CLOB parse failed") : null,
      connectionId,
    });
    if (!failureRuntime.terminated) {
      const inputHash = rawSha256(raw);
      const disposition = classifyClobBookObservation({
        eventTypes: parsed.messages.map((message) => message.eventType),
        parserStatus: status,
        bookMutationApplied,
      });
      if (disposition !== "IGNORE") {
        ingestPolymarketBook(
          state,
          market,
          receiveStamp,
          connectionId,
          eventId,
          inputHash,
          disposition === "INVALIDATE",
        );
      }
    }
  };
}

function rtdsHandler(
  source: "chainlink" | "binance",
  state: RuntimeState,
  recorder: RuntimeRecorder,
  stats: StreamStats,
  failureRuntime: FailClosedRuntime,
) {
  const stream: StreamName = source === "chainlink" ? "chainlink" : "polymarket_binance";
  return async (raw: string, receiveStamp: ReceiveStamp, connectionId: string): Promise<void> => {
    const receiveTime = receiveStamp.localWallReceiveTime;
    const parsed = parseRtdsPriceMessage(raw, source);
    observe(stats, raw, receiveTime, parsed.serverTime ?? parsed.sourceTime);
    if (parsed.parserStatus === "quarantined" || parsed.parserStatus === "error") {
      stats.quarantines += 1;
    }
    const eventId = randomUUID();
    await recorder.raw(stream, {
      eventId,
      eventType: parsed.eventType,
      rawPayload: raw,
      receiveStamp,
      sourceTime: parsed.sourceTime,
      serverTime: parsed.serverTime,
      parserStatus: parsed.parserStatus,
      parserError: parsed.parserError,
      connectionId,
    });
    if (parsed.parserStatus === "parsed" && parsed.valueDecimal !== null && !failureRuntime.terminated) {
      const price: PriceState = {
        value: canonicalDecimalString(parsed.valueDecimal),
        sourceTime: parsed.sourceTime,
        serverTime: parsed.serverTime,
        receiveTime,
        receiveStamp,
        connectionId,
        externalEventId: eventId,
        parentInputReference: `raw-event-v2:${eventId}`,
        inputHash: rawSha256(raw),
      };
      if (source === "chainlink") state.chainlink = price;
      else state.polymarketBinance = price;
      ingestExternalPrice(state, stream, price, failureRuntime);
    }
  };
}

function directHandler(
  stream: "binance_spot" | "binance_perpetual",
  state: RuntimeState,
  recorder: RuntimeRecorder,
  stats: StreamStats,
  failureRuntime: FailClosedRuntime,
) {
  return async (raw: string, receiveStamp: ReceiveStamp, connectionId: string): Promise<void> => {
    const receiveTime = receiveStamp.localWallReceiveTime;
    try {
      const eventId = randomUUID();
      const ticker = directTicker(raw, receiveStamp, connectionId, eventId);
      observe(stats, raw, receiveTime, ticker.serverTime ?? ticker.sourceTime);
      await recorder.raw(stream, {
        eventId,
        eventType: "book_ticker",
        rawPayload: raw,
        receiveStamp,
        sourceTime: ticker.sourceTime,
        serverTime: ticker.serverTime,
        sourceSequence: (JSON.parse(raw) as Record<string, unknown>).u?.toString() ?? null,
        parserStatus: "parsed",
        connectionId,
      });
      if (!failureRuntime.terminated) {
        if (stream === "binance_spot") state.spot = ticker;
        else state.perpetual = ticker;
        ingestExternalPrice(state, stream, ticker, failureRuntime);
      }
    } catch (reason) {
      if (reason instanceof RuntimeStorageError) throw reason;
      stats.quarantines += 1;
      await recorder.raw(stream, {
        eventType: "book_ticker_parse_error",
        rawPayload: raw,
        receiveStamp,
        parserStatus: "error",
        parserError: reason instanceof Error ? reason.message : String(reason),
        connectionId,
      });
    }
  };
}

async function marketLoop(
  end: number,
  marketStartAtMilliseconds: number | null,
  marketStartBeforeMilliseconds: number | null,
  state: RuntimeState,
  recorder: RuntimeRecorder,
  stats: Record<StreamName, StreamStats>,
  failureRuntime: FailClosedRuntime,
  signal: AbortSignal,
): Promise<void> {
  while (Date.now() < end && !recorder.stoppedByLimit && !failureRuntime.terminated && !signal.aborted) {
    const epoch = Math.floor(Date.now() / 300_000) * 300;
    const current = await discover(epoch, recorder, stats.gamma);
    const next = await discover(epoch + 300, recorder, stats.gamma);
    const chosen = current?.collectible === true ? current : next?.collectible === true ? next : null;
    if (chosen !== null && marketStartAtMilliseconds !== null
      && Date.parse(chosen.intervalStart) < marketStartAtMilliseconds) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(5_000, Math.max(0, Date.parse(chosen.intervalEnd) - Date.now()))));
      continue;
    }
    if (chosen !== null && marketStartBeforeMilliseconds !== null
      && Date.parse(chosen.intervalStart) >= marketStartBeforeMilliseconds) {
      break;
    }
    const priorMarket = state.currentMarket;
    state.currentMarket = chosen;
    state.nextMarket = chosen === current ? next : await discover(epoch + 600, recorder, stats.gamma);
    if (chosen === null) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
      continue;
    }
    if (state.kjPaperJournal !== null) {
      state.kjSettlementCandidates.set(chosen.marketId, chosen);
    }
    if (priorMarket !== null && priorMarket.marketId !== chosen.marketId) {
      const retiredMarketId = priorMarket.marketId;
      const timer = setTimeout(() => {
        state.maintenanceTimers.delete(timer);
        state.leadLagEngine.retirePolymarketWorkingHistory(retiredMarketId);
      }, 3_500);
      state.maintenanceTimers.add(timer);
    }
    state.orderBook = new PublicOrderBook({
      expectedConditionId: chosen.conditionId,
      expectedAssetIds: [chosen.upTokenId, chosen.downTokenId],
      staleAfterMilliseconds: 5_000,
    });
    const marketEnd = Math.min(end, Date.parse(chosen.intervalEnd));
    let first = true;
    while (Date.now() < marketEnd && !recorder.stoppedByLimit && !failureRuntime.terminated && !signal.aborted) {
      if (!first) stats.clob.reconnects += 1;
      first = false;
      await captureUntil({
        stream: "clob",
        signal,
        request: { source: "clob-market", assetIds: [chosen.upTokenId, chosen.downTokenId] },
        beforeAttempt: (connectionId) => state.orderBook?.connected(connectionId, new Date().toISOString()),
        afterAttempt: (_connectionId, receiveStamp) => {
          state.orderBook?.disconnected();
          state.leadLagEngine.notePolymarketConnectionReset({
            market_id: chosen.marketId,
            receive_stamp: leadLagStamp(receiveStamp),
          });
        },
        handle: clobHandler(state, recorder, stats.clob, chosen, failureRuntime),
      }, marketEnd, stats.clob, recorder, failureRuntime);
      if (Date.now() < marketEnd) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    }
    state.orderBook = null;
    state.latestPolymarketInput = null;
    state.completeSetCandidateSince = null;
  }
}

async function settlementLoop(
  captureEnd: number,
  deadline: number,
  state: RuntimeState,
  recorder: RuntimeRecorder,
  stats: StreamStats,
  failureRuntime: FailClosedRuntime,
  signal: AbortSignal,
): Promise<void> {
  if (state.kjPaperJournal === null || state.kjPaperEngine === null) return;
  while (Date.now() < deadline
    && !recorder.stoppedByLimit
    && !failureRuntime.terminated
    && !signal.aborted) {
    const candidates = [...state.kjSettlementCandidates.values()]
      .filter((market) => Date.now() > Date.parse(market.intervalEnd))
      .sort((left, right) => left.intervalEnd.localeCompare(right.intervalEnd))
      .slice(0, 4);
    for (const market of candidates) {
      if (state.kjPaperEngine.state(market.marketId) === null) {
        state.kjSettlementCandidates.delete(market.marketId);
        continue;
      }
      state.kjSettlementAttempts.set(
        market.marketId,
        (state.kjSettlementAttempts.get(market.marketId) ?? 0) + 1,
      );
      let response;
      try {
        response = await fetchPublicMarketBySlug(market.slug, {
          timeoutMilliseconds: 10_000,
          maxResponseBytes: 2 * 1024 * 1024,
        });
      } catch (error) {
        stats.reconnects += 1;
        process.stderr.write(`Gamma settlement fetch deferred for ${market.slug}: ${String(error)}\n`);
        continue;
      }
      observe(stats, response.rawPayload, response.receiveTime, null);
      let parserStatus: ParserStatus = "parsed";
      let parserError: string | null = null;
      let settlementError: unknown = null;
      try {
        createKJOfficialSettlementFromGamma({
          expectedMarket: market,
          responseStatus: response.status,
          rawPayload: response.rawPayload,
          receiveTime: response.receiveTime,
        });
      } catch (error) {
        settlementError = error;
        if (error instanceof GammaResolutionPending) parserStatus = "unparsed";
        else {
          parserStatus = "error";
          parserError = error instanceof Error ? error.message : String(error);
          stats.quarantines += 1;
        }
      }
      await recorder.raw("gamma", {
        eventType: parserStatus === "parsed" ? "market_resolution" : "market_resolution_pending",
        rawPayload: response.rawPayload,
        receiveStamp: response.receiveStamp,
        sourceTime: null,
        serverTime: null,
        market,
        marketSlug: market.slug,
        parserStatus,
        parserError,
        connectionId: `gamma-settlement-${market.marketId}`,
      });
      if (settlementError instanceof GammaResolutionPending) continue;
      if (settlementError !== null) throw settlementError;
      await state.kjPaperJournal.appendGammaResolution({
        expectedMarket: market,
        responseStatus: response.status,
        rawPayload: response.rawPayload,
        receiveTime: response.receiveTime,
      });
      state.kjSettlementCandidates.delete(market.marketId);
      state.kjSettledMarketCount += 1;
    }
    if (Date.now() >= captureEnd && state.kjSettlementCandidates.size === 0) break;
    if (Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
    }
  }
}

function snapshot(state: RuntimeState): PaperSnapshot | null {
  const market = state.currentMarket;
  const book = state.orderBook;
  if (market === null || book === null || book.state !== BookState.ACTIVE_UNVERIFIED) return null;
  const observedAt = new Date().toISOString();
  const observedMilliseconds = Date.parse(observedAt);
  if (observedMilliseconds < Date.parse(market.intervalStart)
    || observedMilliseconds >= Date.parse(market.intervalEnd)) return null;
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
    observedAt,
    marketId: market.marketId,
    up: { bid: values.upBid!, ask: values.upAsk!, bidSize: values.upBidSize!, askSize: values.upAskSize! },
    down: { bid: values.downBid!, ask: values.downAsk!, bidSize: values.downBidSize!, askSize: values.downAskSize! },
    chainlink: state.chainlink?.value ?? null,
    binanceSpot: state.spot?.value ?? state.polymarketBinance?.value ?? null,
    binancePerpetual: state.perpetual?.value ?? null,
    continuity: "UNVERIFIED",
  };
}

function kjStrategyContext(
  state: RuntimeState,
  value: PaperSnapshot | null,
  source: KJSignalSource,
) {
  const polymarketInput = state.latestPolymarketInput;
  const signal = source === "CHAINLINK" ? state.chainlink : state.spot ?? state.polymarketBinance;
  return createKJStrategyContext({
    decisionTime: value?.observedAt ?? new Date().toISOString(),
    market: state.currentMarket,
    book: value === null || polymarketInput === null ? null : {
      state: state.orderBook?.state ?? "DISCONNECTED",
      continuity: "UNVERIFIED",
      up: value.up,
      down: value.down,
      receiveStamp: polymarketInput.receiveStamp,
    },
    signal: signal === null ? null : {
      provider: source === "CHAINLINK"
        ? "POLYMARKET_RTDS_CHAINLINK"
        : state.spot === signal ? "BINANCE_SPOT" : "POLYMARKET_RTDS_BINANCE",
      price: signal.value,
      sourceTime: signal.sourceTime,
      serverTime: signal.serverTime,
      receiveTime: signal.receiveTime,
      receiveStamp: signal.receiveStamp,
      connectionId: signal.connectionId,
      inputHash: signal.inputHash,
    },
  });
}

function opportunityAudits(value: PaperSnapshot, state: RuntimeState, now: number): readonly PaperAudit[] {
  const market = state.currentMarket;
  const feeRate = market?.takerFeeRate ?? null;
  const candidate = completeSetArbitrageObserver(value, {
    feeRate,
    latencyMilliseconds: state.opportunityConfig.complete_set_latency_ms,
    latencySatisfied: false,
  });
  const candidateDetected = feeRate !== null && market !== null && (() => {
    const result = new FeeEdgeCalculator().completeSet({
      marketId: market.marketId,
      conditionId: market.conditionId,
      executableTime: value.observedAt,
      upAsk: value.up.ask,
      downAsk: value.down.ask,
      upAskSize: value.up.askSize,
      downAskSize: value.down.askSize,
      evidence: {
        market_id: market.marketId,
        condition_id: market.conditionId,
        effective_from: market.intervalStart.replace("Z", ".000Z"),
        effective_to: market.intervalEnd.replace("Z", ".000Z"),
        fee_rate: feeRate,
        evidence_reference: `gamma:${market.slug}`,
        evidence_status: "UNVERIFIED",
      },
    });
    return result.scenarioNetEdgeAmount !== null && Money.from(result.scenarioNetEdgeAmount).isPositive();
  })();
  if (!candidateDetected) state.completeSetCandidateSince = null;
  else state.completeSetCandidateSince ??= now;
  const latencySatisfied = state.completeSetCandidateSince !== null
    && now - state.completeSetCandidateSince >= state.opportunityConfig.complete_set_latency_ms;
  const complete = latencySatisfied
    ? completeSetArbitrageObserver(value, {
        feeRate,
        latencyMilliseconds: state.opportunityConfig.complete_set_latency_ms,
        latencySatisfied: true,
      })
    : candidate;
  const maker = makerEnvelopeObserver(value, { markoutPrice: null });
  return [noTradeObserver(value), complete, maker];
}

function recordOpportunityObservations(
  audits: readonly PaperAudit[],
  state: RuntimeState,
  failureRuntime: FailClosedRuntime,
): void {
  const latestInput = state.latestPolymarketInput;
  if (latestInput === null || failureRuntime.terminated) return;
  const family: Readonly<Record<ObserverName, string>> = {
    NO_TRADE: "NO_TRADE",
    COMPLETE_SET_ARBITRAGE_OBSERVER: "COMPLETE_SET_ARBITRAGE",
    LEAD_LAG_OBSERVER: "CROSS_VENUE_LEAD_LAG",
    MAKER_ENVELOPE_OBSERVER: "MAKER_SPREAD_REBATE",
  };
  for (const audit of audits) {
    failureRuntime.noteObservation();
    state.observations.push(createOpportunityObservationV1({
      opportunityFamily: family[audit.observer],
      marketId: audit.marketId,
      observedAtWall: audit.observedAt,
      receiveStamp: leadLagStamp(latestInput.receiveStamp),
      inputLineage: [{
        source: "POLYMARKET_CLOB",
        parent_input_reference: latestInput.parentInputReference,
        input_hash: latestInput.inputHash,
        receive_stamp: leadLagStamp(latestInput.receiveStamp),
      }],
      provenance: {
        producer: "live-runtime-batch-4b-r1",
        gitCommit: state.gitCommit,
        sessionId: state.sessionId,
        configHash: state.opportunityConfig.config_hash,
      },
      quality: { status: "DEGRADED", rejectionReasons: ["CLOB_CONTINUITY_UNVERIFIED"] },
      feeEvidenceReference: state.currentMarket === null ? null : `gamma:${state.currentMarket.slug}`,
      continuity: "UNVERIFIED",
      grossEdge: audit.grossEdge,
      scenarioNetEdge: audit.edgeAfterFees,
      visibleSize: audit.executableQuantity,
      eligibility: "INELIGIBLE",
      rejectionReason: "CLOB_CONTINUITY_UNVERIFIED",
      facts: JSON.parse(JSON.stringify(audit)) as Record<string, unknown>,
    }));
  }
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

async function dashboardLoop(
  config: RuntimeOptions,
  end: number,
  started: number,
  state: RuntimeState,
  recorder: RuntimeRecorder,
  stats: Record<StreamName, StreamStats>,
  failureRuntime: FailClosedRuntime,
  signal: AbortSignal,
): Promise<void> {
  let previousBookState: BookState | null = null;
  while (Date.now() < end && !recorder.stoppedByLimit && !failureRuntime.terminated && !signal.aborted) {
    const now = new Date().toISOString();
    const bookState = state.orderBook?.state ?? BookState.DISCONNECTED;
    state.orderBook?.markStaleIfExpired(now);
    if (bookState === BookState.STALE && previousBookState !== BookState.STALE) state.staleCount += 1;
    previousBookState = bookState;
    const paperSnapshot = snapshot(state);
    const kjContext = kjStrategyContext(state, paperSnapshot, config.kjSignalSource);
    if (config.mode === "paper" && kjContext.ready && state.kjPaperJournal !== null) {
      await state.kjPaperJournal.appendContext(kjContext.context);
    }
    const kjAllEvents = state.kjPaperEngine?.events() ?? [];
    const kjPaperEvents = kjAllEvents.slice(state.kjPaperEventCursor);
    state.kjPaperEventCursor = kjAllEvents.length;
    const audits = paperSnapshot === null ? [] : opportunityAudits(paperSnapshot, state, Date.now());
    recordOpportunityObservations(audits, state, failureRuntime);
    trackOpportunities(audits, state, Date.now());
    if (config.mode === "paper") state.paperAudits.push(...audits);
    const storage = await statfs(config.outputPath ?? "/root/polymarket-money-data").catch((storageError) => {
      process.stderr.write(`runtime storage telemetry unavailable: ${String(storageError)}\n`);
      return null;
    });
    const elapsedHours = Math.max((Date.now() - started) / 3_600_000, 1 / 3_600_000);
    const publicPayloadBytes = STREAMS.reduce((sum, name) => sum + stats[name].payloadBytes, 0);
    const projectedBytesPerHour = config.record.mode === "raw"
      ? recorder.usedRawBytes / elapsedHours
      : publicPayloadBytes / elapsedHours;
    const view = {
      type: "runtime_snapshot",
      at: now,
      mode: config.mode,
      currentMarket: state.currentMarket?.slug ?? null,
      nextMarket: state.nextMarket?.slug ?? null,
      marketIdentity: state.currentMarket === null ? null : {
        marketId: state.currentMarket.marketId,
        conditionId: state.currentMarket.conditionId,
        slug: state.currentMarket.slug,
        intervalStart: state.currentMarket.intervalStart,
        intervalEnd: state.currentMarket.intervalEnd,
      },
      bookState: state.orderBook?.state ?? "DISCONNECTED",
      snapshotReady: paperSnapshot !== null,
      kjStrategyContextReady: kjContext.ready,
      kjStrategyContextReason: kjContext.ready ? null : kjContext.reason,
      kjStrategyContext: kjContext.ready ? kjContext.context : null,
      kjPaperEngineVersion: KJ_PAPER_ENGINE_VERSION,
      kjPaperEnabled: state.kjPaperJournal !== null,
      kjSignalSource: state.kjPaperJournal === null ? null : config.kjSignalSource,
      kjPaperJournalRecordCount: state.kjPaperJournal?.recordCount ?? null,
      kjPaperJournalLastRecordHash: state.kjPaperJournal?.lastRecordHash ?? null,
      kjPaperEvents,
      kjPaperState: state.kjPaperEngine?.snapshot() ?? null,
      kjPaperWallets: state.kjPaperEngine === null ? null : {
        J_FEE_AWARE: state.kjPaperEngine.wallet("J_FEE_AWARE"),
        K_DUAL_VOL: state.kjPaperEngine.wallet("K_DUAL_VOL"),
      },
      kjPaperCurrentMarketState: state.kjPaperEngine !== null && state.currentMarket !== null
        ? state.kjPaperEngine.state(state.currentMarket.marketId)
        : null,
      continuity: "UNVERIFIED",
      up: paperSnapshot?.up ?? null,
      down: paperSnapshot?.down ?? null,
      chainlink: state.chainlink?.value ?? null,
      binanceSpot: state.spot?.value ?? state.polymarketBinance?.value ?? null,
      binancePerpetual: state.perpetual?.value ?? null,
      providerToLocalWallDelta: Object.fromEntries(STREAMS.map((name) => [name, {
        p50Ms: percentile(stats[name].providerToLocalWallDeltas, 0.5),
        p95Ms: percentile(stats[name].providerToLocalWallDeltas, 0.95),
      }])),
      opportunities: audits,
      streamCounters: Object.fromEntries(STREAMS.map((name) => [name, {
        events: stats[name].events,
        reconnects: stats[name].reconnects,
        quarantines: stats[name].quarantines,
      }])),
      orderBookQualityEvents: state.orderBook?.qualityEvents ?? [],
      latestPolymarketReceiveStamp: state.latestPolymarketInput?.receiveStamp ?? null,
      diskFreeBytes: storage === null ? null : storage.bavail * storage.bsize,
      rawWriteBytesPerHour: recorder.usedRawBytes / elapsedHours,
      projectedCaptureBytesPerHour: projectedBytesPerHour,
      projectedCaptureGiBPerDay: projectedBytesPerHour * 24 / 1024 ** 3,
      growthEstimateBasis: config.record.mode === "raw"
        ? "PERSISTED_RAW_ENVELOPE"
        : "PUBLIC_PAYLOAD_LOWER_BOUND",
    };
    recorder.metric(view);
    process.stdout.write(`${JSON.stringify(view)}\n`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
}

async function main(): Promise<void> {
  const config = await options();
  const sessionAbort = new AbortController();
  const requestShutdown = (): void => sessionAbort.abort();
  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);
  const runId = `runtime-${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const incidentDirectory = config.outputPath ?? "/tmp/polymarket-runtime-incidents";
  await mkdir(incidentDirectory, { recursive: true, mode: 0o700 });
  const failureRuntime = new FailClosedRuntime({
    incidentWriter: new RuntimeIncidentFileWriter(incidentDirectory, runId),
    emergencySink: new EmergencyReceiptFileSink(incidentDirectory, runId),
  });
  const recorder = new RuntimeRecorder(config, runId);
  let kjPaperJournal: KJPaperJournal | null = null;
  try {
    if (config.kjPaperJournalPath !== null) {
      kjPaperJournal = await KJPaperJournal.open(config.kjPaperJournalPath);
    }
    await recorder.open();
  } catch (openError) {
    let cleanupError: unknown = null;
    try {
      await kjPaperJournal?.close();
    } catch (journalCleanupError) {
      cleanupError = journalCleanupError;
    }
    const reportedOpenError = cleanupError === null
      ? openError
      : new AggregateError([openError, cleanupError], "runtime storage open and cleanup both failed");
    await failureRuntime.terminate(createRuntimeIncident({
      errorClass: reportedOpenError instanceof Error ? reportedOpenError.name : "UnknownError",
      message: reportedOpenError instanceof Error ? reportedOpenError.message : String(reportedOpenError),
      stream: "runtime-storage",
      connectionRole: "storage",
      connectionId: runId,
      receiveStamp: publicReceiveClock().capture(),
      rawReference: null,
      actionTaken: "TERMINATE_SESSION",
      stopReason: "RUNTIME_STORAGE_OPEN_FAILED",
    }));
    return;
  }
  const opportunityConfig = createOpportunityRuntimeConfig({
    mode: config.mode,
    recordMode: config.record.mode,
    completeSetLatencyMs: 1_000,
    feeEvidencePolicy: "GAMMA_SCHEDULE_OR_INELIGIBLE",
    clobContinuity: "UNVERIFIED",
    leadLagConfigHash: DEFAULT_LEAD_LAG_CONFIG.config_hash,
    preregistrationConfigHash: config.preregistration?.config_sha256 ?? null,
  });
  const state = new RuntimeState(
    runId,
    config.collectorGitCommit,
    opportunityConfig,
    kjPaperJournal,
  );
  const stats = newStats();
  const started = Date.now();
  const end = started + config.durationMilliseconds;
  const external = [
    captureUntil({
      stream: "chainlink",
      signal: sessionAbort.signal,
      request: { source: "rtds-chainlink" },
      afterAttempt: (_connectionId, receiveStamp) => markExternalConnectionReset(state, "chainlink", receiveStamp),
      handle: rtdsHandler("chainlink", state, recorder, stats.chainlink, failureRuntime),
    }, end, stats.chainlink, recorder, failureRuntime),
    captureUntil({
      stream: "polymarket_binance",
      signal: sessionAbort.signal,
      request: { source: "rtds-binance" },
      afterAttempt: (_connectionId, receiveStamp) => markExternalConnectionReset(state, "polymarket_binance", receiveStamp),
      handle: rtdsHandler("binance", state, recorder, stats.polymarket_binance, failureRuntime),
    }, end, stats.polymarket_binance, recorder, failureRuntime),
    captureUntil({
      stream: "binance_spot",
      signal: sessionAbort.signal,
      request: { source: "binance-spot-book" },
      afterAttempt: (_connectionId, receiveStamp) => markExternalConnectionReset(state, "binance_spot", receiveStamp),
      handle: directHandler("binance_spot", state, recorder, stats.binance_spot, failureRuntime),
    }, end, stats.binance_spot, recorder, failureRuntime),
    captureUntil({
      stream: "binance_perpetual",
      signal: sessionAbort.signal,
      request: { source: "binance-perpetual-book" },
      afterAttempt: (_connectionId, receiveStamp) => markExternalConnectionReset(state, "binance_perpetual", receiveStamp),
      handle: directHandler("binance_perpetual", state, recorder, stats.binance_perpetual, failureRuntime),
    }, end, stats.binance_perpetual, recorder, failureRuntime),
  ];
  try {
    await Promise.all([
      marketLoop(
        end,
        config.kjMarketStartAtMilliseconds,
        config.kjMarketStartBeforeMilliseconds,
        state,
        recorder,
        stats,
        failureRuntime,
        sessionAbort.signal,
      ),
      dashboardLoop(config, end, started, state, recorder, stats, failureRuntime, sessionAbort.signal),
      settlementLoop(
        end,
        end + config.kjSettlementGraceMilliseconds,
        state,
        recorder,
        stats.gamma,
        failureRuntime,
        sessionAbort.signal,
      ),
      ...external,
    ]);
  } catch (runtimeError) {
    if (!failureRuntime.terminated) {
      await failureRuntime.terminate(createRuntimeIncident({
        errorClass: runtimeError instanceof Error ? runtimeError.name : "UnknownError",
        message: runtimeError instanceof Error ? runtimeError.message : String(runtimeError),
        stream: "runtime-session",
        connectionRole: "session",
        connectionId: runId,
        receiveStamp: publicReceiveClock().capture(),
        rawReference: null,
        actionTaken: "TERMINATE_SESSION",
        stopReason: "UNRECOVERABLE_RUNTIME_FAILURE",
      }));
    }
    sessionAbort.abort();
  }
  sessionAbort.abort();
  for (const timer of state.horizonTimers) clearTimeout(timer);
  state.horizonTimers.clear();
  for (const timer of state.maintenanceTimers) clearTimeout(timer);
  state.maintenanceTimers.clear();
  for (const startedAt of state.opportunities.values()) state.opportunityDurations.push(Date.now() - startedAt);
  let segments: readonly CompressedSegmentResult[] = [];
  try {
    segments = await recorder.close();
  } catch (closeError) {
    if (!failureRuntime.terminated) {
      await failureRuntime.terminate(createRuntimeIncident({
        errorClass: closeError instanceof Error ? closeError.name : "UnknownError",
        message: closeError instanceof Error ? closeError.message : String(closeError),
        stream: "runtime-recorder",
        connectionRole: "storage",
        connectionId: runId,
        receiveStamp: publicReceiveClock().capture(),
        rawReference: null,
        actionTaken: "TERMINATE_SESSION",
        stopReason: "RAW_WRITER_CLOSE_FAILED",
      }));
    } else {
      process.stderr.write(`runtime recorder close failed after terminal transition: ${String(closeError)}\n`);
    }
  }
  try {
    await kjPaperJournal?.close();
  } catch (journalCloseError) {
    if (!failureRuntime.terminated) {
      await failureRuntime.terminate(createRuntimeIncident({
        errorClass: journalCloseError instanceof Error ? journalCloseError.name : "UnknownError",
        message: journalCloseError instanceof Error
          ? journalCloseError.message
          : String(journalCloseError),
        stream: "kj-paper-journal",
        connectionRole: "storage",
        connectionId: runId,
        receiveStamp: publicReceiveClock().capture(),
        rawReference: null,
        actionTaken: "TERMINATE_SESSION",
        stopReason: "KJ_PAPER_JOURNAL_CLOSE_FAILED",
      }));
    } else {
      process.stderr.write(`K/J paper journal close failed after terminal transition: ${String(journalCloseError)}\n`);
    }
  }
  if (state.rawTriggerCount > 0 && state.leadLagObservations.length > 0) {
    const leadLagEvidence = state.leadLagObservations;
    if (leadLagEvidence.length > 0) {
    state.routeEvaluations.push(createRouteEvaluationV1({
      route: "CROSS_VENUE_LEAD_LAG",
      configHash: state.opportunityConfig.config_hash,
      observationHashes: leadLagEvidence.map((item) => item.observation_hash),
      rawTriggerCount: state.rawTriggerCount,
      uniqueEpisodeCount: state.leadLagEngine.episodes().length,
      uniqueMarketCount: state.leadLagMarketIds.size,
    }));
    }
  }
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
    stoppedByDuration: !recorder.stoppedByLimit && !failureRuntime.terminated,
    terminalFailure: failureRuntime.termination,
    streams: Object.fromEntries(STREAMS.map((name) => [name, {
      events: stats[name].events,
      payloadBytes: stats[name].payloadBytes,
      eventsPerHour: stats[name].events * 3_600 / elapsedSeconds,
      payloadBytesPerHour: stats[name].payloadBytes * 3_600 / elapsedSeconds,
      reconnects: stats[name].reconnects,
      quarantines: stats[name].quarantines,
      providerToLocalWallDeltaP50Ms: percentile(stats[name].providerToLocalWallDeltas, 0.5),
      providerToLocalWallDeltaP95Ms: percentile(stats[name].providerToLocalWallDeltas, 0.95),
    }])),
    staleCount: state.staleCount,
    opportunityDurationMilliseconds: state.opportunityDurations,
    paperAuditCount: state.paperAudits.length,
    kjPaperEngineVersion: KJ_PAPER_ENGINE_VERSION,
    kjPaperEnabled: state.kjPaperJournal !== null,
    kjSignalSource: state.kjPaperJournal === null ? null : config.kjSignalSource,
    kjSettlementGraceMilliseconds: config.kjSettlementGraceMilliseconds,
    kjMarketStartAt: config.kjMarketStartAtMilliseconds === null
      ? null
      : new Date(config.kjMarketStartAtMilliseconds).toISOString(),
    kjMarketStartBefore: config.kjMarketStartBeforeMilliseconds === null
      ? null
      : new Date(config.kjMarketStartBeforeMilliseconds).toISOString(),
    kjPaperJournalPath: state.kjPaperJournal?.path ?? null,
    kjPaperJournalRecordCount: state.kjPaperJournal?.recordCount ?? null,
    kjPaperJournalRecoveredInputCount: state.kjPaperJournal?.recoveredInputCount ?? null,
    kjPaperJournalLastRecordHash: state.kjPaperJournal?.lastRecordHash ?? null,
    kjSettledMarketCount: state.kjSettledMarketCount,
    kjPendingSettlementMarkets: [...state.kjSettlementCandidates.values()].map((market) => ({
      marketId: market.marketId,
      slug: market.slug,
      intervalEnd: market.intervalEnd,
      attempts: state.kjSettlementAttempts.get(market.marketId) ?? 0,
    })),
    kjPaperEventCount: state.kjPaperEngine?.events().length ?? 0,
    kjPaperState: state.kjPaperEngine?.snapshot() ?? null,
    kjPaperWallets: state.kjPaperEngine === null ? null : {
      J_FEE_AWARE: state.kjPaperEngine.wallet("J_FEE_AWARE"),
      K_DUAL_VOL: state.kjPaperEngine.wallet("K_DUAL_VOL"),
    },
    opportunityObservationCount: state.observations.length,
    leadLagOpportunityObservationCount: state.leadLagObservations.length,
    opportunityConfig: state.opportunityConfig,
    routeEvaluations: state.routeEvaluations,
    leadLagGrid: state.leadLagEngine.grid(),
    leadLagEpisodes: state.leadLagEngine.episodes(),
    leadLagTriggers: state.leadLagEngine.triggers(),
    leadLagTriggerRejections: state.triggerRejections,
    leadLagHorizons: state.horizonObservations,
    leadLagObservations: state.leadLagObservations,
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
    experiment: config.preregistration === null ? null : {
      experimentId: config.preregistration.experiment_id,
      preregistrationConfigHash: config.preregistration.config_sha256,
      targetCompletedMarkets: config.preregistration.target_completed_markets,
      maximumRuntimeMinutes: config.preregistration.maximum_runtime_minutes,
      continuity: config.preregistration.continuity_required,
      rawRecording: config.preregistration.raw_recording,
      fairValueEnabled: config.preregistration.fair_value_enabled,
    },
  };
  if (config.summaryPath !== null) await writeFile(config.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o400 });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.removeListener("SIGTERM", requestShutdown);
  process.removeListener("SIGINT", requestShutdown);
}

await main();
