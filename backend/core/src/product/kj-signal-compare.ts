import { createHash } from "node:crypto";

export const KJ_SIGNAL_COMPARE_VERSION = "kj-signal-compare-v1" as const;
export const KJ_SIGNAL_COMPARE_ARTIFACT_VERSION = "kj-signal-compare-artifact-v1" as const;

const MARKET_INTERVAL_MILLISECONDS = 300_000;
const COMMIT = /^[0-9a-f]{40,64}$/u;
const RUN_ID = /^[a-z0-9][a-z0-9-]{7,79}$/u;

export type KJSignalCompareSource = "BINANCE_SPOT" | "POLYMARKET_RTDS_CHAINLINK";

export interface KJSignalCompareSourceRun {
  readonly source: KJSignalCompareSource;
  readonly runId: string;
}

export interface KJSignalComparePlanInput {
  readonly compareRunId: string;
  readonly plannedAt: string;
  readonly collectorGitCommit: string;
  readonly firstFullMarketStart: string;
  readonly targetMarketCount: number;
  readonly settlementGraceSeconds: number;
  /**
   * Optional source run identities supplied by a pre-registered multi-run
   * campaign.  The default keeps the standalone one-run naming contract.
   */
  readonly sourceRuns?: readonly KJSignalCompareSourceRun[];
}

export interface KJSignalComparePlan {
  readonly schemaVersion: typeof KJ_SIGNAL_COMPARE_VERSION;
  readonly compareRunId: string;
  readonly plannedAt: string;
  readonly collectorGitCommit: string;
  readonly firstFullMarketStart: string;
  readonly captureEnd: string;
  readonly targetMarketCount: number;
  readonly settlementGraceSeconds: number;
  readonly sourceRuns: readonly KJSignalCompareSourceRun[];
}

