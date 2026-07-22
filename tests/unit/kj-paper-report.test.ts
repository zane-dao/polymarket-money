import assert from "node:assert/strict";
import test from "node:test";

import {
  buildKJPaperReport,
  kjPaperReportArtifactHash,
  kjPaperReportCsv,
  kjPaperReportHash,
  type BuildKJPaperReportInput,
} from "../../backend/core/src/product/kj-paper-report.js";
import type {
  KJPaperEngineSnapshot,
  KJPaperEvent,
} from "../../backend/core/src/runtime/kj-paper-engine.js";

const START = "2026-07-17T00:00:00.000Z";
const END = "2026-07-17T00:05:00.000Z";
const COMMIT = "a".repeat(40);
const HASH = "b".repeat(64);
const JOURNAL = "/root/polymarket-money-data/test/kj-inputs.ndjson";

const snapshot: KJPaperEngineSnapshot = {
  schemaVersion: "kj-paper-engine-snapshot-v1",
  engineVersion: "kj-paper-engine-v2",
  wallets: {
    J_FEE_AWARE: { cash: "10000.5", available: "10000.5", reserved: "0", positions: {} },
    K_DUAL_VOL: { cash: "10000", available: "10000", reserved: "0", positions: {} },
  },
  markets: [{
    marketId: "market-1",
    conditionId: `0x${"1".repeat(64)}`,
    slug: "btc-updown-5m-1784246400",
    intervalStart: START,
    intervalEnd: END,
    upTokenId: "111",
    downTokenId: "222",
    anchorPrice: "100",
    state: "DONE",
    ledgers: {
      J_FEE_AWARE: { spent: "0.4", fees: "0.1", tradeCount: "1" },
      K_DUAL_VOL: { spent: "0", fees: "0", tradeCount: "0" },
    },
  }],
  pendingIntents: [],
  eventCount: "2",
};

function settlement(strategy: "J_FEE_AWARE" | "K_DUAL_VOL"): KJPaperEvent {
  const j = strategy === "J_FEE_AWARE";
  return {
    schemaVersion: "kj-paper-engine-v2",
    eventId: j ? "c".repeat(64) : "d".repeat(64),
    eventType: "SETTLEMENT",
    strategy,
    marketId: "market-1",
    eventTime: "2026-07-17T00:05:30.000Z",
    details: {
      settlementId: "e".repeat(64),
      winner: "UP",
      payout: j ? "1" : "0",
      grossPnl: j ? "0.6" : "0",
      fees: j ? "0.1" : "0",
      netPnl: j ? "0.5" : "0",
      cashAfter: j ? "10000.5" : "10000",
      evidenceReference: "gamma-market-by-slug:btc-updown-5m-1784246400:sha256:abc",
    },
  };
}

function evidence(): BuildKJPaperReportInput {
  const plan = {
    schemaVersion: "kj-paper-mvp-v1",
    runId: "kj-paper-20260717000000-12345678",
    targetMarketCount: 1,
    firstFullMarketStart: START,
    captureEnd: END,
    journalPath: JOURNAL,
    collectorGitCommit: COMMIT,
  };
  return {
    plan,
    result: {
      schemaVersion: "kj-paper-mvp-v1",
      accepted: true,
      checks: { accepted: true },
      runId: plan.runId,
      collectorGitCommit: COMMIT,
      targetMarketCount: 1,
      observedTargetMarketCount: 1,
      completedMarketCount: 1,
      journalRecordCount: 10,
      journalLastRecordHash: HASH,
      strategies: {
        J_FEE_AWARE: { finalCash: "10000.5", netPnl: "0.5" },
        K_DUAL_VOL: { finalCash: "10000", netPnl: "0" },
      },
      engineState: snapshot,
    },
    runtimeSummary: {
      terminalFailure: null,
      realOrderCount: 0,
      collectorGitCommit: COMMIT,
      kjMarketStartBefore: END,
      safety: {
        liveClientConstructed: false,
        userChannelConnected: false,
        credentialsRead: false,
        ordersSent: 0,
      },
    },
    journalPath: JOURNAL,
    journalRecordCount: 10,
    journalLastRecordHash: HASH,
    journalRunPlan: {
      schemaVersion: "kj-paper-run-plan-v1",
      runId: plan.runId,
      targetMarketCount: 1,
      firstFullMarketStart: START,
      captureEnd: END,
      collectorGitCommit: COMMIT,
    },
    unsettledMarketIds: [],
    snapshot,
    events: [settlement("J_FEE_AWARE"), settlement("K_DUAL_VOL")],
    warmupEvidence: { signalCount: 0, sourceFamily: null, firstReceiveTime: null, lastReceiveTime: null },
  };
}

