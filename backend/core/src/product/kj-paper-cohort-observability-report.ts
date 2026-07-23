import { createHash } from "node:crypto";

import type { KJPaperEvent } from "../runtime/kj-paper-engine.js";
import {
  buildKJPaperCohortReport,
  type KJPaperCohortInput,
  type KJPaperCohortReport,
} from "./kj-paper-cohort-report.js";
import type { KJPaperReport } from "./kj-paper-report.js";

export const KJ_PAPER_COHORT_OBSERVABILITY_REPORT_VERSION = "kj-paper-cohort-observability-report-v1" as const;

const STREAMS = [
  "gamma",
  "clob",
  "chainlink",
  "polymarket_binance",
  "binance_spot",
  "binance_perpetual",
] as const;
const STRATEGIES = ["J_FEE_AWARE", "K_DUAL_VOL"] as const;
const HASH = /^[0-9a-f]{64}$/u;
const INTEGER = /^(?:0|[1-9]\d*)$/u;

type StreamName = typeof STREAMS[number];
type Strategy = typeof STRATEGIES[number];

export interface KJPaperCohortObservabilityInput extends KJPaperCohortInput {
  readonly runtimeSummary: unknown;
  readonly runtimeSummarySha256: string;
  readonly journalRecordCount: number;
  readonly journalLastRecordHash: string | null;
  readonly events: readonly KJPaperEvent[];
}

interface StreamCounters {
  readonly eventCount: string;
  readonly reconnectCount: string;
  readonly quarantineCount: string;
}

interface ExecutionCounters {
  readonly intentCount: string;
  readonly fillCount: string;
  readonly noFillCount: string;
  readonly partialFillCount: string;
  readonly noFillReasons: Readonly<Record<string, string>>;
}

interface SettlementDelaySummary {
  readonly marketCount: string;
  readonly minimumMilliseconds: string;
  readonly p50Milliseconds: string;
  readonly p95Milliseconds: string;
  readonly maximumMilliseconds: string;
}

export interface KJPaperCohortObservabilityReport {
  readonly schemaVersion: typeof KJ_PAPER_COHORT_OBSERVABILITY_REPORT_VERSION;
  readonly evidenceStatus: "DESCRIPTIVE_PAPER_ONLY";
  readonly profitabilityClaimEligible: false;
  readonly pnlCohort: KJPaperCohortReport;
  readonly runs: readonly Readonly<{
    runId: string;
    runtimeDurationMilliseconds: string;
    journalRecordCount: string;
    journalLastRecordHash: string;
    streams: Readonly<Record<StreamName, StreamCounters>>;
    settlementDelay: SettlementDelaySummary;
    execution: Readonly<Record<Strategy, ExecutionCounters>>;
  }>[];
  readonly aggregate: Readonly<{
    streams: Readonly<Record<StreamName, StreamCounters>>;
    settlementDelay: SettlementDelaySummary;
    execution: Readonly<Record<Strategy, ExecutionCounters>>;
  }>;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be non-empty`);
  return value;
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function integerText(value: unknown, field: string): number {
  const candidate = text(value, field);
  if (!INTEGER.test(candidate)) throw new Error(`${field} must be a canonical non-negative integer`);
  const parsed = Number(candidate);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field} exceeds safe integer range`);
  return parsed;
}

function utc(value: unknown, field: string): number {
  const candidate = text(value, field);
  const parsed = Date.parse(candidate);
  if (!candidate.endsWith("Z") || !Number.isFinite(parsed)) throw new Error(`${field} must be explicit UTC`);
  return parsed;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("observability JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  throw new Error("observability report accepts only JSON values");
}

function percentileNearestRank(values: readonly number[], percentile: number): number {
  if (values.length === 0) throw new Error("percentile requires at least one value");
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(percentile * ordered.length) - 1)]!;
}

function settlementDelay(delays: readonly number[]): SettlementDelaySummary {
  if (delays.length === 0) throw new Error("observability run has no target settlement delays");
  return Object.freeze({
    marketCount: String(delays.length),
    minimumMilliseconds: String(Math.min(...delays)),
    p50Milliseconds: String(percentileNearestRank(delays, 0.5)),
    p95Milliseconds: String(percentileNearestRank(delays, 0.95)),
    maximumMilliseconds: String(Math.max(...delays)),
  });
}

function streamCounters(value: unknown, field: string): Readonly<Record<StreamName, StreamCounters>> {
  const streams = object(value, field);
  const actual = Object.keys(streams).sort();
  const expected = [...STREAMS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("runtime summary stream set is unsupported");
  }
  return Object.freeze(Object.fromEntries(STREAMS.map((stream) => {
    const summary = object(streams[stream], `runtime stream ${stream}`);
    return [stream, Object.freeze({
      eventCount: String(integer(summary.events, `${stream}.events`)),
      reconnectCount: String(integer(summary.reconnects, `${stream}.reconnects`)),
      quarantineCount: String(integer(summary.quarantines, `${stream}.quarantines`)),
    })] as const;
  })) as Record<StreamName, StreamCounters>);
}

