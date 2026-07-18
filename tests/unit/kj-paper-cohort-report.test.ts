import assert from "node:assert/strict";
import test from "node:test";

import {
  buildKJPaperCohortReport,
  kjPaperCohortReportHash,
} from "../../execution/src/product/kj-paper-cohort-report.js";
import { kjPaperReportArtifactHash } from "../../execution/src/product/kj-paper-report.js";
import { campaignArtifact, buildKJPaperCampaign } from "../../execution/src/product/kj-paper-campaign.js";
import {
  buildKJPaperCampaignCohortReport,
  kjPaperCampaignCohortReportHash,
} from "../../execution/src/product/kj-paper-campaign-cohort-report.js";

function artifact(
  runId: string,
  start: string,
  end: string,
  jNet: string,
  campaign?: { campaignId: string; campaignHash: string; campaignRunIndex: number },
): unknown {
  const report = {
    schemaVersion: "kj-paper-report-v1" as const,
    evidenceStatus: "DESCRIPTIVE_PAPER_ONLY" as const,
    profitabilityClaimEligible: false as const,
    planBinding: "HASH_CHAINED" as const,
    run: { runId, collectorGitCommit: "a".repeat(40), targetMarketCount: 1, firstFullMarketStart: start, captureEnd: end, journalPath: "/tmp/kj-inputs.ndjson", journalRecordCount: "10", journalLastRecordHash: "b".repeat(64), resultKind: "INITIAL" as const, ...(campaign === undefined ? {} : { campaign }) },
    checks: { hashChainedRunPlan: true as const, noPendingRisk: true as const, officialSettlementPairs: true as const, aggregateWalletPnlIdentity: true as const },
    strategies: {
      J_FEE_AWARE: { marketCount: "1", tradedMarketCount: "1", noTradeMarketCount: "0", profitableMarketCount: jNet === "0" ? "0" : "1", losingMarketCount: "0", flatMarketCount: jNet === "0" ? "1" : "0", totalTradeCount: "1", totalSpent: "1", totalGrossPnl: jNet, totalFees: "0", totalNetPnl: jNet, averageNetPnlPerMarket: jNet, finalCash: "10000" },
      K_DUAL_VOL: { marketCount: "1", tradedMarketCount: "0", noTradeMarketCount: "1", profitableMarketCount: "0", losingMarketCount: "0", flatMarketCount: "1", totalTradeCount: "0", totalSpent: "0", totalGrossPnl: "0", totalFees: "0", totalNetPnl: "0", averageNetPnlPerMarket: "0", finalCash: "10000" },
    }, markets: [],
  };
  const core = { schemaVersion: "kj-paper-report-artifact-v1" as const, report, sourceFileSha256: { runPlan: "c".repeat(64), result: "d".repeat(64), runtimeSummary: "e".repeat(64) }, resultFileName: "result.json" as const, marketsCsvSha256: "f".repeat(64) };
  return { ...core, artifactHash: kjPaperReportArtifactHash(core) };
}

test("cohort aggregates only independently bound descriptive reports", () => {
  const report = buildKJPaperCohortReport([
    { sourcePath: "/data/second/summary.json", artifact: artifact("run-2", "2026-07-17T00:05:00.000Z", "2026-07-17T00:10:00.000Z", "2") },
    { sourcePath: "/data/first/summary.json", artifact: artifact("run-1", "2026-07-17T00:00:00.000Z", "2026-07-17T00:05:00.000Z", "1") },
  ]);
  assert.equal(report.runCount, "2");
  assert.equal(report.runs[0]?.runId, "run-1");
  assert.equal(report.strategies.J_FEE_AWARE.totalNetPnl, "3");
  assert.equal(report.strategies.J_FEE_AWARE.averageNetPnlPerMarket, "1.5");
  assert.equal(report.profitabilityClaimEligible, false);
  assert.match(kjPaperCohortReportHash(report), /^[0-9a-f]{64}$/u);
});

test("campaign cohort requires every matching pre-registered run exactly once", () => {
  const campaign = campaignArtifact(buildKJPaperCampaign({
    campaignId: "campaign-test", plannedAt: "2026-07-16T23:00:00.000Z", collectorGitCommit: "a".repeat(40),
    firstFullMarketStart: "2026-07-17T00:00:00.000Z", runCount: 2, targetMarketCount: 1,
    settlementGraceSeconds: 60, gapMarketCount: 0,
  }));
  const binding = (index: number) => ({ campaignId: campaign.campaign.campaignId, campaignHash: campaign.campaignHash, campaignRunIndex: index });
  const report = buildKJPaperCampaignCohortReport({
    campaignArtifact: campaign,
    reports: [
      { sourcePath: "/data/one", artifact: artifact("campaign-test-r001", "2026-07-17T00:00:00.000Z", "2026-07-17T00:05:00.000Z", "1", binding(1)) },
      { sourcePath: "/data/two", artifact: artifact("campaign-test-r002", "2026-07-17T00:05:00.000Z", "2026-07-17T00:10:00.000Z", "2", binding(2)) },
    ],
  });
  assert.equal(report.cohort.runCount, "2");
  assert.equal(report.campaign.campaignId, "campaign-test");
  assert.match(kjPaperCampaignCohortReportHash(report), /^[0-9a-f]{64}$/u);
  assert.throws(() => buildKJPaperCampaignCohortReport({
    campaignArtifact: campaign,
    reports: [{ sourcePath: "/data/one", artifact: artifact("campaign-test-r001", "2026-07-17T00:00:00.000Z", "2026-07-17T00:05:00.000Z", "1", binding(1)) }],
  }), /every pre-registered/u);
});

test("cohort rejects duplicate, overlapping, legacy, and hash-tampered inputs", () => {
  const one = artifact("run-1", "2026-07-17T00:00:00.000Z", "2026-07-17T00:05:00.000Z", "1");
  assert.throws(() => buildKJPaperCohortReport([{ sourcePath: "/a", artifact: one }, { sourcePath: "/b", artifact: one }]), /duplicate run IDs/u);
  assert.throws(() => buildKJPaperCohortReport([
    { sourcePath: "/a", artifact: one },
    { sourcePath: "/b", artifact: artifact("run-2", "2026-07-17T00:04:00.000Z", "2026-07-17T00:09:00.000Z", "1") },
  ]), /overlapping target windows/u);
  const changed = artifact("run-3", "2026-07-17T00:10:00.000Z", "2026-07-17T00:15:00.000Z", "1") as { report: { planBinding: string } };
  changed.report.planBinding = "LEGACY_UNBOUND";
  assert.throws(() => buildKJPaperCohortReport([{ sourcePath: "/a", artifact: changed }]), /artifact hash mismatch/u);
});
