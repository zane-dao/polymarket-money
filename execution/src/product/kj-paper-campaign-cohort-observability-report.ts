import { createHash } from "node:crypto";

import {
  buildKJPaperCampaignCohortReport,
  type KJPaperCampaignCohortReport,
} from "./kj-paper-campaign-cohort-report.js";
import {
  buildKJPaperCohortObservabilityReport,
  type KJPaperCohortObservabilityInput,
  type KJPaperCohortObservabilityReport,
} from "./kj-paper-cohort-observability-report.js";

export const KJ_PAPER_CAMPAIGN_COHORT_OBSERVABILITY_REPORT_VERSION = "kj-paper-campaign-cohort-observability-report-v1" as const;

export interface BuildKJPaperCampaignCohortObservabilityReportInput {
  readonly campaignArtifact: unknown;
  readonly reports: readonly KJPaperCohortObservabilityInput[];
}

export interface KJPaperCampaignCohortObservabilityReport {
  readonly schemaVersion: typeof KJ_PAPER_CAMPAIGN_COHORT_OBSERVABILITY_REPORT_VERSION;
  readonly evidenceStatus: "DESCRIPTIVE_PAPER_ONLY";
  readonly profitabilityClaimEligible: false;
  readonly campaignCohort: KJPaperCampaignCohortReport;
  readonly observability: KJPaperCohortObservabilityReport;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("campaign observability JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  throw new Error("campaign observability report accepts only JSON values");
}

export function kjPaperCampaignCohortObservabilityReportHash(value: KJPaperCampaignCohortObservabilityReport): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

export function buildKJPaperCampaignCohortObservabilityReport(
  input: BuildKJPaperCampaignCohortObservabilityReportInput,
): KJPaperCampaignCohortObservabilityReport {
  const campaignCohort = buildKJPaperCampaignCohortReport({
    campaignArtifact: input.campaignArtifact,
    reports: input.reports,
  });
  const observability = buildKJPaperCohortObservabilityReport(input.reports);
  if (observability.pnlCohort.runCount !== campaignCohort.cohort.runCount
    || observability.pnlCohort.runs.length !== campaignCohort.cohort.runs.length
    || observability.pnlCohort.runs.some((run, index) => (
      run.runId !== campaignCohort.cohort.runs[index]?.runId
      || run.artifactHash !== campaignCohort.cohort.runs[index]?.artifactHash
    ))) {
    throw new Error("campaign observability inputs differ from the verified campaign cohort");
  }
  return Object.freeze({
    schemaVersion: KJ_PAPER_CAMPAIGN_COHORT_OBSERVABILITY_REPORT_VERSION,
    evidenceStatus: "DESCRIPTIVE_PAPER_ONLY",
    profitabilityClaimEligible: false,
    campaignCohort,
    observability,
  });
}