test("paper report verifies target settlements and exact wallet PnL identities", () => {
  const report = buildKJPaperReport(evidence());
  assert.equal(report.planBinding, "HASH_CHAINED");
  assert.equal(report.profitabilityClaimEligible, false);
  assert.equal(report.strategies.J_FEE_AWARE.totalNetPnl, "0.5");
  assert.equal(report.strategies.J_FEE_AWARE.totalTradeCount, "1");
  assert.equal(report.strategies.K_DUAL_VOL.noTradeMarketCount, "1");
  assert.match(kjPaperReportHash(report), /^[0-9a-f]{64}$/u);
  const csv = kjPaperReportCsv(report);
  assert.equal(csv.trimEnd().split("\n").length, 3);
  assert.match(kjPaperReportArtifactHash({
    schemaVersion: "kj-paper-report-artifact-v1",
    report,
    sourceFileSha256: { runPlan: HASH, result: HASH, runtimeSummary: HASH },
    resultFileName: "result.json",
    marketsCsvSha256: HASH,
  }), /^[0-9a-f]{64}$/u);
});

test("paper report exposes and verifies a campaign-bound v2 run plan", () => {
  const input = evidence();
  const campaign = { campaignId: "campaign-test", campaignHash: "c".repeat(64), campaignRunIndex: 1 };
  const plan = { ...(input.plan as object), campaign };
  const report = buildKJPaperReport({
    ...input,
    plan,
    journalRunPlan: { ...(input.journalRunPlan as object), schemaVersion: "kj-paper-run-plan-v2", ...campaign },
  });
  assert.deepEqual(report.run.campaign, campaign);
});

test("paper report requires and discloses a configured pre-market warmup", () => {
  const input = evidence();
  const plan = { ...(input.plan as object), warmupSeconds: 180 };
  const runtimeSummary = { ...(input.runtimeSummary as object), kjSignalSource: "BINANCE_SPOT" };
  const report = buildKJPaperReport({
    ...input,
    plan,
    runtimeSummary,
    journalRunPlan: { ...(input.journalRunPlan as object), schemaVersion: "kj-paper-run-plan-v3", warmupSeconds: 180 },
    warmupEvidence: {
      signalCount: 37,
      sourceFamily: "BINANCE",
      firstReceiveTime: "2026-07-16T23:56:00.000Z",
      lastReceiveTime: "2026-07-16T23:59:59.000Z",
    },
  });
  assert.deepEqual(report.run.warmup, {
    requiredSeconds: 180, signalCount: "37", observedSeconds: "239", sourceFamily: "BINANCE",
  });
  assert.throws(() => buildKJPaperReport({
    ...input,
    plan,
    runtimeSummary,
    warmupEvidence: { signalCount: 1, sourceFamily: "BINANCE", firstReceiveTime: START, lastReceiveTime: START },
  }), /lacks durable signal evidence/u);
});

test("paper report discloses legacy plans and rejects plan or accounting tampering", () => {
  const legacy = evidence();
  const legacyReport = buildKJPaperReport({ ...legacy, journalRunPlan: null });
  assert.equal(legacyReport.planBinding, "LEGACY_UNBOUND");
  assert.equal(legacyReport.evidenceStatus, "DESCRIPTIVE_PAPER_ONLY_LEGACY_UNBOUND_PLAN");

  const changedPlan = evidence();
  assert.throws(() => buildKJPaperReport({
    ...changedPlan,
    journalRunPlan: { ...(changedPlan.journalRunPlan as object), targetMarketCount: 2 },
  }), /hash-chained run plan conflicts/u);

  const changedPnl = evidence();
  const badEvent = {
    ...changedPnl.events[0]!,
    details: { ...changedPnl.events[0]!.details, netPnl: "0.4" },
  };
  assert.throws(() => buildKJPaperReport({
    ...changedPnl,
    events: [badEvent, changedPnl.events[1]!],
  }), /gross PnL - fees does not equal net PnL/u);
});
