import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchCommands, parseBacktestJobV1, parseBacktestResultV1, parseDatasetDetailV1, parseDatasetScanV1, parsePaperMarketRuntimeV1, parseRunComparisonsV1, parseStrategyDefinitionV1, parseStrategyValidationV1, parseStrategyVersionV1 } from "../src/workbench/services/workbench-commands.js";
import type { WorkbenchCommandTransport } from "../src/workbench/services/tauri-workbench-data-source.js";

test("strategy and backtest DTO parsers reject extra renderer-facing fields", () => {
  assert.throws(() => parseStrategyDefinitionV1({ strategyId: "k", displayName: "K", runtime: "python", allowedModes: ["backtest", "paper"], parameters: {}, databasePath: "/secret/db" }), /unexpected or missing fields/);
  assert.throws(() => parseStrategyVersionV1({ schemaVersion: "strategy-version-v1", strategyId: "k", version: "1.0.0", description: "test", parameters: {}, createdAtUtc: "2026-07-21T00:00:00Z", sourcePath: "/secret" }), /unexpected or missing fields/);
  assert.throws(() => parseBacktestJobV1({ schemaVersion: "backtest-job-v1", runId: "bt-1", requestId: "r-1", status: "live", progressPermille: 0, error: null }), /invalid/);
});

test("backtest jobs preserve their actual strategy identity independently from a stale display name", () => {
  const parsed = parseBacktestJobV1({ schemaVersion: "backtest-job-v1", runId: "bt-k", requestId: "r-k", displayName: "旧的 J 名称", strategyId: "K_DUAL_VOL", strategyVersion: "2.0.0", status: "succeeded", progressPermille: 1000, error: null });
  assert.equal(parsed.displayName, "旧的 J 名称");
  assert.equal(parsed.strategyId, "K_DUAL_VOL");
  assert.equal(parsed.strategyVersion, "2.0.0");
});

test("strategy validation accepts backend-owned research warnings without treating them as errors", () => {
  const parsed = parseStrategyValidationV1({ schemaVersion: "strategy-validation-v1", valid: true, errors: [], warnings: [{ code: "NARROW_EDGE_WINDOW", severity: "warning", message: "可交易优势区间很窄" }] });
  assert.equal(parsed.valid, true);
  assert.equal(parsed.warnings[0]?.severity, "warning");
  assert.throws(() => parseStrategyValidationV1({ schemaVersion: "strategy-validation-v1", valid: true, errors: [], warnings: [{ code: "invented", severity: "warning", message: "x" }] }), /invalid/);
});

test("strategy definitions preserve backend-owned labels, defaults and research status", () => {
  const parsed = parseStrategyDefinitionV1({ strategyId: "L_ADAPTIVE_EXECUTION_V2", displayName: "L Adaptive Execution V2", summary: "只用于研究", researchStatus: "RESEARCH_ONLY", runtime: "python", allowedModes: ["backtest"], parameters: { maxStakeUsdc: { type: "number", required: true, defaultValue: 400, minimum: 1, maximum: 100000, displayName: "单次最大投入", description: "模拟名义金额上限", unit: "USDC" } } });
  assert.equal(parsed.researchStatus, "RESEARCH_ONLY");
  assert.equal(parsed.parameters.maxStakeUsdc?.displayName, "单次最大投入");
  assert.equal(parsed.parameters.maxStakeUsdc?.unit, "USDC");
  assert.equal(parsed.parameters.maxStakeUsdc?.defaultValue, 400);
  const historical = parseStrategyDefinitionV1({ strategyId: "L_ADAPTIVE_EXECUTION_V1", displayName: "自适应执行（L V1 · 历史门失败）", family: "自适应执行", researchStatus: "RESEARCH_GATE_FAILED", riskLevel: "HIGH", runtime: "python", allowedModes: [], parameters: {} });
  assert.equal(historical.researchStatus, "RESEARCH_GATE_FAILED");
  assert.equal(historical.allowedModes.length, 0);
});

