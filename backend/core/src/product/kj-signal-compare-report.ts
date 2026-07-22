import { createHash } from "node:crypto";

import { Money } from "../domain/money.js";
import { parseKJSignalCompareArtifact, type KJSignalCompareSource } from "./kj-signal-compare.js";
import { kjPaperReportArtifactHash, type KJPaperReport, type KJPaperReportArtifactCore } from "./kj-paper-report.js";

export const KJ_SIGNAL_COMPARE_REPORT_VERSION = "kj-signal-compare-report-v1" as const;
const HASH = /^[0-9a-f]{64}$/u;
const STRATEGIES = ["J_FEE_AWARE", "K_DUAL_VOL"] as const;

type Strategy = typeof STRATEGIES[number];

export interface BuildKJSignalCompareReportInput {
  readonly compareArtifact: unknown;
  readonly binanceArtifact: unknown;
  readonly binanceRuntimeSummary: unknown;
  readonly chainlinkArtifact: unknown;
  readonly chainlinkRuntimeSummary: unknown;
}

export interface KJSignalCompareReport {
  readonly schemaVersion: typeof KJ_SIGNAL_COMPARE_REPORT_VERSION;
  readonly evidenceStatus: "DESCRIPTIVE_PAPER_ONLY";
  readonly profitabilityClaimEligible: false;
  readonly compareRunId: string;
  readonly planHash: string;
  readonly sources: Readonly<Record<"BINANCE_SPOT" | "POLYMARKET_RTDS_CHAINLINK", Readonly<{
    runId: string;
    reportArtifactHash: string;
  }>>>;
  readonly strategies: Readonly<Record<Strategy, Readonly<{
    binance: Readonly<{ totalNetPnl: string; totalTradeCount: string; finalCash: string }>;
    chainlink: Readonly<{ totalNetPnl: string; totalTradeCount: string; finalCash: string }>;
    chainlinkMinusBinanceNetPnl: string;
  }>>>;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("signal compare report JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  throw new Error("signal compare report accepts only JSON values");
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be non-empty`);
  return value;
}

function artifact(value: unknown): { readonly report: KJPaperReport; readonly artifactHash: string } {
  const outer = object(value, "paper report artifact");
  const core: KJPaperReportArtifactCore = {
    schemaVersion: outer.schemaVersion === "kj-paper-report-artifact-v1" ? "kj-paper-report-artifact-v1" : (() => { throw new Error("paper report artifact schema is unsupported"); })(),
    report: outer.report as KJPaperReport,
    sourceFileSha256: object(outer.sourceFileSha256, "paper report source hashes") as KJPaperReportArtifactCore["sourceFileSha256"],
    resultFileName: outer.resultFileName === "result.json" || outer.resultFileName === "final-result.json" ? outer.resultFileName : (() => { throw new Error("paper report result file is invalid"); })(),
    marketsCsvSha256: text(outer.marketsCsvSha256, "paper report CSV hash"),
  };
  const artifactHash = text(outer.artifactHash, "paper report artifactHash");
  if (!HASH.test(artifactHash) || kjPaperReportArtifactHash(core) !== artifactHash) throw new Error("paper report artifact hash mismatch");
  const report = core.report;
  if (report.schemaVersion !== "kj-paper-report-v1" || report.planBinding !== "HASH_CHAINED"
    || report.evidenceStatus !== "DESCRIPTIVE_PAPER_ONLY" || report.profitabilityClaimEligible !== false) {
    throw new Error("signal comparison requires verified descriptive paper reports");
  }
  return Object.freeze({ report, artifactHash });
}

function verifyRun(
  source: KJSignalCompareSource,
  report: KJPaperReport,
  runtimeSummary: unknown,
  expected: { readonly runId: string; readonly firstFullMarketStart: string; readonly captureEnd: string; readonly targetMarketCount: number; readonly collectorGitCommit: string },
): void {
  if (report.run.runId !== expected.runId || report.run.firstFullMarketStart !== expected.firstFullMarketStart
    || report.run.captureEnd !== expected.captureEnd || report.run.targetMarketCount !== expected.targetMarketCount
    || report.run.collectorGitCommit !== expected.collectorGitCommit) {
    throw new Error("paper report does not match its paired source run");
  }
  const runtime = object(runtimeSummary, "runtime summary");
  const expectedSource = source === "BINANCE_SPOT" ? "BINANCE_SPOT" : "CHAINLINK";
  if (runtime.kjSignalSource !== expectedSource) throw new Error("runtime summary signal source conflicts with paired source run");
}

export function kjSignalCompareReportHash(value: KJSignalCompareReport): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

export function buildKJSignalCompareReport(input: BuildKJSignalCompareReportInput): KJSignalCompareReport {
  const comparison = parseKJSignalCompareArtifact(input.compareArtifact);
  const binance = artifact(input.binanceArtifact);
  const chainlink = artifact(input.chainlinkArtifact);
  const bySource = new Map(comparison.plan.sourceRuns.map((run) => [run.source, run]));
  const binanceRun = bySource.get("BINANCE_SPOT");
  const chainlinkRun = bySource.get("POLYMARKET_RTDS_CHAINLINK");
  if (binanceRun === undefined || chainlinkRun === undefined) throw new Error("comparison plan lacks a required source run");
  const expected = (runId: string) => ({ runId, firstFullMarketStart: comparison.plan.firstFullMarketStart,
    captureEnd: comparison.plan.captureEnd, targetMarketCount: comparison.plan.targetMarketCount,
    collectorGitCommit: comparison.plan.collectorGitCommit });
  verifyRun("BINANCE_SPOT", binance.report, input.binanceRuntimeSummary, expected(binanceRun.runId));
  verifyRun("POLYMARKET_RTDS_CHAINLINK", chainlink.report, input.chainlinkRuntimeSummary, expected(chainlinkRun.runId));
  const strategies = Object.freeze(Object.fromEntries(STRATEGIES.map((strategy) => {
    const left = binance.report.strategies[strategy];
    const right = chainlink.report.strategies[strategy];
    return [strategy, Object.freeze({
      binance: Object.freeze({ totalNetPnl: left.totalNetPnl, totalTradeCount: left.totalTradeCount, finalCash: left.finalCash }),
      chainlink: Object.freeze({ totalNetPnl: right.totalNetPnl, totalTradeCount: right.totalTradeCount, finalCash: right.finalCash }),
      chainlinkMinusBinanceNetPnl: Money.from(right.totalNetPnl).minus(Money.from(left.totalNetPnl)).toCanonical(),
    })] as const;
  })) as Record<Strategy, KJSignalCompareReport["strategies"][Strategy]>);
  return Object.freeze({
    schemaVersion: KJ_SIGNAL_COMPARE_REPORT_VERSION,
    evidenceStatus: "DESCRIPTIVE_PAPER_ONLY",
    profitabilityClaimEligible: false,
    compareRunId: comparison.plan.compareRunId,
    planHash: comparison.planHash,
    sources: Object.freeze({
      BINANCE_SPOT: Object.freeze({ runId: binanceRun.runId, reportArtifactHash: binance.artifactHash }),
      POLYMARKET_RTDS_CHAINLINK: Object.freeze({ runId: chainlinkRun.runId, reportArtifactHash: chainlink.artifactHash }),
    }),
    strategies,
  });
}
