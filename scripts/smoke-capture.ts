import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  capturePublicSocket,
  clobMarketSubscription,
  fetchPublicMarketBySlug,
  rtdsSubscription,
  validatePublicBtcFiveMinuteMarket,
  type BinanceTransportMode,
  type CapturedFrame,
  type PublicBtcFiveMinuteMarket,
  type PublicSocketAuditEvent,
} from "../execution/src/adapters/market-data/public-sources.js";
import {
  parseClobMarketFrame,
  parseRtdsPriceMessage,
} from "../execution/src/adapters/market-data/parsers.js";
import { PublicOrderBook } from "../execution/src/adapters/market-data/book-state.js";
import { createEnvelopeDraftV2, type ParserStatus } from "../execution/src/domain/raw-event.js";
import {
  DatasetManifestWriter,
  RawSegmentWriter,
  type ClosedSegment,
  type DatasetManifestV1,
} from "../execution/src/storage/raw-segment.js";

interface SmokeOptions {
  readonly dataRoot: string;
  readonly timeoutMilliseconds: number;
  readonly maxFrames: number;
  readonly maxFrameBytes: number;
  readonly maxTotalBytes: number;
  readonly maxResponseBytes: number;
  readonly collectorGitCommit: string;
  readonly binanceTransportMode: BinanceTransportMode;
}

interface SmokeDatasetResult {
  readonly source: string;
  readonly stream: string;
  readonly manifest: DatasetManifestV1;
}

