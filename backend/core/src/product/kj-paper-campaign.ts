import { createHash } from "node:crypto";

export const KJ_PAPER_CAMPAIGN_VERSION = "kj-paper-campaign-v1" as const;
export const KJ_PAPER_CAMPAIGN_ARTIFACT_VERSION = "kj-paper-campaign-artifact-v1" as const;
const MARKET_INTERVAL_MILLISECONDS = 300_000;
const HASH = /^[0-9a-f]{40,64}$/u;
const CAMPAIGN_ID = /^[a-z0-9][a-z0-9-]{2,63}$/u;

export interface KJPaperCampaignRun {
  readonly runIndex: number;
  readonly runId: string;
  readonly firstFullMarketStart: string;
  readonly captureEnd: string;
  readonly targetMarketCount: number;
  readonly settlementGraceSeconds: number;
}

export interface KJPaperCampaign {
  readonly schemaVersion: typeof KJ_PAPER_CAMPAIGN_VERSION;
  readonly campaignId: string;
  readonly plannedAt: string;
  readonly collectorGitCommit: string;
  readonly runs: readonly KJPaperCampaignRun[];
}

export interface KJPaperCampaignArtifact {
  readonly schemaVersion: typeof KJ_PAPER_CAMPAIGN_ARTIFACT_VERSION;
  readonly campaign: KJPaperCampaign;
  readonly campaignHash: string;
}

export interface KJPaperCampaignPlanInput {
  readonly campaignId: string;
  readonly plannedAt: string;
  readonly collectorGitCommit: string;
  readonly firstFullMarketStart: string;
  readonly runCount: number;
  readonly targetMarketCount: number;
  readonly settlementGraceSeconds: number;
  readonly gapMarketCount: number;
}