function executionCounters(
  events: readonly KJPaperEvent[],
  targetMarketIds: ReadonlySet<string>,
): Readonly<Record<Strategy, ExecutionCounters>> {
  const totals = new Map<Strategy, {
    intents: number;
    fills: number;
    noFills: number;
    partials: number;
    reasons: Map<string, number>;
  }>(STRATEGIES.map((strategy) => [strategy, {
    intents: 0, fills: 0, noFills: 0, partials: 0, reasons: new Map<string, number>(),
  }]));
  for (const event of events) {
    if (!targetMarketIds.has(event.marketId) || event.strategy === null) continue;
    if (event.strategy !== "J_FEE_AWARE" && event.strategy !== "K_DUAL_VOL") {
      throw new Error("paper event strategy is unsupported");
    }
    const total = totals.get(event.strategy)!;
    if (event.eventType === "INTENT") total.intents += 1;
    else if (event.eventType === "FILL") {
      total.fills += 1;
      if (event.details.partial === true) total.partials += 1;
      else if (event.details.partial !== false) throw new Error("fill event partial flag is invalid");
    } else if (event.eventType === "NO_FILL") {
      total.noFills += 1;
      const reason = text(event.details.reason, "no-fill reason");
      total.reasons.set(reason, (total.reasons.get(reason) ?? 0) + 1);
    }
  }
  return Object.freeze(Object.fromEntries(STRATEGIES.map((strategy) => {
    const total = totals.get(strategy)!;
    return [strategy, Object.freeze({
      intentCount: String(total.intents),
      fillCount: String(total.fills),
      noFillCount: String(total.noFills),
      partialFillCount: String(total.partials),
      noFillReasons: Object.freeze(Object.fromEntries([...total.reasons.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([reason, count]) => [reason, String(count)]))),
    })] as const;
  })) as Record<Strategy, ExecutionCounters>);
}

function aggregateStreams(runs: readonly KJPaperCohortObservabilityReport["runs"][number][]): Readonly<Record<StreamName, StreamCounters>> {
  return Object.freeze(Object.fromEntries(STREAMS.map((stream) => {
    let events = 0;
    let reconnects = 0;
    let quarantines = 0;
    for (const run of runs) {
      events += integerText(run.streams[stream].eventCount, `${stream}.eventCount`);
      reconnects += integerText(run.streams[stream].reconnectCount, `${stream}.reconnectCount`);
      quarantines += integerText(run.streams[stream].quarantineCount, `${stream}.quarantineCount`);
    }
    return [stream, Object.freeze({
      eventCount: String(events), reconnectCount: String(reconnects), quarantineCount: String(quarantines),
    })] as const;
  })) as Record<StreamName, StreamCounters>);
}

function aggregateExecution(runs: readonly KJPaperCohortObservabilityReport["runs"][number][]): Readonly<Record<Strategy, ExecutionCounters>> {
  return Object.freeze(Object.fromEntries(STRATEGIES.map((strategy) => {
    let intents = 0;
    let fills = 0;
    let noFills = 0;
    let partials = 0;
    const reasons = new Map<string, number>();
    for (const run of runs) {
      const current = run.execution[strategy];
      intents += integerText(current.intentCount, `${strategy}.intentCount`);
      fills += integerText(current.fillCount, `${strategy}.fillCount`);
      noFills += integerText(current.noFillCount, `${strategy}.noFillCount`);
      partials += integerText(current.partialFillCount, `${strategy}.partialFillCount`);
      for (const [reason, count] of Object.entries(current.noFillReasons)) {
        reasons.set(reason, (reasons.get(reason) ?? 0) + integerText(count, `${strategy}.noFillReasons.${reason}`));
      }
    }
    return [strategy, Object.freeze({
      intentCount: String(intents), fillCount: String(fills), noFillCount: String(noFills),
      partialFillCount: String(partials),
      noFillReasons: Object.freeze(Object.fromEntries([...reasons.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([reason, count]) => [reason, String(count)]))),
    })] as const;
  })) as Record<Strategy, ExecutionCounters>);
}

function artifactRuntimeSummaryHash(artifact: unknown): string {
  const outer = object(artifact, "paper report artifact");
  const hashes = object(outer.sourceFileSha256, "paper report source hashes");
  const hash = text(hashes.runtimeSummary, "paper report runtime summary hash");
  if (!HASH.test(hash)) throw new Error("paper report runtime summary hash is invalid");
  return hash;
}

