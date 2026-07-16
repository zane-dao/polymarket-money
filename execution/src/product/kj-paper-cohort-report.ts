import { createHash } from "node:crypto";

import { Money } from "../domain/money.js";
import {
  kjPaperReportArtifactHash,
  type KJPaperReport,
  type KJPaperReportArtifactCore,
} from "./kj-paper-report.js";

export const KJ_PAPER_COHORT_REPORT_VERSION = "kj-paper-cohort-report-v1" as const;

const STRATEGIES = ["J_FEE_AWARE", "K_DUAL_VOL"] as const;
const HASH = /^[0-9a-f]{64}$/u;

type Strategy = typeof STRATEGIES[number];

export interface KJPaperCohortInput {
  readonly artifact: unknown;
  readonly sourcePath: string;
}

interface AcceptedRun {
  readonly sourcePath: string;
  readonly artifactHash: string;
  readonly report: KJPaperReport;
}

export interface KJPaperCohortReport {
  readonly schemaVersion: typeof KJ_PAPER_COHORT_REPORT_VERSION;
  readonly evidenceStatus: "DESCRIPTIVE_PAPER_ONLY";
  readonly profitabilityClaimEligible: false;
  readonly runCount: string;
  readonly runs: readonly Readonly<{
    runId: string;
    sourcePath: string;
    artifactHash: string;
    collectorGitCommit: string;
    firstFullMarketStart: string;
    captureEnd: string;
    targetMarketCount: string;
  }>[];
  readonly strategies: Readonly<Record<Strategy, Readonly<{
    marketCount: string;
    tradeCount: string;
    profitableMarketCount: string;
    losingMarketCount: string;
    flatMarketCount: string;
    positiveRunCount: string;
    negativeRunCount: string;
    flatRunCount: string;
    totalSpent: string;
    totalGrossPnl: string;
    totalFees: string;
    totalNetPnl: string;
    averageNetPnlPerMarket: string;
  }>>>;
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

function count(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new Error(`${field} must be a canonical non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field} exceeds safe integer range`);
  return parsed;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cohort JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  throw new Error("cohort accepts only JSON values");
}

function accept(input: KJPaperCohortInput): AcceptedRun {
  const outer = object(input.artifact, "paper report artifact");
  const artifactHash = text(outer.artifactHash, "paper report artifactHash");
  if (!HASH.test(artifactHash)) throw new Error("paper report artifactHash is invalid");
  const core: KJPaperReportArtifactCore = {
    schemaVersion: outer.schemaVersion === "kj-paper-report-artifact-v1"
      ? "kj-paper-report-artifact-v1" : (() => { throw new Error("paper report artifact schema is unsupported"); })(),
    report: outer.report as KJPaperReport,
    sourceFileSha256: object(outer.sourceFileSha256, "paper report source hashes") as KJPaperReportArtifactCore["sourceFileSha256"],
    resultFileName: outer.resultFileName === "result.json" || outer.resultFileName === "final-result.json"
      ? outer.resultFileName : (() => { throw new Error("paper report result file is unsupported"); })(),
    marketsCsvSha256: text(outer.marketsCsvSha256, "paper report CSV hash"),
  };
  if (kjPaperReportArtifactHash(core) !== artifactHash) throw new Error("paper report artifact hash mismatch");
  const report = core.report;
  if (report.schemaVersion !== "kj-paper-report-v1"
    || report.evidenceStatus !== "DESCRIPTIVE_PAPER_ONLY"
    || report.planBinding !== "HASH_CHAINED"
    || report.profitabilityClaimEligible !== false) {
    throw new Error("cohort accepts only hash-chained descriptive paper reports");
  }
  if (!report.checks.hashChainedRunPlan || !report.checks.noPendingRisk
    || !report.checks.officialSettlementPairs || !report.checks.aggregateWalletPnlIdentity) {
    throw new Error("paper report lacks required replay checks");
  }
  if (!report.run.firstFullMarketStart.endsWith("Z") || !report.run.captureEnd.endsWith("Z")
    || Date.parse(report.run.firstFullMarketStart) >= Date.parse(report.run.captureEnd)) {
    throw new Error("paper report target window is invalid");
  }
  return Object.freeze({ sourcePath: input.sourcePath, artifactHash, report });
}

export function kjPaperCohortReportHash(value: KJPaperCohortReport): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

export function buildKJPaperCohortReport(inputs: readonly KJPaperCohortInput[]): KJPaperCohortReport {
  if (inputs.length === 0) throw new Error("cohort requires at least one paper report");
  const runs = inputs.map(accept).sort((left, right) => left.report.run.firstFullMarketStart
    .localeCompare(right.report.run.firstFullMarketStart) || left.report.run.runId.localeCompare(right.report.run.runId));
  const runIds = new Set<string>();
  let priorEnd = -Infinity;
  for (const run of runs) {
    if (runIds.has(run.report.run.runId)) throw new Error("cohort rejects duplicate run IDs");
    runIds.add(run.report.run.runId);
    const start = Date.parse(run.report.run.firstFullMarketStart);
    if (start < priorEnd) throw new Error("cohort rejects overlapping target windows");
    priorEnd = Date.parse(run.report.run.captureEnd);
  }

  const strategies = Object.fromEntries(STRATEGIES.map((strategy) => {
    let marketCount = 0;
    let tradeCount = 0;
    let profitable = 0;
    let losing = 0;
    let flat = 0;
    let positiveRuns = 0;
    let negativeRuns = 0;
    let flatRuns = 0;
    let spent = Money.from("0");
    let gross = Money.from("0");
    let fees = Money.from("0");
    let net = Money.from("0");
    for (const run of runs) {
      const summary = run.report.strategies[strategy];
      marketCount += count(summary.marketCount, `${strategy} marketCount`);
      tradeCount += count(summary.totalTradeCount, `${strategy} totalTradeCount`);
      profitable += count(summary.profitableMarketCount, `${strategy} profitableMarketCount`);
      losing += count(summary.losingMarketCount, `${strategy} losingMarketCount`);
      flat += count(summary.flatMarketCount, `${strategy} flatMarketCount`);
      spent = spent.plus(Money.from(summary.totalSpent));
      gross = gross.plus(Money.from(summary.totalGrossPnl));
      fees = fees.plus(Money.from(summary.totalFees));
      const runNet = Money.from(summary.totalNetPnl);
      net = net.plus(runNet);
      if (runNet.comparedTo(Money.from("0")) > 0) positiveRuns += 1;
      else if (runNet.comparedTo(Money.from("0")) < 0) negativeRuns += 1;
      else flatRuns += 1;
    }
    if (marketCount === 0) throw new Error(`${strategy} cohort has no markets`);
    return [strategy, Object.freeze({
      marketCount: String(marketCount), tradeCount: String(tradeCount),
      profitableMarketCount: String(profitable), losingMarketCount: String(losing), flatMarketCount: String(flat),
      positiveRunCount: String(positiveRuns), negativeRunCount: String(negativeRuns), flatRunCount: String(flatRuns),
      totalSpent: spent.toCanonical(), totalGrossPnl: gross.toCanonical(), totalFees: fees.toCanonical(),
      totalNetPnl: net.toCanonical(), averageNetPnlPerMarket: net.dividedBy(Money.from(String(marketCount))).toCanonical(),
    })] as const;
  })) as Record<Strategy, KJPaperCohortReport["strategies"][Strategy]>;

  return Object.freeze({
    schemaVersion: KJ_PAPER_COHORT_REPORT_VERSION,
    evidenceStatus: "DESCRIPTIVE_PAPER_ONLY",
    profitabilityClaimEligible: false,
    runCount: String(runs.length),
    runs: Object.freeze(runs.map((run) => Object.freeze({
      runId: run.report.run.runId, sourcePath: run.sourcePath, artifactHash: run.artifactHash,
      collectorGitCommit: run.report.run.collectorGitCommit,
      firstFullMarketStart: run.report.run.firstFullMarketStart, captureEnd: run.report.run.captureEnd,
      targetMarketCount: String(run.report.run.targetMarketCount),
    }))),
    strategies: Object.freeze(strategies),
  });
}