async function appendAuditEvent(
  writer: RawSegmentWriter,
  event: PublicSocketAuditEvent,
  context: {
    readonly source: string;
    readonly stream: string;
    readonly connectionId: string;
    readonly subscriptionId: string;
    readonly marketId?: string | null;
    readonly conditionId?: string | null;
  },
): Promise<void> {
  const rawPayload = JSON.stringify({
    audit_event: event.eventType,
    details: event.details,
  });
  await writer.append(
    createEnvelopeDraftV2({
      eventId: randomUUID(),
      source: context.source,
      stream: context.stream,
      eventType: event.eventType,
      transportConnectionId: context.connectionId,
      subscriptionId: context.subscriptionId,
      marketId: context.marketId ?? null,
      conditionId: context.conditionId ?? null,
      receiveStamp: event.receiveStamp,
      processTime: new Date().toISOString(),
      rawPayload,
      parserStatus: "parsed",
    }),
  );
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInteger(value: string | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field} must be positive`);
  return parsed;
}

function binanceTransportMode(value: string | undefined): BinanceTransportMode {
  const mode = value ?? "btc-only";
  if (mode !== "btc-only" && mode !== "all-symbols-quarantine") {
    throw new Error("--binance-transport must be btc-only or all-symbols-quarantine");
  }
  return mode;
}

async function projectRoot(): Promise<string> {
  let current = dirname(fileURLToPath(import.meta.url));
  while (dirname(current) !== current) {
    try {
      const metadata = JSON.parse(await readFile(resolve(current, "package.json"), "utf8")) as {
        readonly name?: unknown;
      };
      if (metadata.name === "polymarket-money") return realpath(current);
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    current = dirname(current);
  }
  throw new Error("cannot locate polymarket-money project root");
}

async function options(): Promise<SmokeOptions> {
  const configuredRoot = argument("--data-root") ?? process.env.POLY_DATA_ROOT;
  if (configuredRoot === undefined || configuredRoot.trim() === "") {
    throw new Error("POLY_DATA_ROOT or --data-root is required");
  }
  const dataRoot = await realpath(resolve(configuredRoot));
  const repository = await projectRoot();
  if (dataRoot === repository || dataRoot.startsWith(`${repository}${sep}`)) {
    throw new Error("raw capture root must be outside the Git repository");
  }
  return Object.freeze({
    dataRoot,
    timeoutMilliseconds: positiveInteger(argument("--timeout-seconds"), 20, "timeout") * 1_000,
    maxFrames: positiveInteger(argument("--max-frames"), 50, "maxFrames"),
    maxFrameBytes: positiveInteger(argument("--max-frame-bytes"), 1_048_576, "maxFrameBytes"),
    maxTotalBytes: positiveInteger(argument("--max-total-bytes"), 8_388_608, "maxTotalBytes"),
    maxResponseBytes: positiveInteger(argument("--max-response-bytes"), 1_048_576, "maxResponseBytes"),
    binanceTransportMode: binanceTransportMode(argument("--binance-transport")),
    collectorGitCommit: (() => {
      const commit = argument("--git-commit");
      if (commit === undefined || !/^[0-9a-f]{40,64}$/.test(commit)) {
        throw new Error("--git-commit must be the committed collector Git object ID");
      }
      return commit;
    })(),
  });
}

function epochCandidates(now: Date): readonly number[] {
  const current = Math.floor(now.getTime() / 300_000) * 300;
  return [0, 300, -300, 600, -600, 900, -900, 1_200, -1_200].map((offset) => current + offset);
}

async function publishManifest(
  config: SmokeOptions,
  runId: string,
  source: string,
  stream: string,
  subscription: Readonly<Record<string, unknown>>,
  segment: ClosedSegment,
  collectionStart: string,
): Promise<DatasetManifestV1> {
  return new DatasetManifestWriter(config.dataRoot).publish({
    datasetId: `${runId}-${source.replaceAll(".", "-")}-${stream}`,
    source,
    stream,
    subscription,
    collectorGitCommit: config.collectorGitCommit,
    collectionStart,
    collectionEnd: new Date().toISOString(),
    segments: [segment],
    sanitizedConfig: {
      endpointClass: "public-read-only",
      maxEvents: config.maxFrames,
      timeoutSeconds: config.timeoutMilliseconds / 1_000,
      maxFrameBytes: config.maxFrameBytes,
      maxTotalBytes: config.maxTotalBytes,
      maxResponseBytes: config.maxResponseBytes,
      ...(source === "polymarket.rtds.chainlink" ? { symbolFilter: "btc/usd" } : {}),
      ...(source === "polymarket.rtds.binance"
        ? { symbolFilter: "btcusdt", transportScope: config.binanceTransportMode }
        : {}),
    },
  });
}

async function discoverMarket(
  config: SmokeOptions,
  runId: string,
): Promise<{ market: PublicBtcFiveMinuteMarket; dataset: SmokeDatasetResult }> {
  const source = "polymarket.gamma";
  const stream = "market-discovery";
  const collectionStart = new Date().toISOString();
  const writer = await RawSegmentWriter.open({
    dataRoot: config.dataRoot,
    segmentId: `${runId}-gamma`,
    source,
    stream,
    partitionDate: collectionStart.slice(0, 10),
  });
  let selected: PublicBtcFiveMinuteMarket | null = null;
  const attempted: string[] = [];
  for (const epoch of epochCandidates(new Date())) {
    const slug = `btc-updown-5m-${epoch}`;
    attempted.push(slug);
    const response = await fetchPublicMarketBySlug(slug, {
      timeoutMilliseconds: Math.min(config.timeoutMilliseconds, 10_000),
      maxResponseBytes: config.maxResponseBytes,
    });
    let eventType = "gamma_market_response";
    let parserStatus: ParserStatus = "parsed";
    let parserError: string | null = null;
    let candidate: PublicBtcFiveMinuteMarket | null = null;
    try {
      if (response.status !== 200) throw new Error(`Gamma returned HTTP ${response.status}`);
      const identified = validatePublicBtcFiveMinuteMarket(response.rawPayload);
      if (!identified.collectible) {
        eventType = "gamma_market_not_collectible";
        parserStatus = "quarantined";
      } else {
        candidate = identified;
      }
    } catch (error) {
      eventType = response.status === 404 ? "gamma_market_not_found" : "gamma_market_parse_error";
      parserStatus = response.status === 404 ? "unparsed" : "error";
      parserError = parserStatus === "error" ? (error instanceof Error ? error.message : String(error)) : null;
    }
    const processTime = new Date().toISOString();
    await writer.append(
      createEnvelopeDraftV2({
        eventId: randomUUID(),
        source,
        stream,
        eventType,
        transportConnectionId: `${runId}-gamma-http`,
        subscriptionId: slug,
        marketId: candidate?.marketId ?? null,
        conditionId: candidate?.conditionId ?? null,
        receiveStamp: response.receiveStamp,
        processTime,
        rawPayload: response.rawPayload,
        parserStatus,
        parserError,
      }),
    );
    if (candidate !== null) {
      selected = candidate;
      break;
    }
  }
  if (selected === null) {
    await writer.leaveIncomplete();
    throw new Error(`no currently readable BTC five-minute market found: ${attempted.join(",")}`);
  }
  const closed = await writer.close();
  const manifest = await publishManifest(
    config,
    runId,
    source,
    stream,
    { endpoint: "gamma-market-by-slug", slug: selected.slug },
    closed,
    collectionStart,
  );
  return { market: selected, dataset: { source, stream, manifest } };
}

async function captureClob(
  config: SmokeOptions,
  runId: string,
  market: PublicBtcFiveMinuteMarket,
): Promise<SmokeDatasetResult> {
  const source = "polymarket.clob.market";
  const stream = "market-channel";
  const collectionStart = new Date().toISOString();
  const connectionId = `${runId}-clob-ws`;
  const subscriptionId = `${market.slug}-public-books`;
  const writer = await RawSegmentWriter.open({
    dataRoot: config.dataRoot,
    segmentId: `${runId}-clob`,
    source,
    stream,
    partitionDate: collectionStart.slice(0, 10),
  });
  const subscription = clobMarketSubscription([market.upTokenId, market.downTokenId]);
  const expectedAssets = new Set([market.upTokenId, market.downTokenId]);
  const orderBook = new PublicOrderBook({
    expectedConditionId: market.conditionId,
    expectedAssetIds: [...expectedAssets],
    staleAfterMilliseconds: config.timeoutMilliseconds,
  });
  orderBook.connected(connectionId, collectionStart);
  await capturePublicSocket({
    source: "clob-market",
    assetIds: [...expectedAssets],
    timeoutMilliseconds: config.timeoutMilliseconds,
    maxFrames: config.maxFrames,
    maxFrameBytes: config.maxFrameBytes,
    maxTotalBytes: config.maxTotalBytes,
    audit: (event) =>
      appendAuditEvent(writer, event, {
        source,
        stream,
        connectionId,
        subscriptionId,
        marketId: market.marketId,
        conditionId: market.conditionId,
      }),
    accept: async (frame: CapturedFrame) => {
      const parsedFrame = parseClobMarketFrame(frame.rawPayload);
      let parserStatus: ParserStatus = parsedFrame.shape === "error" ? "error" : "parsed";
      let parserError = parsedFrame.parserError;
      for (const parsed of parsedFrame.messages) {
        if (parsed.parserStatus === "error") {
          parserStatus = "error";
          parserError ??= parsed.parserError;
          continue;
        }
        if (parsed.parserStatus === "unparsed" && parserStatus === "parsed") parserStatus = "unparsed";
        if (
          parsed.parserStatus === "quarantined"
          || (parsed.conditionId !== null && parsed.conditionId !== market.conditionId)
          || (parsed.assetId !== null && !expectedAssets.has(parsed.assetId))
          || (parsed.priceChanges?.some((change) => !expectedAssets.has(change.assetId)) ?? false)
        ) {
          if (parserStatus !== "error") parserStatus = "quarantined";
          continue;
        }
        if (parsed.parserStatus !== "parsed") continue;
        if (parsed.eventType === "book") {
          try {
            orderBook.applySnapshot(parsed, connectionId, frame.receiveTime);
          } catch (snapshotError) {
            void snapshotError;
            if (parserStatus !== "error") parserStatus = "quarantined";
          }
        } else if (parsed.eventType === "price_change" && orderBook.allExpectedAssetsReady) {
          try {
            orderBook.applyPriceChange(parsed, connectionId, frame.receiveTime);
          } catch (changeError) {
            void changeError;
            if (parserStatus !== "error") parserStatus = "quarantined";
          }
        }
      }
      const onlyMessage = parsedFrame.messages.length === 1 ? parsedFrame.messages[0] : undefined;
      const processTime = new Date().toISOString();
      await writer.append(
        createEnvelopeDraftV2({
          eventId: randomUUID(),
          source,
          stream,
          eventType: onlyMessage?.eventType ?? (parsedFrame.shape === "error" ? "parse_error" : "clob_batch_unverified"),
          transportConnectionId: connectionId,
          subscriptionId,
          marketId: market.marketId,
          conditionId: onlyMessage?.conditionId ?? market.conditionId,
          assetId: onlyMessage?.assetId ?? null,
          receiveStamp: frame.receiveStamp,
          processTime,
          sourceHash: onlyMessage?.sourceHash ?? null,
          rawPayload: frame.rawPayload,
          parserStatus,
          parserError: parserStatus === "error" ? (parserError ?? "CLOB frame parse failed") : null,
        }),
      );
      return orderBook.allExpectedAssetsReady;
    },
  });
  const closed = await writer.close();
  const manifest = await publishManifest(
    config,
    runId,
    source,
    stream,
    subscription,
    closed,
    collectionStart,
  );
  return { source, stream, manifest };
}

async function captureRtds(
  config: SmokeOptions,
  runId: string,
  expectedSource: "chainlink" | "binance",
): Promise<SmokeDatasetResult> {
  const source = `polymarket.rtds.${expectedSource}`;
  const stream = "crypto-prices";
  const collectionStart = new Date().toISOString();
  const connectionId = `${runId}-rtds-${expectedSource}`;
  const subscriptionId = expectedSource === "binance"
    ? `binance-${config.binanceTransportMode}`
    : "chainlink-btc-public";
  const writer = await RawSegmentWriter.open({
    dataRoot: config.dataRoot,
    segmentId: `${runId}-rtds-${expectedSource}`,
    source,
    stream,
    partitionDate: collectionStart.slice(0, 10),
  });
  const subscription = rtdsSubscription(expectedSource, config.binanceTransportMode);
  await capturePublicSocket({
    source: expectedSource === "chainlink" ? "rtds-chainlink" : "rtds-binance",
    ...(expectedSource === "binance" ? { transportMode: config.binanceTransportMode } : {}),
    timeoutMilliseconds: config.timeoutMilliseconds,
    maxFrames: config.maxFrames,
    maxFrameBytes: config.maxFrameBytes,
    maxTotalBytes: config.maxTotalBytes,
    audit: (event) =>
      appendAuditEvent(writer, event, {
        source,
        stream,
        connectionId,
        subscriptionId,
      }),
    accept: async (frame: CapturedFrame) => {
      const parsed = parseRtdsPriceMessage(frame.rawPayload, expectedSource);
      const processTime = new Date().toISOString();
      await writer.append(
        createEnvelopeDraftV2({
          eventId: randomUUID(),
          source,
          stream,
          eventType: parsed.eventType,
          transportConnectionId: connectionId,
          subscriptionId,
          providerSourceTime: parsed.sourceTime,
          providerServerTime: parsed.serverTime,
          receiveStamp: frame.receiveStamp,
          processTime,
          rawPayload: frame.rawPayload,
          parserStatus: parsed.parserStatus,
          parserError: parsed.parserError,
        }),
      );
      return parsed.parserStatus === "parsed";
    },
  });
  const closed = await writer.close();
  const manifest = await publishManifest(
    config,
    runId,
    source,
    stream,
    subscription,
    closed,
    collectionStart,
  );
  return { source, stream, manifest };
}

async function main(): Promise<void> {
  const config = await options();
  const runId = `smoke-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const discovery = await discoverMarket(config, runId);
  const [clob, chainlink, binance] = await Promise.all([
    captureClob(config, runId, discovery.market),
    captureRtds(config, runId, "chainlink"),
    captureRtds(config, runId, "binance"),
  ]);
  const datasets = [discovery.dataset, clob, chainlink, binance];
  process.stdout.write(
    `${JSON.stringify(
      {
        run_id: runId,
        market: {
          market_id: discovery.market.marketId,
          condition_id: discovery.market.conditionId,
          slug: discovery.market.slug,
          interval_start: discovery.market.intervalStart,
          interval_end: discovery.market.intervalEnd,
        },
        datasets: datasets.map((dataset) => ({
          source: dataset.source,
          stream: dataset.stream,
          dataset_id: dataset.manifest.dataset_id,
          event_count: dataset.manifest.event_count,
          continuity: dataset.manifest.continuity,
        })),
      },
      null,
      2,
    )}\n`,
  );
}

await main();