function targetSettlementEvidence(artifact: unknown): {
  readonly targetMarketIds: ReadonlySet<string>;
  readonly delays: readonly number[];
} {
  const outer = object(artifact, "paper report artifact");
  const report = outer.report as KJPaperReport;
  if (!Array.isArray(report.markets)) throw new Error("paper report markets are invalid");
  const byMarket = new Map<string, { readonly intervalEnd: number; readonly settlementTime: number }>();
  for (const value of report.markets) {
    const row = object(value, "paper report market row");
    const marketId = text(row.marketId, "paper report market ID");
    const intervalEnd = utc(row.intervalEnd, "paper report market interval end");
    const settlementTime = utc(row.settlementTime, "paper report settlement time");
    if (settlementTime < intervalEnd) throw new Error("paper report settlement predates market end");
    const prior = byMarket.get(marketId);
    if (prior !== undefined && (prior.intervalEnd !== intervalEnd || prior.settlementTime !== settlementTime)) {
      throw new Error("strategy settlement timing differs within one market");
    }
    byMarket.set(marketId, { intervalEnd, settlementTime });
  }
  if (byMarket.size !== report.run.targetMarketCount) {
    throw new Error("paper report lacks one settlement timing per target market");
  }
  return Object.freeze({
    targetMarketIds: new Set(byMarket.keys()),
    delays: [...byMarket.values()].map((item) => item.settlementTime - item.intervalEnd),
  });
}

function buildRun(
  input: KJPaperCohortObservabilityInput,
  cohortRun: KJPaperCohortReport["runs"][number],
): { readonly run: KJPaperCohortObservabilityReport["runs"][number]; readonly delays: readonly number[] } {
  if (!HASH.test(input.runtimeSummarySha256)
    || input.runtimeSummarySha256 !== artifactRuntimeSummaryHash(input.artifact)) {
    throw new Error("runtime summary hash conflicts with verified paper report artifact");
  }
  const sourceReport = object(object(input.artifact, "paper report artifact").report, "paper report") as unknown as KJPaperReport;
  if (sourceReport.run.runId !== cohortRun.runId
    || sourceReport.run.collectorGitCommit !== cohortRun.collectorGitCommit
    || sourceReport.run.firstFullMarketStart !== cohortRun.firstFullMarketStart
    || sourceReport.run.captureEnd !== cohortRun.captureEnd) {
    throw new Error("observability report run identity conflicts with the verified cohort");
  }
  const summary = object(input.runtimeSummary, "runtime summary");
  const safety = object(summary.safety, "runtime summary safety");
  if (summary.type !== "runtime_summary"
    || summary.mode !== "paper"
    || summary.terminalFailure !== null
    || summary.realOrderCount !== 0
    || summary.collectorGitCommit !== cohortRun.collectorGitCommit
    || summary.kjMarketStartBefore !== cohortRun.captureEnd
    || summary.kjPaperJournalPath !== sourceReport.run.journalPath
    || safety.liveClientConstructed !== false
    || safety.userChannelConnected !== false
    || safety.credentialsRead !== false
    || safety.ordersSent !== 0
    || integer(summary.kjPaperJournalRecordCount, "runtime summary journal record count") !== input.journalRecordCount
    || summary.kjPaperJournalLastRecordHash !== input.journalLastRecordHash
    || integer(summary.kjPaperEventCount, "runtime summary paper event count") !== input.events.length) {
    throw new Error("runtime summary does not match the verified paper run");
  }
  if (input.journalLastRecordHash === null || !HASH.test(input.journalLastRecordHash)) {
    throw new Error("journal replay has no valid tail hash");
  }
  const started = utc(summary.startedAt, "runtime summary startedAt");
  const ended = utc(summary.endedAt, "runtime summary endedAt");
  if (ended <= started) throw new Error("runtime summary duration is invalid");
  const target = targetSettlementEvidence(input.artifact);
  return Object.freeze({
    run: Object.freeze({
      runId: cohortRun.runId,
      runtimeDurationMilliseconds: String(ended - started),
      journalRecordCount: String(input.journalRecordCount),
      journalLastRecordHash: input.journalLastRecordHash,
      streams: streamCounters(summary.streams, "runtime summary streams"),
      settlementDelay: settlementDelay(target.delays),
      execution: executionCounters(input.events, target.targetMarketIds),
    }),
    delays: target.delays,
  });
}

export function buildKJPaperCohortObservabilityReport(
  inputs: readonly KJPaperCohortObservabilityInput[],
): KJPaperCohortObservabilityReport {
  const pnlCohort = buildKJPaperCohortReport(inputs);
  const bySource = new Map(inputs.map((input) => [input.sourcePath, input]));
  const measured = pnlCohort.runs.map((run) => {
    const input = bySource.get(run.sourcePath);
    if (input === undefined) throw new Error("verified cohort run lacks observability input");
    return buildRun(input, run);
  });
  const runs = measured.map((item) => item.run);
  const settlementDelays = measured.flatMap((item) => item.delays);
  return Object.freeze({
    schemaVersion: KJ_PAPER_COHORT_OBSERVABILITY_REPORT_VERSION,
    evidenceStatus: "DESCRIPTIVE_PAPER_ONLY",
    profitabilityClaimEligible: false,
    pnlCohort,
    runs: Object.freeze(runs),
    aggregate: Object.freeze({
      streams: aggregateStreams(runs),
      settlementDelay: settlementDelay(settlementDelays),
      execution: aggregateExecution(runs),
    }),
  });
}

export function kjPaperCohortObservabilityReportHash(value: KJPaperCohortObservabilityReport): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}