test("backtest and comparison DTOs preserve an unavailable win rate when there are no fills", () => {
  const metrics = { netPnl: "0", fees: "0", maxDrawdown: "0", fillRate: "0", winRate: null, brier: "0.25" };
  const request = { schemaVersion: "backtest-request-v1" as const, requestId: "request-1", displayName: "费用感知概率策略 · BTC 验证", description: "用于验证集的纸面回测。", strategyId: "J_FEE_AWARE", strategyVersion: "1.0.0", datasetId: "btc", datasetVersionHash: "a".repeat(64), feeModel: "fee-v2", latencyMs: 1000, initialCash: "100", maxPosition: "10" };
  const result = parseBacktestResultV1({ schemaVersion: "backtest-result-v1", runId: "run-1", request, startedAtUtc: "2026-07-21T00:00:00Z", completedAtUtc: "2026-07-21T00:01:00Z", metrics, equityCurve: [], events: [] });
  const evaluationScope = { schemaVersion: "backtest-evaluation-scope-v1", split: "FINAL_TEST", horizonSeconds: 30, scenario: "BASE_1S", cohortHash: "c".repeat(64), cohortSize: 10 };
  const comparisons = parseRunComparisonsV1([{ schemaVersion: "run-comparison-v1", runId: "run-1", displayName: request.displayName, description: request.description, strategyId: "J_FEE_AWARE", strategyVersion: "1.0.0", datasetId: "btc", completedAtUtc: "2026-07-21T00:01:00Z", evaluationScope, metrics }]);
  assert.equal(result.metrics.winRate, null);
  assert.equal(comparisons[0]?.metrics.winRate, null);
  assert.equal(comparisons[0]?.evaluationScope.cohortSize, 10);
  assert.equal(comparisons[0]?.displayName, request.displayName);
});

test("dataset DTO parsers enforce path-free detail and internally consistent scans", () => {
  const item = { schemaVersion: "dataset-list-item-v1", datasetId: "btc", versionHash: "a".repeat(64), format: "external-historical-v1", continuity: "UNVERIFIED", startTimeUtc: null, endTimeUtc: null, rowCount: 1, quarantineCount: 0, status: "available" };
  assert.equal(parseDatasetScanV1({ schemaVersion: "dataset-scan-v1", scannedAtUtc: "2026-07-21T00:00:00Z", datasetCount: 1, datasets: [item] }).datasetCount, 1);
  assert.throws(() => parseDatasetScanV1({ schemaVersion: "dataset-scan-v1", scannedAtUtc: "2026-07-21T00:00:00Z", datasetCount: 2, datasets: [item] }), /inconsistent/);
  assert.throws(() => parseDatasetDetailV1({ ...item, schemaVersion: "dataset-detail-v1", selectionReady: true, rawDataPolicy: "read-only-not-copied", sourcePath: "/secret/raw.jsonl" }), /unexpected or missing fields/);
});

test("paper market runtime accepts only a path-free public book and signal", async () => {
  const runtime={schemaVersion:"paper-market-runtime-v1",status:"READY",checkedAtUtc:"2026-07-21T00:00:01.000Z",market:{marketId:"market-1",conditionId:"condition-1",slug:"btc-updown-5m-1775181000",intervalStart:"2026-07-21T00:00:00.000Z",intervalEnd:"2026-07-21T00:05:00.000Z",decisionTime:"2026-07-21T00:00:00.900Z",continuity:"UNVERIFIED",bookAgeMs:8,signalAgeMs:5,up:{tokenId:"1",bid:"0.49",ask:"0.5",bidSize:"10",askSize:"11"},down:{tokenId:"2",bid:"0.5",ask:"0.51",bidSize:"12",askSize:"13"},signal:{provider:"BINANCE_SPOT",price:"67842.31",sourceTime:"2026-07-21T00:00:00.800Z",serverTime:"2026-07-21T00:00:00.850Z",receiveTime:"2026-07-21T00:00:00.895Z"},feeEvidence:{schemaVersion:"paper-fee-evidence-v1",model:"POLYMARKET_TAKER_CURVE_V1",conditionId:"condition-1",rate:"0.01",effectiveFromUtc:"2026-07-21T00:00:00.000Z",effectiveToUtc:"2026-07-21T00:05:00.000Z",evidenceStatus:"UNVERIFIED",evidenceReference:"test-fixture"}}};
  assert.equal(parsePaperMarketRuntimeV1(runtime).market?.signal.price,"67842.31");
  assert.throws(()=>parsePaperMarketRuntimeV1({...runtime,path:"/secret"}),/unexpected or missing fields/);
  const calls:string[]=[];const client=createWorkbenchCommands({async invoke(command){calls.push(command);return runtime;}});await client.getPaperMarketRuntime();assert.deepEqual(calls,["get_paper_market_runtime_v1"]);
});

