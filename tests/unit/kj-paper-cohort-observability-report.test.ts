import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildKJPaperCohortObservabilityReport,
  kjPaperCohortObservabilityReportHash,
} from "../../execution/src/product/kj-paper-cohort-observability-report.js";
import { kjPaperReportArtifactHash } from "../../execution/src/product/kj-paper-report.js";
import { buildKJPaperCampaign, campaignArtifact } from "../../execution/src/product/kj-paper-campaign.js";
import {
  buildKJPaperCampaignCohortObservabilityReport,
  kjPaperCampaignCohortObservabilityReportHash,
} from "../../execution/src/product/kj-paper-campaign-cohort-observability-report.js";
import type { KJPaperEvent } from "../../execution/src/runtime/kj-paper-engine.js";

const COMMIT = "a".repeat(40);
const JOURNAL_HASH = "b".repeat(64);

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function event(
  eventType: KJPaperEvent["eventType"],
  strategy: "J_FEE_AWARE" | "K_DUAL_VOL" | null,
  details: KJPaperEvent["details"],
): KJPaperEvent {
  return {
    schemaVersion: "kj-paper-engine-v2",
    eventId: `${eventType}-${strategy ?? "none"}-${JSON.stringify(details)}`,
    eventType,
    strategy,
    marketId: "market-1",
    eventTime: "2026-07-17T00:05:30.000Z",
    details,
  };
}

function streams(events: number): Record<string, { events: number; reconnects: number; quarantines: number }> {
  return {
    gamma: { events, reconnects: 1, quarantines: 0 },
    clob: { events: events + 1, reconnects: 2, quarantines: 3 },
    chainlink: { events: 4, reconnects: 0, quarantines: 1 },
    polymarket_binance: { events: 5, reconnects: 0, quarantines: 0 },
    binance_spot: { events: 6, reconnects: 1, quarantines: 0 },
    binance_perpetual: { events: 7, reconnects: 0, quarantines: 0 },
  };
}

function input(
  runId: string,
  start: string,
  end: string,
  streamEvents: number,
  campaign?: { campaignId: string; campaignHash: string; campaignRunIndex: number },
) {
  const journalPath = `/root/polymarket-money-data/${runId}/kj-inputs.ndjson`;
  const settlementTime = new Date(Date.parse(end) + 30_000).toISOString();
  const endedAt = new Date(Date.parse(end) + 60_000).toISOString();
  const events = [
    event("INTENT", "J_FEE_AWARE", { intentId: "j" }),
    event("FILL", "J_FEE_AWARE", { partial: true }),
    event("INTENT", "K_DUAL_VOL", { intentId: "k" }),
    event("NO_FILL", "K_DUAL_VOL", { reason: "SLIPPAGE_LIMIT" }),
    event("SETTLEMENT", "J_FEE_AWARE", { winner: "UP" }),
    event("SETTLEMENT", "K_DUAL_VOL", { winner: "UP" }),
  ] as const;
  const runtimeSummary = {
    type: "runtime_summary",
    runId: `runtime-${runId}`,
    mode: "paper",
    startedAt: start,
    endedAt,
    terminalFailure: null,
    realOrderCount: 0,
    collectorGitCommit: COMMIT,
    kjMarketStartBefore: end,
    kjPaperJournalPath: journalPath,
    kjPaperJournalRecordCount: 10,
    kjPaperJournalLastRecordHash: JOURNAL_HASH,
    kjPaperEventCount: events.length,
    streams: streams(streamEvents),
    safety: {
      liveClientConstructed: false,
      userChannelConnected: false,
      credentialsRead: false,
      ordersSent: 0,
    },
  };
  const report = {
    schemaVersion: "kj-paper-report-v1" as const,
    evidenceStatus: "DESCRIPTIVE_PAPER_ONLY" as const,
    profitabilityClaimEligible: false as const,
    planBinding: "HASH_CHAINED" as const,
    run: {
      runId, collectorGitCommit: COMMIT, targetMarketCount: 1,
      firstFullMarketStart: start, captureEnd: end, journalPath,
      journalRecordCount: "10", journalLastRecordHash: JOURNAL_HASH,
      resultKind: "INITIAL" as const, ...(campaign === undefined ? {} : { campaign }),
    },
    checks: {
      hashChainedRunPlan: true as const, noPendingRisk: true as const,
      officialSettlementPairs: true as const, aggregateWalletPnlIdentity: true as const,
    },
    strategies: {
      J_FEE_AWARE: {
        marketCount: "1", tradedMarketCount: "1", noTradeMarketCount: "0",
        profitableMarketCount: "1", losingMarketCount: "0", flatMarketCount: "0",
        totalTradeCount: "1", totalSpent: "1", totalGrossPnl: "1", totalFees: "0",
        totalNetPnl: "1", pnlReconciliationResidual: "0", averageNetPnlPerMarket: "1", finalCash: "10001",
      },
      K_DUAL_VOL: {
        marketCount: "1", tradedMarketCount: "0", noTradeMarketCount: "1",
        profitableMarketCount: "0", losingMarketCount: "0", flatMarketCount: "1",
        totalTradeCount: "0", totalSpent: "0", totalGrossPnl: "0", totalFees: "0",
        totalNetPnl: "0", pnlReconciliationResidual: "0", averageNetPnlPerMarket: "0", finalCash: "10000",
      },
    },
    markets: [
      {
        marketId: "market-1", slug: "btc-updown-5m-test", intervalStart: start, intervalEnd: end,
        winner: "UP" as const, settlementTime, strategy: "J_FEE_AWARE" as const,
        tradeCount: "1", spent: "1", payout: "2", grossPnl: "1", fees: "0", netPnl: "1",
        cashAfter: "10001", evidenceReference: "gamma:fixture",
      },
      {
        marketId: "market-1", slug: "btc-updown-5m-test", intervalStart: start, intervalEnd: end,
        winner: "UP" as const, settlementTime, strategy: "K_DUAL_VOL" as const,
        tradeCount: "0", spent: "0", payout: "0", grossPnl: "0", fees: "0", netPnl: "0",
        cashAfter: "10000", evidenceReference: "gamma:fixture",
      },
    ],
  };
  const raw = JSON.stringify(runtimeSummary);
  const core = {
    schemaVersion: "kj-paper-report-artifact-v1" as const,
    report,
    sourceFileSha256: {
      runPlan: "c".repeat(64), result: "d".repeat(64), runtimeSummary: sha256(raw),
    },
    resultFileName: "result.json" as const,
    marketsCsvSha256: "f".repeat(64),
  };
  return {
    sourcePath: `/reports/${runId}/summary.json`,
    artifact: { ...core, artifactHash: kjPaperReportArtifactHash(core) },
    runtimeSummary,
    runtimeSummarySha256: sha256(raw),
    journalRecordCount: 10,
    journalLastRecordHash: JOURNAL_HASH,
    events,
  };
}

