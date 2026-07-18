import { createHash } from "node:crypto";

import {
  buildKJPaperCampaign,
  campaignArtifact,
  parseKJPaperCampaignArtifact,
  type KJPaperCampaignArtifact,
} from "./kj-paper-campaign.js";
import {
  buildKJSignalComparePlan,
  signalCompareArtifact,
  type KJSignalCompareArtifact,
} from "./kj-signal-compare.js";

export const KJ_SIGNAL_COMPARE_CAMPAIGN_ARTIFACT_VERSION = "kj-signal-compare-campaign-artifact-v1" as const;

const INTERVAL_MILLISECONDS = 300_000;
// Each source suffix is eight characters (for example, "-binance"); keep the
// derived KJ paper campaign ID within its 63-character contract.
const CAMPAIGN_ID = /^[a-z0-9][a-z0-9-]{2,54}$/u;
const HASH = /^[0-9a-f]{40,64}$/u;

export interface KJSignalCompareCampaignPlanInput {
  readonly campaignId: string;
  readonly plannedAt: string;
  readonly collectorGitCommit: string;
  readonly firstFullMarketStart: string;
  readonly runCount: number;
  readonly targetMarketCount: number;
  readonly settlementGraceSeconds: number;
  readonly gapMarketCount: number;
}

export interface KJSignalCompareCampaignArtifact {
  readonly schemaVersion: typeof KJ_SIGNAL_COMPARE_CAMPAIGN_ARTIFACT_VERSION;
  readonly campaignId: string;
  readonly plannedAt: string;
  readonly collectorGitCommit: string;
  readonly binanceCampaign: KJPaperCampaignArtifact;
  readonly chainlinkCampaign: KJPaperCampaignArtifact;
  readonly comparisons: readonly KJSignalCompareArtifact[];
  readonly campaignHash: string;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("signal compare campaign JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  throw new Error("signal compare campaign accepts only JSON values");
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

function nonNegativeInteger(value: unknown, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${field} must be an integer from 0 through ${maximum}`);
  }
  return value as number;
}

function base(input: KJSignalCompareCampaignPlanInput): Required<KJSignalCompareCampaignPlanInput> {
  const campaignId = text(input.campaignId, "campaignId");
  if (!CAMPAIGN_ID.test(campaignId)) throw new Error("campaignId cannot form safe source campaign IDs");
  const plannedAt = utc(input.plannedAt, "plannedAt");
  const firstFullMarketStart = utc(input.firstFullMarketStart, "firstFullMarketStart");
  if (Date.parse(firstFullMarketStart) % INTERVAL_MILLISECONDS !== 0) {
    throw new Error("firstFullMarketStart must be a five-minute boundary");
  }
  if (Date.parse(plannedAt) >= Date.parse(firstFullMarketStart)) throw new Error("campaign must be planned before its first target market");
  const collectorGitCommit = text(input.collectorGitCommit, "collectorGitCommit");
  if (!HASH.test(collectorGitCommit)) throw new Error("collectorGitCommit is invalid");
  return {
    campaignId, plannedAt, collectorGitCommit, firstFullMarketStart,
    runCount: positiveInteger(input.runCount, "runCount", 48),
    targetMarketCount: positiveInteger(input.targetMarketCount, "targetMarketCount", 12),
    settlementGraceSeconds: positiveInteger(input.settlementGraceSeconds, "settlementGraceSeconds", 1_800),
    gapMarketCount: nonNegativeInteger(input.gapMarketCount, "gapMarketCount", 288),
  };
}

export function kjSignalCompareCampaignHash(value: Omit<KJSignalCompareCampaignArtifact, "campaignHash">): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

export function buildKJSignalCompareCampaign(input: KJSignalCompareCampaignPlanInput): KJSignalCompareCampaignArtifact {
  const plan = base(input);
  const source = (suffix: "binance" | "chainlink") => campaignArtifact(buildKJPaperCampaign({
    campaignId: `${plan.campaignId}-${suffix}`,
    plannedAt: plan.plannedAt,
    collectorGitCommit: plan.collectorGitCommit,
    firstFullMarketStart: plan.firstFullMarketStart,
    runCount: plan.runCount,
    targetMarketCount: plan.targetMarketCount,
    settlementGraceSeconds: plan.settlementGraceSeconds,
    gapMarketCount: plan.gapMarketCount,
  }));
  const binanceCampaign = source("binance");
  const chainlinkCampaign = source("chainlink");
  const comparisons = Object.freeze(binanceCampaign.campaign.runs.map((binance, offset) => {
    const chainlink = chainlinkCampaign.campaign.runs[offset];
    if (chainlink === undefined || chainlink.firstFullMarketStart !== binance.firstFullMarketStart
      || chainlink.captureEnd !== binance.captureEnd) throw new Error("source campaigns are not matched");
    return signalCompareArtifact(buildKJSignalComparePlan({
      compareRunId: `${plan.campaignId}-r${String(binance.runIndex).padStart(3, "0")}`,
      plannedAt: plan.plannedAt,
      collectorGitCommit: plan.collectorGitCommit,
      firstFullMarketStart: binance.firstFullMarketStart,
      targetMarketCount: plan.targetMarketCount,
      settlementGraceSeconds: plan.settlementGraceSeconds,
      sourceRuns: [
        { source: "BINANCE_SPOT", runId: binance.runId },
        { source: "POLYMARKET_RTDS_CHAINLINK", runId: chainlink.runId },
      ],
    }));
  }));
  const unsigned = Object.freeze({
    schemaVersion: KJ_SIGNAL_COMPARE_CAMPAIGN_ARTIFACT_VERSION,
    campaignId: plan.campaignId,
    plannedAt: plan.plannedAt,
    collectorGitCommit: plan.collectorGitCommit,
    binanceCampaign,
    chainlinkCampaign,
    comparisons,
  });
  return Object.freeze({ ...unsigned, campaignHash: kjSignalCompareCampaignHash(unsigned) });
}

export function parseKJSignalCompareCampaignArtifact(value: unknown): KJSignalCompareCampaignArtifact {
  const artifact = object(value, "signal compare campaign artifact");
  if (artifact.schemaVersion !== KJ_SIGNAL_COMPARE_CAMPAIGN_ARTIFACT_VERSION) throw new Error("signal compare campaign schema is unsupported");
  const binanceCampaign = parseKJPaperCampaignArtifact(artifact.binanceCampaign);
  const chainlinkCampaign = parseKJPaperCampaignArtifact(artifact.chainlinkCampaign);
  const comparisons = Array.isArray(artifact.comparisons)
    ? artifact.comparisons.map((item) => {
      const candidate = object(item, "signal compare campaign comparison");
      return signalCompareArtifact(buildKJSignalComparePlan({
        compareRunId: text(object(candidate.plan, "signal compare plan").compareRunId, "compareRunId"),
        plannedAt: utc(object(candidate.plan, "signal compare plan").plannedAt, "plannedAt"),
        collectorGitCommit: text(object(candidate.plan, "signal compare plan").collectorGitCommit, "collectorGitCommit"),
        firstFullMarketStart: utc(object(candidate.plan, "signal compare plan").firstFullMarketStart, "firstFullMarketStart"),
        targetMarketCount: positiveInteger(object(candidate.plan, "signal compare plan").targetMarketCount, "targetMarketCount", 12),
        settlementGraceSeconds: positiveInteger(object(candidate.plan, "signal compare plan").settlementGraceSeconds, "settlementGraceSeconds", 1_800),
        sourceRuns: object(candidate.plan, "signal compare plan").sourceRuns as never,
      }));
    }) : (() => { throw new Error("signal compare campaign comparisons must be an array"); })();
  const first = binanceCampaign.campaign.runs[0];
  if (first === undefined) throw new Error("signal compare campaign requires runs");
  const second = binanceCampaign.campaign.runs[1];
  const gapMarketCount = second === undefined ? 0 : (Date.parse(second.firstFullMarketStart) - Date.parse(first.firstFullMarketStart)) / INTERVAL_MILLISECONDS - first.targetMarketCount;
  const rebuilt = buildKJSignalCompareCampaign({
    campaignId: text(artifact.campaignId, "campaignId"),
    plannedAt: utc(artifact.plannedAt, "plannedAt"),
    collectorGitCommit: text(artifact.collectorGitCommit, "collectorGitCommit"),
    firstFullMarketStart: first.firstFullMarketStart,
    runCount: binanceCampaign.campaign.runs.length,
    targetMarketCount: first.targetMarketCount,
    settlementGraceSeconds: first.settlementGraceSeconds,
    gapMarketCount: nonNegativeInteger(gapMarketCount, "gapMarketCount", 288),
  });
  if (stableJson(binanceCampaign) !== stableJson(rebuilt.binanceCampaign)
    || stableJson(chainlinkCampaign) !== stableJson(rebuilt.chainlinkCampaign)
    || stableJson(comparisons) !== stableJson(rebuilt.comparisons)) {
    throw new Error("signal compare campaign fields are inconsistent");
  }
  const campaignHash = text(artifact.campaignHash, "campaignHash");
  if (!/^[0-9a-f]{64}$/u.test(campaignHash) || campaignHash !== rebuilt.campaignHash) {
    throw new Error("signal compare campaign hash mismatch");
  }
  return rebuilt;
}
