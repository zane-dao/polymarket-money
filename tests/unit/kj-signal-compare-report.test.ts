import assert from "node:assert/strict";
import test from "node:test";

import { buildKJSignalComparePlan, signalCompareArtifact } from "../../execution/src/product/kj-signal-compare.js";
import { buildKJSignalCompareReport, kjSignalCompareReportHash } from "../../execution/src/product/kj-signal-compare-report.js";
import { kjPaperReportArtifactHash } from "../../execution/src/product/kj-paper-report.js";

const COMMIT = "a".repeat(40);
const START = "2026-07-18T05:00:00.000Z";
const END = "2026-07-18T05:05:00.000Z";

function sourceArtifact(runId: string, net: string) {
  const report = {
    schemaVersion: "kj-paper-report-v1" as const, evidenceStatus: "DESCRIPTIVE_PAPER_ONLY" as const,
    profitabilityClaimEligible: false as const, planBinding: "HASH_CHAINED" as const,
    run: { runId, collectorGitCommit: COMMIT, targetMarketCount: 1, firstFullMarketStart: START, captureEnd: END,
      journalPath: `/tmp/${runId}/kj-inputs.ndjson`, journalRecordCount: "10", journalLastRecordHash: "b".repeat(64), resultKind: "INITIAL" as const },
    checks: { hashChainedRunPlan: true as const, noPendingRisk: true as const, officialSettlementPairs: true as const, aggregateWalletPnlIdentity: true as const },
    strategies: {
      J_FEE_AWARE: { marketCount: "1", tradedMarketCount: "1", noTradeMarketCount: "0", profitableMarketCount: "1", losingMarketCount: "0", flatMarketCount: "0", totalTradeCount: "1", totalSpent: "1", totalGrossPnl: net, totalFees: "0", totalNetPnl: net, pnlReconciliationResidual: "0", averageNetPnlPerMarket: net, finalCash: `1000${net}` },
      K_DUAL_VOL: { marketCount: "1", tradedMarketCount: "0", noTradeMarketCount: "1", profitableMarketCount: "0", losingMarketCount: "0", flatMarketCount: "1", totalTradeCount: "0", totalSpent: "0", totalGrossPnl: "0", totalFees: "0", totalNetPnl: "0", pnlReconciliationResidual: "0", averageNetPnlPerMarket: "0", finalCash: "10000" },
    }, markets: [],
  };
  const core = { schemaVersion: "kj-paper-report-artifact-v1" as const, report, sourceFileSha256: { runPlan: "c".repeat(64), result: "d".repeat(64), runtimeSummary: "e".repeat(64) }, resultFileName: "result.json" as const, marketsCsvSha256: "f".repeat(64) };
  return { ...core, artifactHash: kjPaperReportArtifactHash(core) };
}

test("paired signal report requires matched source runs and calculates source PnL deltas", () => {
  const plan = signalCompareArtifact(buildKJSignalComparePlan({
    compareRunId: "kj-compare-20260718-0500", plannedAt: "2026-07-18T04:54:00.000Z", collectorGitCommit: COMMIT,
    firstFullMarketStart: START, targetMarketCount: 1, settlementGraceSeconds: 600,
  }));
  const report = buildKJSignalCompareReport({
    compareArtifact: plan,
    binanceArtifact: sourceArtifact("kj-compare-20260718-0500-binance-r001", "1"), binanceRuntimeSummary: { kjSignalSource: "BINANCE_SPOT" },
    chainlinkArtifact: sourceArtifact("kj-compare-20260718-0500-chainlink-r001", "3"), chainlinkRuntimeSummary: { kjSignalSource: "CHAINLINK" },
  });
  assert.equal(report.strategies.J_FEE_AWARE.chainlinkMinusBinanceNetPnl, "2");
  assert.match(kjSignalCompareReportHash(report), /^[0-9a-f]{64}$/u);
  assert.throws(() => buildKJSignalCompareReport({
    compareArtifact: plan,
    binanceArtifact: sourceArtifact("wrong", "1"), binanceRuntimeSummary: { kjSignalSource: "BINANCE_SPOT" },
    chainlinkArtifact: sourceArtifact("kj-compare-20260718-0500-chainlink-r001", "3"), chainlinkRuntimeSummary: { kjSignalSource: "CHAINLINK" },
  }), /does not match/u);
});
