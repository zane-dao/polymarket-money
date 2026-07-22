import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkbenchManifestV1, buildWorkbenchViewV1, type WorkbenchArtifactReader } from "../workbench/index.js";

const reader: WorkbenchArtifactReader = {
  listBacktests: () => [],
  listDiagnostics: () => [{
    runId: "verified-run", strategy: "K", brierScore: "0.125", logLoss: "0.4",
    decisionCount: 2, filledCount: 1, noTradeOrUnfilledCount: 1, maxDrawdown: "-2",
    netWithoutBest3Days: "-1", reasonCounts: {},
    dailyPnl: [{ day: "2026-01-01", pnl: "1.25" }, { day: "2026-01-02", pnl: "-0.25" }],
    calibration: [{ from: 0.5, to: 0.6, count: 2, meanProbabilityUp: 0.55, observedUpRate: 0.5 }],
    volatility: { count: 0, p50: null, p95: null, max: null },
    volatilityDrag: { count: 0, p50: null, p95: null, max: null },
    integrity: "COMPLETE_PUBLICATION_VERIFIED",
  }],
};

test("workbench backend converts verified publications without leaking storage paths", () => {
  const view = buildWorkbenchViewV1("/outside-repository", reader);
  assert.equal(view.runs[0]?.pnl, "1");
  assert.deepEqual(view.chartSeries.pnl, [1.25, 1]);
  assert.equal(JSON.stringify(view).includes("outside-repository"), false);
  assert.equal("databasePath" in view, false);
});

test("workbench manifest reports implemented routes ready even when their query result is empty", () => {
  const empty = buildWorkbenchViewV1("/outside-repository", { listDiagnostics: () => [], listBacktests: () => [] });
  const manifest = buildWorkbenchManifestV1("2026-07-21T12:00:00Z", empty);
  assert.equal(manifest.capabilities.length, 9);
  assert.equal(manifest.capabilities.every((item) => item.availability.status === "ready"), true);
});

test("workbench maps verified backtest results into decisions, replay curves and comparisons", () => {
  const view = buildWorkbenchViewV1("/outside-repository", { listDiagnostics: () => [], listBacktests: () => [{
    schemaVersion: "backtest-result-v1", runId: "bt-verified", request: { schemaVersion: "backtest-request-v1", requestId: "request-1", strategyId: "J_FEE_AWARE", strategyVersion: "1.0.0", datasetId: "btc", datasetVersionHash: "a".repeat(64), feeModel: "fee-v2", latencyMs: 1000, initialCash: "100", maxPosition: "10" }, startedAtUtc: "2026-07-21T00:00:00Z", completedAtUtc: "2026-07-21T00:01:00Z", metrics: { netPnl: "2", fees: "1", maxDrawdown: "3", fillRate: "0.5", winRate: "0.6", brier: "0.2" }, equityCurve: [{ timeUtc: "2026-07-21T00:00:00Z", equity: "100" }, { timeUtc: "2026-07-21T00:01:00Z", equity: "102" }], events: [{ eventId: "event-1", eventTimeUtc: "2026-07-21T00:00:30Z", kind: "decision", payload: { market_id: "market-1", side: "UP", probability_up: "0.6", decision_ask: "0.5", edge: "0.1", status: "FILLED", net_pnl: "2" } }],
  }] });
  assert.equal(view.runs[0]?.pnl, "2"); assert.deepEqual(view.chartSeries.pnl, [100, 102]); assert.equal(view.decisions[0]?.direction, "YES"); assert.equal(view.decisions[0]?.eligibility, "ELIGIBLE");
});
