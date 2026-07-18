import { createHash } from "node:crypto";

import {
  parseKJPaperCampaignArtifact,
  type KJPaperCampaignArtifact,
} from "./kj-paper-campaign.js";
import {
  buildKJPaperCohortReport,
  type KJPaperCohortInput,
  type KJPaperCohortReport,
} from "./kj-paper-cohort-report.js";
import { kjPaperReportArtifactHash, type KJPaperReport, type KJPaperReportArtifactCore } from "./kj-paper-report.js";

export const KJ_PAPER_CAMPAIGN_COHORT_REPORT_VERSION = "kj-paper-campaign-cohort-report-v1" as const;

export interface BuildKJPaperCampaignCohortReportInput {
  readonly campaignArtifact: unknown;
  readonly reports: readonly KJPaperCohortInput[];
}

export interface KJPaperCampaignCohortReport {
  readonly schemaVersion: typeof KJ_PAPER_CAMPAIGN_COHORT_REPORT_VERSION;
  readonly evidenceStatus: "DESCRIPTIVE_PAPER_ONLY";
  readonly profitabilityClaimEligible: false;
  readonly campaign: Readonly<{
    campaignId: string;
    campaignHash: string;
    collectorGitCommit: string;
    plannedAt: string;
    runCount: string;
  }>;
  readonly cohort: KJPaperCohortReport;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("campaign cohort JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  throw new Error("campaign cohort accepts only JSON values");
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function report(input: KJPaperCohortInput): KJPaperReport {
  const outer = object(input.artifact, "paper report artifact");
  const core: KJPaperReportArtifactCore = {
    schemaVersion: outer.schemaVersion === "kj-paper-report-artifact-v1" ? "kj-paper-report-artifact-v1" : (() => { throw new Error("paper report artifact schema is unsupported"); })(),
    report: outer.report as KJPaperReport,
    sourceFileSha256: object(outer.sourceFileSha256, "paper report source hashes") as KJPaperReportArtifactCore["sourceFileSha256"],
    resultFileName: outer.resultFileName === "result.json" || outer.resultFileName === "final-result.json" ? outer.resultFileName : (() => { throw new Error("paper report result file is unsupported"); })(),
    marketsCsvSha256: typeof outer.marketsCsvSha256 === "string" ? outer.marketsCsvSha256 : (() => { throw new Error("paper report CSV hash is invalid"); })(),
  };
  if (typeof outer.artifactHash !== "string" || kjPaperReportArtifactHash(core) !== outer.artifactHash) {
    throw new Error("paper report artifact hash mismatch");
  }
  return core.report;
}

export function kjPaperCampaignCohortReportHash(value: KJPaperCampaignCohortReport): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

export function buildKJPaperCampaignCohortReport(input: BuildKJPaperCampaignCohortReportInput): KJPaperCampaignCohortReport {
  const campaign = parseKJPaperCampaignArtifact(input.campaignArtifact);
  if (input.reports.length !== campaign.campaign.runs.length) {
    throw new Error("campaign cohort requires every pre-registered campaign run exactly once");
  }
  const matched = new Set<number>();
  for (const item of input.reports) {
    const candidate = report(item);
    const binding = candidate.run.campaign;
    if (binding === undefined || binding.campaignId !== campaign.campaign.campaignId
      || binding.campaignHash !== campaign.campaignHash) {
      throw new Error("paper report is not bound to this campaign");
    }
    const scheduled = campaign.campaign.runs[binding.campaignRunIndex - 1];
    if (scheduled === undefined || matched.has(scheduled.runIndex)) {
      throw new Error("campaign cohort rejects missing or duplicate campaign run indices");
    }
    if (candidate.run.runId !== scheduled.runId
      || candidate.run.collectorGitCommit !== campaign.campaign.collectorGitCommit
      || candidate.run.targetMarketCount !== scheduled.targetMarketCount
      || candidate.run.firstFullMarketStart !== scheduled.firstFullMarketStart
      || candidate.run.captureEnd !== scheduled.captureEnd) {
      throw new Error("paper report conflicts with its pre-registered campaign run");
    }
    matched.add(scheduled.runIndex);
  }
  if (matched.size !== campaign.campaign.runs.length) throw new Error("campaign cohort lacks a pre-registered run");
  const cohort = buildKJPaperCohortReport(input.reports);
  return Object.freeze({
    schemaVersion: KJ_PAPER_CAMPAIGN_COHORT_REPORT_VERSION,
    evidenceStatus: "DESCRIPTIVE_PAPER_ONLY",
    profitabilityClaimEligible: false,
    campaign: Object.freeze({
      campaignId: campaign.campaign.campaignId,
      campaignHash: campaign.campaignHash,
      collectorGitCommit: campaign.campaign.collectorGitCommit,
      plannedAt: campaign.campaign.plannedAt,
      runCount: String(campaign.campaign.runs.length),
    }),
    cohort,
  });
}