test("observability cohort aggregates verified runtime, settlement and execution evidence", () => {
  const report = buildKJPaperCohortObservabilityReport([
    input("run-2", "2026-07-17T00:05:00.000Z", "2026-07-17T00:10:00.000Z", 20),
    input("run-1", "2026-07-17T00:00:00.000Z", "2026-07-17T00:05:00.000Z", 10),
  ]);
  assert.equal(report.pnlCohort.runCount, "2");
  assert.equal(report.runs[0]?.runId, "run-1");
  assert.equal(report.aggregate.streams.gamma.eventCount, "30");
  assert.equal(report.aggregate.streams.clob.quarantineCount, "6");
  assert.equal(report.aggregate.execution.J_FEE_AWARE.intentCount, "2");
  assert.equal(report.aggregate.execution.J_FEE_AWARE.partialFillCount, "2");
  assert.equal(report.aggregate.execution.K_DUAL_VOL.noFillReasons.SLIPPAGE_LIMIT, "2");
  assert.equal(report.aggregate.settlementDelay.p50Milliseconds, "30000");
  assert.equal(report.profitabilityClaimEligible, false);
  assert.match(kjPaperCohortObservabilityReportHash(report), /^[0-9a-f]{64}$/u);
});

test("observability cohort rejects runtime hash and journal-tail conflicts", () => {
  const one = input("run-1", "2026-07-17T00:00:00.000Z", "2026-07-17T00:05:00.000Z", 10);
  assert.throws(() => buildKJPaperCohortObservabilityReport([
    { ...one, runtimeSummarySha256: "0".repeat(64) },
  ]), /runtime summary hash conflicts/u);
  assert.throws(() => buildKJPaperCohortObservabilityReport([
    { ...one, journalRecordCount: 9 },
  ]), /runtime summary does not match/u);
});

test("campaign observability requires the same complete immutable campaign as PnL", () => {
  const campaign = campaignArtifact(buildKJPaperCampaign({
    campaignId: "campaign-observe", plannedAt: "2026-07-16T23:00:00.000Z", collectorGitCommit: COMMIT,
    firstFullMarketStart: "2026-07-17T00:00:00.000Z", runCount: 2, targetMarketCount: 1,
    settlementGraceSeconds: 60, gapMarketCount: 0,
  }));
  const binding = (campaignRunIndex: number) => ({
    campaignId: campaign.campaign.campaignId, campaignHash: campaign.campaignHash, campaignRunIndex,
  });
  const report = buildKJPaperCampaignCohortObservabilityReport({
    campaignArtifact: campaign,
    reports: [
      input("campaign-observe-r001", "2026-07-17T00:00:00.000Z", "2026-07-17T00:05:00.000Z", 10, binding(1)),
      input("campaign-observe-r002", "2026-07-17T00:05:00.000Z", "2026-07-17T00:10:00.000Z", 20, binding(2)),
    ],
  });
  assert.equal(report.campaignCohort.cohort.runCount, "2");
  assert.equal(report.observability.aggregate.streams.gamma.eventCount, "30");
  assert.match(kjPaperCampaignCohortObservabilityReportHash(report), /^[0-9a-f]{64}$/u);
  assert.throws(() => buildKJPaperCampaignCohortObservabilityReport({
    campaignArtifact: campaign,
    reports: [input("campaign-observe-r001", "2026-07-17T00:00:00.000Z", "2026-07-17T00:05:00.000Z", 10, binding(1))],
  }), /every pre-registered/u);
});
