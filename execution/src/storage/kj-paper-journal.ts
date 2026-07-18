import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  statfs,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PublicBtcFiveMinuteMarket } from "../adapters/market-data/public-sources.js";
import {
  createKJOfficialSettlementFromGamma,
  type GammaResolutionInput,
} from "../adapters/settlement/gamma-resolution.js";
import {
  DEFAULT_KJ_PAPER_ENGINE_CONFIG,
  KJ_PAPER_ENGINE_VERSION,
  KJPaperEngine,
  kjPaperContextFingerprint,
  kjPaperContextIdentity,
  kjPaperSignalFingerprint,
  kjPaperSignalIdentity,
  type KJOfficialSettlement,
} from "../runtime/kj-paper-engine.js";
import {
  createKJStrategyContext,
  KJ_STRATEGY_CONTEXT_VERSION,
  type KJStrategyContextV1,
} from "../strategy/kj-context.js";

export const KJ_PAPER_JOURNAL_VERSION = "kj-paper-input-journal-v2" as const;
const KJ_PAPER_CHECKPOINT_VERSION = "kj-paper-input-checkpoint-v2" as const;

type JournalPayloadType = "HEADER" | "RUN_PLAN" | "CONTEXT" | "GAMMA_RESOLUTION";

export interface KJPaperRunPlanEvidenceV1 {
  readonly schemaVersion: "kj-paper-run-plan-v1";
  readonly runId: string;
  readonly targetMarketCount: number;
  readonly firstFullMarketStart: string;
  readonly captureEnd: string;
  readonly collectorGitCommit: string;
}

export interface KJPaperRunPlanEvidenceV2 extends Omit<KJPaperRunPlanEvidenceV1, "schemaVersion"> {
  readonly schemaVersion: "kj-paper-run-plan-v2";
  readonly campaignId: string;
  readonly campaignHash: string;
  readonly campaignRunIndex: number;
}

export type KJPaperRunPlanEvidence = KJPaperRunPlanEvidenceV1 | KJPaperRunPlanEvidenceV2;

interface JournalRecord {
  readonly schemaVersion: typeof KJ_PAPER_JOURNAL_VERSION;
  readonly sequence: string;
  readonly previousRecordHash: string | null;
  readonly payloadType: JournalPayloadType;
  readonly payload: unknown;
  readonly recordHash: string;
}

interface JournalCheckpoint {
  readonly schemaVersion: typeof KJ_PAPER_CHECKPOINT_VERSION;
  readonly journalVersion: typeof KJ_PAPER_JOURNAL_VERSION;
  readonly recordCount: string;
  readonly lastRecordHash: string;
}

export interface KJPaperJournalAppendReceipt {
  readonly sequence: string;
  readonly recordHash: string;
  readonly durable: true;
  readonly appended: boolean;
}

const HASH = /^[0-9a-f]{64}$/u;
const INTEGER = /^(?:0|[1-9]\d*)$/u;
let repositoryRootPromise: Promise<string> | undefined;

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length
    || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${field} contains missing or unsupported fields`);
  }
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be non-empty`);
  return value;
}

function utc(value: unknown, field: string): string {
  const text = nonEmpty(value, field);
  if (!text.endsWith("Z") || !Number.isFinite(Date.parse(text))) {
    throw new Error(`${field} must be valid explicit UTC`);
  }
  return text;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("journal JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  throw new Error("journal accepts only JSON values");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function recordHash(value: Omit<JournalRecord, "recordHash">): string {
  return sha256(stableJson(value));
}

function samePathRoot(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (
    child !== ".."
    && !child.startsWith("../")
    && !child.startsWith("..\\")
    && !isAbsolute(child)
  );
}

function notFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function alreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function repositoryRoot(): Promise<string> {
  repositoryRootPromise ??= (async () => {
    let current = dirname(fileURLToPath(import.meta.url));
    while (dirname(current) !== current) {
      try {
        const metadata = JSON.parse(await readFile(join(current, "package.json"), "utf8")) as {
          readonly name?: unknown;
        };
        if (metadata.name === "polymarket-money") return realpath(current);
      } catch (error) {
        if (!notFound(error) && !(error instanceof SyntaxError)) throw error;
      }
      current = dirname(current);
    }
    throw new Error("cannot locate polymarket-money repository root");
  })();
  return repositoryRootPromise;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function safeDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("K/J journal parent must be absolute");
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of relative(root, absolute).split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`K/J journal path component is unsafe: ${current}`);
      }
    } catch (error) {
      if (!notFound(error)) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!alreadyExists(mkdirError)) throw mkdirError;
      }
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`K/J journal directory creation was unsafe: ${current}`);
      }
      await syncDirectory(dirname(current));
    }
    if (await realpath(current) !== current) {
      throw new Error(`K/J journal symlink directory is forbidden: ${current}`);
    }
  }
  return absolute;
}