test("dataset management uses only fixed path-free backend commands", async () => {
  const calls: Array<readonly [string, Readonly<Record<string, unknown>> | undefined]> = [];
  const item = { schemaVersion: "dataset-list-item-v1", datasetId: "btc", versionHash: "a".repeat(64), format: "external-historical-v1", continuity: "UNVERIFIED", startTimeUtc: null, endTimeUtc: null, rowCount: 1, quarantineCount: 0, status: "available" };
  const transport: WorkbenchCommandTransport = { async invoke(command, args) { calls.push([command, args]); if (command === "register_dataset_source_v1") return { schemaVersion: "registered-dataset-source-v1", sourceId: "b".repeat(64), registeredAtUtc: "2026-07-21T00:00:00Z", datasetCount: 1, rawDataPolicy: "read-only-not-copied" }; if (command === "scan_datasets_v1") return { schemaVersion: "dataset-scan-v1", scannedAtUtc: "2026-07-21T00:00:00Z", datasetCount: 1, datasets: [item] }; if (command === "get_dataset_v1") return { ...item, schemaVersion: "dataset-detail-v1", selectionReady: true, rawDataPolicy: "read-only-not-copied" }; if (command === "validate_dataset_selection_v1") return { schemaVersion: "validated-dataset-selection-v1", datasetId: "btc", versionHash: "a".repeat(64), validatedAtUtc: "2026-07-21T00:00:01Z" }; throw new Error("unexpected command"); } };
  const client = createWorkbenchCommands(transport); const selection = { schemaVersion: "dataset-selection-request-v1" as const, datasetId: "btc", versionHash: "a".repeat(64) };
  await client.registerDatasetSource({ schemaVersion: "dataset-source-registration-request-v1", sourceDirectory: "/mnt/history/normalized" }); await client.scanDatasets(); await client.getDataset(selection.datasetId, selection.versionHash); await client.validateDatasetSelection(selection);
  assert.deepEqual(calls.map(([command]) => command), ["register_dataset_source_v1", "scan_datasets_v1", "get_dataset_v1", "validate_dataset_selection_v1"]);
  assert.equal(calls.some(([, args]) => Object.hasOwn(args ?? {}, "path")), false);
});

test("command client sends mutations only through fixed commands and typed arguments", async () => {
  const calls: Array<readonly [string, Readonly<Record<string, unknown>> | undefined]> = [];
  const transport: WorkbenchCommandTransport = { async invoke(command, args) { calls.push([command, args]); if (command === "validate_strategy_parameters_v1") return { schemaVersion: "strategy-validation-v1", valid: true, errors: [] }; if (command === "start_backtest_v1") return { schemaVersion: "backtest-job-v1", runId: "bt-1", requestId: "r-1", status: "queued", progressPermille: 0, error: null }; throw new Error("unexpected command"); } };
  const client = createWorkbenchCommands(transport);
  await client.validateStrategyParameters("k-edge", { threshold: 0.2 });
  await client.startBacktest({ schemaVersion: "backtest-request-v1", requestId: "r-1", strategyId: "k-edge", strategyVersion: "1.0.0", datasetId: "btc", datasetVersionHash: "a".repeat(64), feeModel: "fee-v2", latencyMs: 20, initialCash: "1000", maxPosition: "100" });
  assert.deepEqual(calls.map(([command]) => command), ["validate_strategy_parameters_v1", "start_backtest_v1"]);
  assert.deepEqual(calls[0]?.[1], { strategyId: "k-edge", parameters: { threshold: 0.2 } });
  assert.equal(Object.hasOwn(calls[1]?.[1] ?? {}, "path"), false);
});

test("paper session lifecycle uses fixed commands and preserves fail-closed backend errors", async () => {
  const calls: Array<readonly [string, Readonly<Record<string, unknown>> | undefined]> = [];
  const view = { schemaVersion: "paper-session-view-v1", sessionId: "paper-1", status: "STOPPED", adapterId: "desktop-public-market-adapter", startedAtUtc: "2026-07-21T00:00:00.000Z", updatedAtUtc: "2026-07-21T00:01:00.000Z", cash: "100", openOrderCount: 0, fillCount: 0, systemKillSwitchEnabled: false };
  const transport: WorkbenchCommandTransport = { async invoke(command, args) {
    calls.push([command, args]);
    if (command === "start_paper_session_v1" || command === "resume_paper_session_v1") throw new Error("public market adapter is not ready; the session service does not start collection");
    if (command === "get_paper_session_status_v1" || command === "stop_paper_session_v1") return view;
    throw new Error("unexpected command");
  } };
  const client = createWorkbenchCommands(transport);
  const request = { schemaVersion: "paper-session-start-v1" as const, sessionId: "paper-1", initialCash: "100", startedAtUtc: "2026-07-21T00:00:00.000Z", risk: { schemaVersion: "paper-risk-config-v1" as const, maximumQuoteAgeMs: 1_000, minimumNetEdge: "0.01", maximumOrderNotional: "10", maximumMarketExposure: "50", maximumTotalExposure: "100" } };
  await assert.rejects(client.startPaperSession(request), /does not start collection/);
  assert.equal((await client.getPaperSessionStatus("paper-1")).status, "STOPPED");
  assert.equal((await client.stopPaperSession("paper-1")).status, "STOPPED");
  await assert.rejects(client.resumePaperSession("paper-1"), /does not start collection/);
  assert.deepEqual(calls.map(([command]) => command), ["start_paper_session_v1", "get_paper_session_status_v1", "stop_paper_session_v1", "resume_paper_session_v1"]);
  assert.deepEqual(calls[0]?.[1], { request });
  assert.deepEqual(calls[1]?.[1], { sessionId: "paper-1" });
});