export interface KJSignalCompareArtifact {
  readonly schemaVersion: typeof KJ_SIGNAL_COMPARE_ARTIFACT_VERSION;
  readonly plan: KJSignalComparePlan;
  readonly planHash: string;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("signal compare JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  throw new Error("signal compare accepts only JSON values");
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be non-empty`);
  return value;
}

function utc(value: unknown, field: string): string {
  const candidate = text(value, field);
  if (!candidate.endsWith("Z") || !Number.isFinite(Date.parse(candidate))) throw new Error(`${field} must be explicit UTC`);
  return candidate;
}

function positiveInteger(value: unknown, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new Error(`${field} must be an integer from 1 through ${maximum}`);
  }
  return value as number;
}

function sourceRunId(compareRunId: string, suffix: "binance" | "chainlink"): string {
  const value = `${compareRunId}-${suffix}-r001`;
  if (!RUN_ID.test(value)) throw new Error("compareRunId cannot form safe source run IDs");
  return value;
}

function sourceRuns(
  compareRunId: string,
  value: readonly KJSignalCompareSourceRun[] | undefined,
): readonly KJSignalCompareSourceRun[] {
  const defaults = [
    Object.freeze({ source: "BINANCE_SPOT" as const, runId: sourceRunId(compareRunId, "binance") }),
    Object.freeze({ source: "POLYMARKET_RTDS_CHAINLINK" as const, runId: sourceRunId(compareRunId, "chainlink") }),
  ];
  if (value === undefined) return Object.freeze(defaults);
  if (value.length !== 2) throw new Error("signal compare requires exactly two source runs");
  const bySource = new Map(value.map((run) => [run.source, run.runId]));
  const binance = bySource.get("BINANCE_SPOT");
  const chainlink = bySource.get("POLYMARKET_RTDS_CHAINLINK");
  if (binance === undefined || chainlink === undefined || binance === chainlink
    || !RUN_ID.test(binance) || !RUN_ID.test(chainlink)) {
    throw new Error("signal compare source runs are invalid");
  }
  return Object.freeze([
    Object.freeze({ source: "BINANCE_SPOT" as const, runId: binance }),
    Object.freeze({ source: "POLYMARKET_RTDS_CHAINLINK" as const, runId: chainlink }),
  ]);
}

export function kjSignalComparePlanHash(plan: KJSignalComparePlan): string {
  return createHash("sha256").update(stableJson(plan), "utf8").digest("hex");
}

export function buildKJSignalComparePlan(input: KJSignalComparePlanInput): KJSignalComparePlan {
  const compareRunId = text(input.compareRunId, "compareRunId");
  if (!RUN_ID.test(compareRunId)) throw new Error("compareRunId contains unsupported characters");
  const plannedAt = utc(input.plannedAt, "plannedAt");
  const firstFullMarketStart = utc(input.firstFullMarketStart, "firstFullMarketStart");
  const first = Date.parse(firstFullMarketStart);
  if (first % MARKET_INTERVAL_MILLISECONDS !== 0) throw new Error("firstFullMarketStart must be a five-minute boundary");
  if (Date.parse(plannedAt) >= first) throw new Error("signal compare must be planned before its first target market");
  const collectorGitCommit = text(input.collectorGitCommit, "collectorGitCommit");
  if (!COMMIT.test(collectorGitCommit)) throw new Error("collectorGitCommit is invalid");
  const targetMarketCount = positiveInteger(input.targetMarketCount, "targetMarketCount", 12);
  const settlementGraceSeconds = positiveInteger(input.settlementGraceSeconds, "settlementGraceSeconds", 1_800);
  return Object.freeze({
    schemaVersion: KJ_SIGNAL_COMPARE_VERSION,
    compareRunId,
    plannedAt,
    collectorGitCommit,
    firstFullMarketStart,
    captureEnd: new Date(first + targetMarketCount * MARKET_INTERVAL_MILLISECONDS).toISOString(),
    targetMarketCount,
    settlementGraceSeconds,
    sourceRuns: sourceRuns(compareRunId, input.sourceRuns),
  });
}

export function signalCompareArtifact(plan: KJSignalComparePlan): KJSignalCompareArtifact {
  return Object.freeze({
    schemaVersion: KJ_SIGNAL_COMPARE_ARTIFACT_VERSION,
    plan,
    planHash: kjSignalComparePlanHash(plan),
  });
}

export function parseKJSignalCompareArtifact(value: unknown): KJSignalCompareArtifact {
  const artifact = object(value, "signal compare artifact");
  if (artifact.schemaVersion !== KJ_SIGNAL_COMPARE_ARTIFACT_VERSION) throw new Error("signal compare artifact schema is unsupported");
  const plan = object(artifact.plan, "signal compare plan");
  const rebuilt = buildKJSignalComparePlan({
    compareRunId: text(plan.compareRunId, "compareRunId"),
    plannedAt: utc(plan.plannedAt, "plannedAt"),
    collectorGitCommit: text(plan.collectorGitCommit, "collectorGitCommit"),
    firstFullMarketStart: utc(plan.firstFullMarketStart, "firstFullMarketStart"),
    targetMarketCount: positiveInteger(plan.targetMarketCount, "targetMarketCount", 12),
    settlementGraceSeconds: positiveInteger(plan.settlementGraceSeconds, "settlementGraceSeconds", 1_800),
    sourceRuns: Array.isArray(plan.sourceRuns) ? plan.sourceRuns.map((run) => {
      const parsed = object(run, "signal compare source run");
      const source = parsed.source;
      if (source !== "BINANCE_SPOT" && source !== "POLYMARKET_RTDS_CHAINLINK") {
        throw new Error("signal compare source is unsupported");
      }
      return { source, runId: text(parsed.runId, "signal compare source runId") };
    }) : (() => { throw new Error("signal compare sourceRuns must be an array"); })(),
  });
  if (stableJson(plan) !== stableJson(rebuilt)) throw new Error("signal compare plan fields are inconsistent");
  const planHash = text(artifact.planHash, "planHash");
  if (!/^[0-9a-f]{64}$/u.test(planHash) || planHash !== kjSignalComparePlanHash(rebuilt)) {
    throw new Error("signal compare artifact hash mismatch");
  }
  return signalCompareArtifact(rebuilt);
}