async function openJournalFile(path: string): Promise<{ handle: FileHandle; created: boolean }> {
  if (!isAbsolute(path)) throw new Error("K/J paper journal path must be absolute");
  const absolute = resolve(path);
  const repository = await repositoryRoot();
  if (samePathRoot(repository, absolute)) {
    throw new Error("K/J paper journal must remain outside the Git repository");
  }
  const parent = await safeDirectory(dirname(absolute));
  const filesystem = await statfs(parent);
  const unsupported = new Set([0x01021997, 0x5346544e, 0x65735546]);
  if (unsupported.has(Number(filesystem.type))) {
    throw new Error("K/J paper journal requires a Linux-native non-DrvFS filesystem");
  }
  let handle: FileHandle;
  let created = false;
  try {
    handle = await open(
      absolute,
      constants.O_RDWR | constants.O_APPEND | constants.O_CREAT
        | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    await syncDirectory(parent);
  } catch (error) {
    if (!alreadyExists(error)) throw error;
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("K/J paper journal must be a regular non-symlink file");
    }
    if (await realpath(absolute) !== absolute) {
      throw new Error("K/J paper journal symlink escape is forbidden");
    }
    handle = await open(
      absolute,
      constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600,
    );
  }
  const opened = await handle.stat();
  if (!opened.isFile()) {
    await handle.close();
    throw new Error("K/J paper journal descriptor is not a regular file");
  }
  return { handle, created };
}

function checkpointPath(path: string): string {
  return `${path}.checkpoint.json`;
}

async function loadCheckpoint(path: string): Promise<JournalCheckpoint | null> {
  const target = checkpointPath(path);
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile() || await realpath(target) !== target) {
    throw new Error("K/J journal checkpoint must be a regular non-symlink file");
  }
  const parsed = object(JSON.parse(await readFile(target, "utf8")), "K/J journal checkpoint");
  exactKeys(parsed, [
    "schemaVersion",
    "journalVersion",
    "recordCount",
    "lastRecordHash",
  ], "K/J journal checkpoint");
  if (parsed.schemaVersion !== KJ_PAPER_CHECKPOINT_VERSION
    || parsed.journalVersion !== KJ_PAPER_JOURNAL_VERSION) {
    throw new Error("K/J journal checkpoint version is unsupported");
  }
  if (typeof parsed.recordCount !== "string" || !INTEGER.test(parsed.recordCount)
    || parsed.recordCount === "0") {
    throw new Error("K/J journal checkpoint record count is invalid");
  }
  if (typeof parsed.lastRecordHash !== "string" || !HASH.test(parsed.lastRecordHash)) {
    throw new Error("K/J journal checkpoint hash is invalid");
  }
  return Object.freeze({
    schemaVersion: KJ_PAPER_CHECKPOINT_VERSION,
    journalVersion: KJ_PAPER_JOURNAL_VERSION,
    recordCount: parsed.recordCount,
    lastRecordHash: parsed.lastRecordHash,
  });
}

