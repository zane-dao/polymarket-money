import assert from "node:assert/strict";
import test from "node:test";

import type { BacktestResultV1 } from "../backtest/jobs.js";
import { BackendQueryService, QUERY_LIMITS, type HealthInput, type IncidentInput } from "../query/index.js";

const result: BacktestResultV1 = {
  schemaVersion: "backtest-result-v1",
  runId: "run-1",
  request: { schemaVersion: "backtest-request-v1", requestId: "request-1", strategyId: "k-edge", strategyVersion: "1.0.0", datasetId: "btc", datasetVersionHash: "a".repeat(64), feeModel: "fee-v2", latencyMs: 20, initialCash: "1000", maxPosition: "100" },
  startedAtUtc: "2026-01-01T00:00:00Z",
  completedAtUtc: "2026-01-01T00:00:03Z",
  metrics: { netPnl: "1.5", fees: "0.1", maxDrawdown: "0.2", fillRate: "0.5", winRate: "1", brier: "0.1" },
  equityCurve: [
    { timeUtc: "2026-01-01T00:00:00Z", equity: "1000" },
    { timeUtc: "2026-01-01T00:00:03Z", equity: "1001.5" },
  ],
  events: [
    { eventId: "decision-1", eventTimeUtc: "2026-01-01T00:00:01Z", kind: "decision", payload: { action: "BUY", edge: "0.05", databasePath: "/root/private.sqlite", apiKey: "never-expose" } },
    { eventId: "order-1", eventTimeUtc: "2026-01-01T00:00:02Z", kind: "order", payload: { orderId: "paper-1", price: "0.5", quantity: "2", privateKey: "never-expose" } },
    { eventId: "fill-1", eventTimeUtc: "2026-01-01T00:00:03Z", kind: "fill", payload: { orderId: "paper-1", fee: "0.1", quantity: "1" } },
    { eventId: "settlement-1", eventTimeUtc: "2026-01-01T00:00:04Z", kind: "settlement", payload: { outcome: "YES", pnl: "1.5" } },
    { eventId: "incident-raw", eventTimeUtc: "2026-01-01T00:00:05Z", kind: "incident", payload: { stack: "/root/internal.ts:1", message: "raw" } },
  ],
};

const health: HealthInput = { status: "healthy", checkedAtUtc: "2026-01-01T00:00:10Z", database: "healthy", datasets: "healthy", jobs: "healthy", activeJobs: 0, failedJobs: 0 };
const incidents: readonly IncidentInput[] = [{ incidentId: "incident-1", occurredAtUtc: "2026-01-01T00:00:09Z", severity: "warning", component: "dataset", code: "STALE_DATA", message: "Dataset has not refreshed", resolved: false }];

function service(value: BacktestResultV1 = result): BackendQueryService {
  return new BackendQueryService({ async load() { return value; } }, { async health() { return health; }, async incidents() { return incidents; } });
}

test("query service paginates typed backtest records and strips non-public payload fields", async () => {
  const queries = service();
  const decisions = await queries.decisions("run-1", { page: 1, pageSize: 1 });
  assert.equal(decisions.totalItems, 1);
  assert.deepEqual(decisions.items[0]?.data, { action: "BUY", edge: "0.05" });
  assert.equal(JSON.stringify(decisions).includes("/root/"), false);
  assert.equal(JSON.stringify(await queries.orders("run-1", { page: 1, pageSize: 10 })).includes("privateKey"), false);
  assert.equal((await queries.fills("run-1", { page: 1, pageSize: 10 })).items.length, 1);
  assert.equal((await queries.settlements("run-1", { page: 1, pageSize: 10 })).items.length, 1);
  assert.equal((await queries.equityCurve("run-1", { page: 2, pageSize: 1 })).items[0]?.equity, "1001.5");
});

test("market replay is chronological and excludes raw incident payloads", async () => {
  const replay = await service().replay("run-1", { page: 1, pageSize: 10 });
  assert.deepEqual(replay.items.map((event) => event.kind), ["decision", "order", "fill", "settlement"]);
  assert.equal(JSON.stringify(replay).includes("internal.ts"), false);
});

test("run comparison is bounded, unique and contains only public summary fields", async () => {
  const queries = service();
  const comparison = await queries.compare(["run-1"]);
  assert.equal(comparison[0]?.metrics.netPnl, "1.5");
  assert.equal(JSON.stringify(comparison).includes("datasetVersionHash"), false);
  await assert.rejects(() => queries.compare(["run-1", "run-1"]), /unique/u);
  await assert.rejects(() => queries.compare(Array.from({ length: QUERY_LIMITS.maxCompareRuns + 1 }, (_, index) => `run-${index}`)), /1 to 20/u);
});

test("run comparison fails closed when execution assumptions differ", async () => {
  const mismatched: BacktestResultV1 = { ...result, runId: "run-2", request: { ...result.request, requestId: "request-2", datasetVersionHash: "b".repeat(64) } };
  const queries = new BackendQueryService({ async load(runId) { return runId === "run-1" ? result : mismatched; } }, { async health() { return health; }, async incidents() { return incidents; } });
  await assert.rejects(() => queries.compare(["run-1", "run-2"]), /not comparable/u);
});

test("health and incident DTOs are paper-only and reject unsafe detail", async () => {
  const queries = new BackendQueryService({ async load() { return result; } }, { async health() { return { ...health, databasePath: "/root/private.sqlite" } as HealthInput; }, async incidents() { return incidents; } });
  assert.deepEqual(await queries.health(), { schemaVersion: "system-health-v1", ...health, liveTradingEnabled: false, executionMode: "paper-only" });
  assert.equal(JSON.stringify(await queries.health()).includes("databasePath"), false);
  assert.equal((await queries.incidents({ page: 1, pageSize: 10 })).items[0]?.code, "STALE_DATA");
  const unsafe = new BackendQueryService({ async load() { return result; } }, { async health() { return health; }, async incidents() { return [{ ...incidents[0]!, message: "secret=/root/key" }]; } });
  await assert.rejects(() => unsafe.incidents({ page: 1, pageSize: 10 }), /unsafe/u);
});

test("query inputs fail closed before repository access", async () => {
  let loads = 0;
  const queries = new BackendQueryService({ async load() { loads += 1; return result; } }, { async health() { return health; }, async incidents() { return incidents; } });
  await assert.rejects(() => queries.decisions("../escape", { page: 1, pageSize: 10 }), /invalid/u);
  await assert.rejects(() => queries.orders("run-1", { page: 0, pageSize: 10 }), /between/u);
  await assert.rejects(() => queries.replay("run-1", { page: 1, pageSize: QUERY_LIMITS.maxPageSize + 1 }), /between/u);
  assert.equal(loads, 0, "invalid transport inputs must fail before storage access");
});