export interface KJPaperCampaignBinding {
  readonly campaignId: string;
  readonly campaignHash: string;
  readonly campaignRunIndex: number;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("campaign JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  throw new Error("campaign accepts only JSON values");
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

function isBoundary(value: string): boolean {
  return Date.parse(value) % MARKET_INTERVAL_MILLISECONDS === 0;
}

function runId(campaignId: string, index: number): string {
  return `${campaignId}-r${String(index).padStart(3, "0")}`;
}

export function kjPaperCampaignHash(campaign: KJPaperCampaign): string {
  return createHash("sha256").update(stableJson(campaign), "utf8").digest("hex");
}

export function buildKJPaperCampaign(input: KJPaperCampaignPlanInput): KJPaperCampaign {
  if (!CAMPAIGN_ID.test(input.campaignId)) throw new Error("campaignId contains unsupported characters");
  const plannedAt = utc(input.plannedAt, "plannedAt");
  const firstFullMarketStart = utc(input.firstFullMarketStart, "firstFullMarketStart");
  if (!isBoundary(firstFullMarketStart)) throw new Error("firstFullMarketStart must be a five-minute boundary");
  if (Date.parse(plannedAt) >= Date.parse(firstFullMarketStart)) {
    throw new Error("campaign must be planned before its first target market");
  }
  const collectorGitCommit = text(input.collectorGitCommit, "collectorGitCommit");
  if (!HASH.test(collectorGitCommit)) throw new Error("collectorGitCommit is invalid");
  const runCount = positiveInteger(input.runCount, "runCount", 48);
  const targetMarketCount = positiveInteger(input.targetMarketCount, "targetMarketCount", 12);
  const settlementGraceSeconds = positiveInteger(input.settlementGraceSeconds, "settlementGraceSeconds", 1_800);
  const gapMarketCount = nonNegativeInteger(input.gapMarketCount, "gapMarketCount", 288);
  const runSpan = targetMarketCount + gapMarketCount;
  const first = Date.parse(firstFullMarketStart);
  const runs = Array.from({ length: runCount }, (_, offset) => {
    const runIndex = offset + 1;
    const start = first + offset * runSpan * MARKET_INTERVAL_MILLISECONDS;
    const captureEnd = start + targetMarketCount * MARKET_INTERVAL_MILLISECONDS;
    return Object.freeze({
      runIndex,
      runId: runId(input.campaignId, runIndex),
      firstFullMarketStart: new Date(start).toISOString(),
      captureEnd: new Date(captureEnd).toISOString(),
      targetMarketCount,
      settlementGraceSeconds,
    });
  });
  return Object.freeze({
    schemaVersion: KJ_PAPER_CAMPAIGN_VERSION,
    campaignId: input.campaignId,
    plannedAt,
    collectorGitCommit,
    runs: Object.freeze(runs),
  });
}

export function campaignArtifact(campaign: KJPaperCampaign): KJPaperCampaignArtifact {
  return Object.freeze({
    schemaVersion: KJ_PAPER_CAMPAIGN_ARTIFACT_VERSION,
    campaign,
    campaignHash: kjPaperCampaignHash(campaign),
  });
}

export function parseKJPaperCampaignArtifact(value: unknown): KJPaperCampaignArtifact {
  const artifact = object(value, "campaign artifact");
  if (artifact.schemaVersion !== KJ_PAPER_CAMPAIGN_ARTIFACT_VERSION) throw new Error("campaign artifact schema is unsupported");
  const campaign = object(artifact.campaign, "campaign");
  const rebuilt = buildKJPaperCampaign({
    campaignId: text(campaign.campaignId, "campaignId"),
    plannedAt: utc(campaign.plannedAt, "plannedAt"),
    collectorGitCommit: text(campaign.collectorGitCommit, "collectorGitCommit"),
    firstFullMarketStart: Array.isArray(campaign.runs) && campaign.runs.length > 0
      ? utc(object(campaign.runs[0], "campaign first run").firstFullMarketStart, "firstFullMarketStart")
      : (() => { throw new Error("campaign requires at least one run"); })(),
    runCount: Array.isArray(campaign.runs) ? campaign.runs.length : (() => { throw new Error("campaign runs must be an array"); })(),
    targetMarketCount: Array.isArray(campaign.runs) && campaign.runs.length > 0
      ? positiveInteger(object(campaign.runs[0], "campaign first run").targetMarketCount, "targetMarketCount", 12)
      : 0,
    settlementGraceSeconds: Array.isArray(campaign.runs) && campaign.runs.length > 0
      ? positiveInteger(object(campaign.runs[0], "campaign first run").settlementGraceSeconds, "settlementGraceSeconds", 1_800)
      : 0,
    gapMarketCount: (() => {
      const runs = campaign.runs;
      if (!Array.isArray(runs) || runs.length < 2) return 0;
      const first = object(runs[0], "campaign first run");
      const second = object(runs[1], "campaign second run");
      const span = (Date.parse(utc(second.firstFullMarketStart, "second run firstFullMarketStart"))
        - Date.parse(utc(first.firstFullMarketStart, "first run firstFullMarketStart"))) / MARKET_INTERVAL_MILLISECONDS;
      return nonNegativeInteger(span - positiveInteger(first.targetMarketCount, "targetMarketCount", 12), "gapMarketCount", 288);
    })(),
  });
  if (stableJson(campaign) !== stableJson(rebuilt)) throw new Error("campaign artifact fields are inconsistent");
  const campaignHash = text(artifact.campaignHash, "campaignHash");
  if (!/^[0-9a-f]{64}$/u.test(campaignHash) || campaignHash !== kjPaperCampaignHash(rebuilt)) {
    throw new Error("campaign artifact hash mismatch");
  }
  return campaignArtifact(rebuilt);
}

export function campaignRun(artifact: KJPaperCampaignArtifact, campaignRunIndex: number): KJPaperCampaignRun {
  const index = positiveInteger(campaignRunIndex, "campaignRunIndex", artifact.campaign.runs.length);
  return artifact.campaign.runs[index - 1]!;
}

export function campaignBinding(artifact: KJPaperCampaignArtifact, campaignRunIndex: number): KJPaperCampaignBinding {
  const run = campaignRun(artifact, campaignRunIndex);
  return Object.freeze({
    campaignId: artifact.campaign.campaignId,
    campaignHash: artifact.campaignHash,
    campaignRunIndex: run.runIndex,
  });
}