async function publishCheckpoint(path: string, value: JournalCheckpoint): Promise<void> {
  const target = checkpointPath(path);
  const parent = dirname(target);
  const temporary = `${target}.${process.pid}.${randomUUID()}.partial`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
  } catch (error) {
    try {
      await handle.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "K/J checkpoint write and close both failed");
    }
    throw error;
  }
  await rename(temporary, target);
  await syncDirectory(parent);
}

function validateContext(value: unknown): KJStrategyContextV1 {
  try {
    const candidate = value as KJStrategyContextV1;
    if (candidate.schemaVersion !== KJ_STRATEGY_CONTEXT_VERSION || candidate.mode !== "PAPER_ONLY") {
      throw new Error("context schema or mode is unsupported");
    }
    if (candidate.signal.provider !== "BINANCE_SPOT"
      && candidate.signal.provider !== "POLYMARKET_RTDS_BINANCE"
      && candidate.signal.provider !== "POLYMARKET_RTDS_CHAINLINK") {
      throw new Error("context signal provider is unsupported");
    }
    const market: PublicBtcFiveMinuteMarket = {
      marketId: candidate.market.marketId,
      conditionId: candidate.market.conditionId,
      slug: candidate.market.slug,
      intervalStart: candidate.market.intervalStart,
      intervalEnd: candidate.market.intervalEnd,
      upTokenId: candidate.market.upTokenId,
      downTokenId: candidate.market.downTokenId,
      active: true,
      closed: false,
      acceptingOrders: true,
      collectible: true,
      takerFeeRate: candidate.feeEvidence.rate,
      rawPayload: "{}",
    };
    const rebuilt = createKJStrategyContext({
      decisionTime: candidate.decisionTime,
      market,
      book: {
        state: candidate.book.state,
        continuity: candidate.book.continuity,
        up: candidate.book.up,
        down: candidate.book.down,
        receiveStamp: candidate.book.receiveStamp,
      },
      signal: candidate.signal,
    });
    if (!rebuilt.ready) throw new Error(rebuilt.reason);
    if (kjPaperContextFingerprint(candidate) !== kjPaperContextFingerprint(rebuilt.context)) {
      throw new Error("persisted context differs from its strict reconstruction");
    }
    return rebuilt.context;
  } catch (error) {
    throw new Error(`invalid persisted K/J context: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function headerPayload(): Readonly<Record<string, unknown>> {
  const config = { ...DEFAULT_KJ_PAPER_ENGINE_CONFIG };
  return Object.freeze({
    engineVersion: KJ_PAPER_ENGINE_VERSION,
    configHash: sha256(stableJson(config)),
    config: Object.freeze(config),
  });
}

function validateRunPlan(value: unknown): KJPaperRunPlanEvidence {
  const candidate = object(value, "K/J run plan");
  const isCampaignBound = candidate.schemaVersion === "kj-paper-run-plan-v2";
  exactKeys(candidate, [
    "schemaVersion",
    "runId",
    "targetMarketCount",
    "firstFullMarketStart",
    "captureEnd",
    "collectorGitCommit",
    ...(isCampaignBound ? ["campaignId", "campaignHash", "campaignRunIndex"] : []),
  ], "K/J run plan");
  if (candidate.schemaVersion !== "kj-paper-run-plan-v1" && !isCampaignBound) {
    throw new Error("K/J run plan schema is unsupported");
  }
  if (!Number.isSafeInteger(candidate.targetMarketCount)
    || (candidate.targetMarketCount as number) <= 0
    || (candidate.targetMarketCount as number) > 12) {
    throw new Error("K/J run plan targetMarketCount must be from 1 through 12");
  }
  const firstFullMarketStart = utc(candidate.firstFullMarketStart, "firstFullMarketStart");
  const captureEnd = utc(candidate.captureEnd, "captureEnd");
  if (Date.parse(firstFullMarketStart) >= Date.parse(captureEnd)) {
    throw new Error("K/J run plan target window must be non-empty");
  }
  const collectorGitCommit = nonEmpty(candidate.collectorGitCommit, "collectorGitCommit");
  if (!/^[0-9a-f]{40,64}$/u.test(collectorGitCommit)) {
    throw new Error("K/J run plan collectorGitCommit is invalid");
  }
  const base = {
    runId: nonEmpty(candidate.runId, "runId"),
    targetMarketCount: candidate.targetMarketCount as number,
    firstFullMarketStart,
    captureEnd,
    collectorGitCommit,
  };
  if (!isCampaignBound) return Object.freeze({ schemaVersion: "kj-paper-run-plan-v1" as const, ...base });
  const campaignId = nonEmpty(candidate.campaignId, "campaignId");
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/u.test(campaignId)) throw new Error("K/J run plan campaignId is invalid");
  const campaignHash = nonEmpty(candidate.campaignHash, "campaignHash");
  if (!HASH.test(campaignHash)) throw new Error("K/J run plan campaignHash is invalid");
  if (!Number.isSafeInteger(candidate.campaignRunIndex) || (candidate.campaignRunIndex as number) <= 0) {
    throw new Error("K/J run plan campaignRunIndex must be positive");
  }
  return Object.freeze({
    schemaVersion: "kj-paper-run-plan-v2" as const,
    ...base,
    campaignId,
    campaignHash,
    campaignRunIndex: candidate.campaignRunIndex as number,
  });
}

function parseRecord(line: string, ordinal: number, previous: string | null): JournalRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`K/J journal line ${ordinal + 1} is invalid JSON: ${String(error)}`);
  }
  const record = object(parsed, `K/J journal line ${ordinal + 1}`);
  exactKeys(record, [
    "schemaVersion",
    "sequence",
    "previousRecordHash",
    "payloadType",
    "payload",
    "recordHash",
  ], `K/J journal line ${ordinal + 1}`);
  if (record.schemaVersion !== KJ_PAPER_JOURNAL_VERSION) throw new Error("unsupported K/J journal schema");
  if (record.sequence !== String(ordinal) || !INTEGER.test(record.sequence)) {
    throw new Error("K/J journal sequence is not contiguous");
  }
  if (record.previousRecordHash !== previous) throw new Error("K/J journal hash chain is broken");
  if (record.payloadType !== "HEADER"
    && record.payloadType !== "RUN_PLAN"
    && record.payloadType !== "CONTEXT"
    && record.payloadType !== "GAMMA_RESOLUTION") {
    throw new Error("K/J journal payload type is unsupported");
  }
  if (typeof record.recordHash !== "string" || !HASH.test(record.recordHash)) {
    throw new Error("K/J journal record hash is invalid");
  }
  const core = {
    schemaVersion: KJ_PAPER_JOURNAL_VERSION,
    sequence: record.sequence,
    previousRecordHash: previous,
    payloadType: record.payloadType,
    payload: record.payload,
  } as const;
  if (recordHash(core) !== record.recordHash) throw new Error("K/J journal record hash mismatch");
  return Object.freeze({ ...core, recordHash: record.recordHash });
}

export class KJPaperJournal {
  readonly engine: KJPaperEngine;
  readonly #path: string;
  readonly #handle: FileHandle;
  readonly #contextIdentities = new Map<string, string>();
  readonly #signalIdentities = new Map<string, string>();
  readonly #marketIdentities = new Map<string, string>();
  readonly #markets = new Map<string, PublicBtcFiveMinuteMarket>();
  readonly #marketEnds = new Map<string, number>();
  readonly #watermarks = new Map<string, readonly [bigint, bigint]>();
  readonly #settlementIds = new Map<string, string>();
  readonly #settlementMarkets = new Map<string, string>();
  readonly #recordHashes: string[] = [];
  #runPlanEvidence: KJPaperRunPlanEvidence | null = null;
  #lastNewSignalReceiveMilliseconds: number | null = null;
  #recordCount = 0;
  #recoveredInputCount = 0;
  #lastHash: string | null = null;
  #state: "OPEN" | "FAILED" | "CLOSED" = "OPEN";
  #tail: Promise<void> = Promise.resolve();

  private constructor(path: string, handle: FileHandle) {
    this.#path = path;
    this.#handle = handle;
    this.engine = new KJPaperEngine();
  }

  static async open(path: string): Promise<KJPaperJournal> {
    const absolute = resolve(path);
    const { handle } = await openJournalFile(absolute);
    const journal = new KJPaperJournal(absolute, handle);
    try {
      await journal.#recover();
      const checkpoint = await loadCheckpoint(absolute);
      if (journal.#recordCount === 0) {
        if (checkpoint !== null) throw new Error("K/J journal was truncated behind its checkpoint");
        await journal.#appendRaw("HEADER", headerPayload());
      } else {
        if (checkpoint === null) {
          if (journal.#recordCount === 1) await journal.#publishCurrentCheckpoint();
          else throw new Error("non-empty K/J journal is missing its checkpoint");
        }
      }
      const currentCheckpoint = checkpoint ?? await loadCheckpoint(absolute);
      if (currentCheckpoint !== null) {
        const checkpointCount = Number(currentCheckpoint.recordCount);
        if (!Number.isSafeInteger(checkpointCount) || checkpointCount > journal.#recordCount) {
          throw new Error("K/J journal was truncated behind its checkpoint");
        }
        if (journal.#recordHashes[checkpointCount - 1] !== currentCheckpoint.lastRecordHash) {
          throw new Error("K/J journal checkpoint does not anchor the current hash chain");
        }
        if (checkpointCount < journal.#recordCount) await journal.#publishCurrentCheckpoint();
      }
      return journal;
    } catch (error) {
      journal.#state = "FAILED";
      try {
        await handle.close();
      } catch (closeError) {
        throw new AggregateError([error, closeError], "K/J journal recovery and close both failed");
      }
      throw error;
    }
  }

  get path(): string { return this.#path; }
  get recordCount(): number { return this.#recordCount; }
  get recoveredInputCount(): number { return this.#recoveredInputCount; }
  get lastRecordHash(): string | null { return this.#lastHash; }
  get runPlanEvidence(): KJPaperRunPlanEvidence | null { return this.#runPlanEvidence; }

  unsettledMarkets(): readonly PublicBtcFiveMinuteMarket[] {
    return Object.freeze([...this.#markets.values()]
      .filter((market) => this.engine.state(market.marketId) !== "DONE")
      .sort((left, right) => left.intervalStart.localeCompare(right.intervalStart)));
  }

  appendContext(context: KJStrategyContextV1): Promise<KJPaperJournalAppendReceipt> {
    return this.#serialize(() => this.#appendContext(context));
  }

  appendRunPlan(value: KJPaperRunPlanEvidence): Promise<KJPaperJournalAppendReceipt> {
    return this.#serialize(() => this.#appendRunPlan(value));
  }

  appendGammaResolution(input: GammaResolutionInput): Promise<KJPaperJournalAppendReceipt> {
    return this.#serialize(() => this.#appendGammaResolution(input));
  }

  close(): Promise<void> {
    return this.#serialize(async () => {
      if (this.#state === "CLOSED") return;
      if (this.#state === "OPEN") await this.#handle.sync();
      await this.#handle.close();
      this.#state = "CLOSED";
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #recover(): Promise<void> {
    const bytes = await this.#handle.readFile();
    if (bytes.byteLength === 0) return;
    const text = bytes.toString("utf8");
    if (!text.endsWith("\n")) throw new Error("K/J journal has an incomplete trailing record");
    const lines = text.slice(0, -1).split("\n");
    if (lines.some((line) => line === "")) throw new Error("K/J journal contains an empty record");
    for (let ordinal = 0; ordinal < lines.length; ordinal += 1) {
      const record = parseRecord(lines[ordinal]!, ordinal, this.#lastHash);
      if (ordinal === 0) {
        if (record.payloadType !== "HEADER" || stableJson(record.payload) !== stableJson(headerPayload())) {
          throw new Error("K/J journal header does not match the current engine contract");
        }
      } else if (record.payloadType === "CONTEXT") {
        const context = validateContext(record.payload);
        this.#checkContextRelations(context);
        if (!this.engine.ingest(context)) throw new Error("K/J journal contains a duplicate context record");
        this.#rememberContext(context);
        this.#recoveredInputCount += 1;
      } else if (record.payloadType === "RUN_PLAN") {
        if (ordinal !== 1 || this.#runPlanEvidence !== null) {
          throw new Error("K/J journal run plan must appear once immediately after the header");
        }
        this.#runPlanEvidence = validateRunPlan(record.payload);
        this.#recoveredInputCount += 1;
      } else if (record.payloadType === "GAMMA_RESOLUTION") {
        const evidence = object(record.payload, "K/J Gamma resolution record");
        exactKeys(evidence, [
          "marketId",
          "responseStatus",
          "rawPayload",
          "receiveTime",
        ], "K/J Gamma resolution record");
        const expectedMarket = this.#markets.get(nonEmpty(evidence.marketId, "marketId"));
        if (expectedMarket === undefined) throw new Error("K/J Gamma resolution market is unknown");
        if (!Number.isSafeInteger(evidence.responseStatus)) {
          throw new Error("K/J Gamma resolution responseStatus must be a safe integer");
        }
        const settlement = createKJOfficialSettlementFromGamma({
          expectedMarket,
          responseStatus: evidence.responseStatus as number,
          rawPayload: nonEmpty(evidence.rawPayload, "rawPayload"),
          receiveTime: utc(evidence.receiveTime, "receiveTime"),
        });
        this.#rememberSettlement(settlement);
        if (!this.engine.settle(settlement)) throw new Error("K/J journal contains a duplicate settlement record");
        this.#recoveredInputCount += 1;
      } else {
        throw new Error("K/J journal header may appear only as the first record");
      }
      this.#recordCount += 1;
      this.#lastHash = record.recordHash;
      this.#recordHashes.push(record.recordHash);
    }
  }

  async #appendContext(value: KJStrategyContextV1): Promise<KJPaperJournalAppendReceipt> {
    this.#requireOpen();
    const context = validateContext(value);
    const identity = kjPaperContextIdentity(context);
    const fingerprint = kjPaperContextFingerprint(context);
    const prior = this.#contextIdentities.get(identity);
    if (prior !== undefined) {
      if (prior !== fingerprint) throw new Error("K/J journal context identity has conflicting content");
      return this.#duplicateReceipt();
    }
    this.#checkContextRelations(context);
    const receipt = await this.#appendRaw("CONTEXT", context);
    try {
      if (!this.engine.ingest(context)) throw new Error("new journal context was not applied");
      this.#rememberContext(context);
      return receipt;
    } catch (error) {
      this.#state = "FAILED";
      throw error;
    }
  }

  async #appendRunPlan(value: KJPaperRunPlanEvidence): Promise<KJPaperJournalAppendReceipt> {
    this.#requireOpen();
    const candidate = validateRunPlan(value);
    if (this.#runPlanEvidence !== null) {
      if (stableJson(this.#runPlanEvidence) !== stableJson(candidate)) {
        throw new Error("K/J journal run plan conflicts with its hash-chained plan");
      }
      return this.#duplicateReceipt();
    }
    if (this.#recordCount !== 1) {
      throw new Error("K/J journal run plan must be appended before every context");
    }
    const receipt = await this.#appendRaw("RUN_PLAN", candidate);
    this.#runPlanEvidence = candidate;
    return receipt;
  }

  async #appendGammaResolution(input: GammaResolutionInput): Promise<KJPaperJournalAppendReceipt> {
    this.#requireOpen();
    const expectedMarket = this.#markets.get(input.expectedMarket.marketId);
    if (expectedMarket === undefined) throw new Error("K/J journal settlement market is unknown");
    for (const field of [
      "marketId",
      "conditionId",
      "slug",
      "upTokenId",
      "downTokenId",
    ] as const) {
      if (expectedMarket[field] !== input.expectedMarket[field]) {
        throw new Error(`K/J journal settlement expected market conflicts on ${field}`);
      }
    }
    for (const field of ["intervalStart", "intervalEnd"] as const) {
      if (Date.parse(expectedMarket[field]) !== Date.parse(input.expectedMarket[field])) {
        throw new Error(`K/J journal settlement expected market conflicts on ${field}`);
      }
    }
    const settlement = createKJOfficialSettlementFromGamma({ ...input, expectedMarket });
    const fingerprint = sha256(stableJson(settlement));
    const priorId = this.#settlementIds.get(settlement.settlementId);
    if (priorId !== undefined) {
      if (priorId !== fingerprint) throw new Error("K/J journal settlement ID has conflicting content");
      return this.#duplicateReceipt();
    }
    if (this.#settlementMarkets.has(settlement.marketId)) {
      throw new Error("K/J journal market already has a settlement record");
    }
    const marketEnd = this.#marketEnds.get(settlement.marketId);
    if (marketEnd === undefined) throw new Error("K/J journal settlement market is unknown");
    if (Date.parse(settlement.settlementTime) < marketEnd) {
      throw new Error("K/J journal settlement precedes market end");
    }
    const receipt = await this.#appendRaw("GAMMA_RESOLUTION", Object.freeze({
      marketId: input.expectedMarket.marketId,
      responseStatus: input.responseStatus,
      rawPayload: input.rawPayload,
      receiveTime: input.receiveTime,
    }));
    try {
      if (!this.engine.settle(settlement)) throw new Error("new journal settlement was not applied");
      this.#settlementIds.set(settlement.settlementId, fingerprint);
      this.#settlementMarkets.set(settlement.marketId, fingerprint);
      return receipt;
    } catch (error) {
      this.#state = "FAILED";
      throw error;
    }
  }

  async #appendRaw(
    payloadType: JournalPayloadType,
    payload: unknown,
  ): Promise<KJPaperJournalAppendReceipt> {
    this.#requireOpen();
    const core = {
      schemaVersion: KJ_PAPER_JOURNAL_VERSION,
      sequence: String(this.#recordCount),
      previousRecordHash: this.#lastHash,
      payloadType,
      payload,
    } as const;
    const digest = recordHash(core);
    const line = `${JSON.stringify({ ...core, recordHash: digest })}\n`;
    try {
      await this.#handle.writeFile(line, { encoding: "utf8" });
      await this.#handle.sync();
    } catch (error) {
      this.#state = "FAILED";
      throw error;
    }
    this.#recordCount += 1;
    this.#lastHash = digest;
    this.#recordHashes.push(digest);
    try {
      await this.#publishCurrentCheckpoint();
    } catch (error) {
      this.#state = "FAILED";
      throw error;
    }
    return Object.freeze({
      sequence: core.sequence,
      recordHash: digest,
      durable: true,
      appended: true,
    });
  }

  #checkContextRelations(context: KJStrategyContextV1): void {
    const identity = kjPaperContextIdentity(context);
    const fingerprint = kjPaperContextFingerprint(context);
    const prior = this.#contextIdentities.get(identity);
    if (prior !== undefined) {
      if (prior !== fingerprint) throw new Error("K/J journal context identity conflict during replay");
      throw new Error("K/J journal duplicate context during replay");
    }
    const signalIdentity = kjPaperSignalIdentity(context);
    const signalFingerprint = kjPaperSignalFingerprint(context);
    const priorSignal = this.#signalIdentities.get(signalIdentity);
    if (priorSignal !== undefined && priorSignal !== signalFingerprint) {
      throw new Error("K/J journal signal identity has conflicting content");
    }
    if (priorSignal === undefined) {
      const received = Date.parse(context.signal.receiveTime);
      if (this.#lastNewSignalReceiveMilliseconds !== null
        && received < this.#lastNewSignalReceiveMilliseconds) {
        throw new Error("K/J journal new signal time reversed");
      }
    }
    const marketFingerprint = sha256(stableJson(context.market));
    const priorMarket = this.#marketIdentities.get(context.market.marketId);
    if (priorMarket !== undefined && priorMarket !== marketFingerprint) {
      throw new Error("K/J journal market identity has conflicting content");
    }
    const watermark = context.inputWatermark;
    const current = [
      BigInt(watermark.localMonotonicReceiveNs),
      BigInt(watermark.localReceiveOrdinal),
    ] as const;
    const priorWatermark = this.#watermarks.get(watermark.clockDomain);
    if (priorWatermark !== undefined && (
      current[0] < priorWatermark[0]
      || (current[0] === priorWatermark[0] && current[1] < priorWatermark[1])
    )) {
      throw new Error("K/J journal input watermark reversed within one clock domain");
    }
  }

  #rememberContext(context: KJStrategyContextV1): void {
    const identity = kjPaperContextIdentity(context);
    const fingerprint = kjPaperContextFingerprint(context);
    this.#contextIdentities.set(identity, fingerprint);
    const signalIdentity = kjPaperSignalIdentity(context);
    if (!this.#signalIdentities.has(signalIdentity)) {
      this.#signalIdentities.set(signalIdentity, kjPaperSignalFingerprint(context));
      this.#lastNewSignalReceiveMilliseconds = Date.parse(context.signal.receiveTime);
    }
    if (!this.#marketIdentities.has(context.market.marketId)) {
      this.#marketIdentities.set(context.market.marketId, sha256(stableJson(context.market)));
      this.#marketEnds.set(context.market.marketId, Date.parse(context.market.intervalEnd));
      this.#markets.set(context.market.marketId, Object.freeze({
        marketId: context.market.marketId,
        conditionId: context.market.conditionId,
        slug: context.market.slug,
        intervalStart: context.market.intervalStart,
        intervalEnd: context.market.intervalEnd,
        upTokenId: context.market.upTokenId,
        downTokenId: context.market.downTokenId,
        active: true,
        closed: false,
        acceptingOrders: true,
        collectible: true,
        takerFeeRate: context.feeEvidence.rate,
        rawPayload: "{}",
      }));
    }
    const watermark = context.inputWatermark;
    this.#watermarks.set(watermark.clockDomain, [
      BigInt(watermark.localMonotonicReceiveNs),
      BigInt(watermark.localReceiveOrdinal),
    ]);
  }

  #publishCurrentCheckpoint(): Promise<void> {
    if (this.#lastHash === null || this.#recordCount <= 0) {
      throw new Error("cannot publish an empty K/J journal checkpoint");
    }
    return publishCheckpoint(this.#path, Object.freeze({
      schemaVersion: KJ_PAPER_CHECKPOINT_VERSION,
      journalVersion: KJ_PAPER_JOURNAL_VERSION,
      recordCount: String(this.#recordCount),
      lastRecordHash: this.#lastHash,
    }));
  }

  #rememberSettlement(settlement: KJOfficialSettlement): void {
    const fingerprint = sha256(stableJson(settlement));
    const prior = this.#settlementIds.get(settlement.settlementId);
    if (prior !== undefined) {
      if (prior !== fingerprint) throw new Error("K/J journal settlement conflict during replay");
      throw new Error("K/J journal duplicate settlement during replay");
    }
    if (this.#settlementMarkets.has(settlement.marketId)) {
      throw new Error("K/J journal duplicate market settlement during replay");
    }
    this.#settlementIds.set(settlement.settlementId, fingerprint);
    this.#settlementMarkets.set(settlement.marketId, fingerprint);
  }

  #duplicateReceipt(): KJPaperJournalAppendReceipt {
    if (this.#lastHash === null) throw new Error("K/J journal header is missing");
    return Object.freeze({
      sequence: String(this.#recordCount - 1),
      recordHash: this.#lastHash,
      durable: true,
      appended: false,
    });
  }

  #requireOpen(): void {
    if (this.#state !== "OPEN") throw new Error(`K/J journal is ${this.#state}`);
  }
}
