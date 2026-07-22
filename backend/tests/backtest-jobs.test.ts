import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BacktestJobService, FileBacktestResultStore, type BacktestRequestV1, type BacktestRunner } from "../backtest/jobs.js";

const request: BacktestRequestV1 = { schemaVersion: "backtest-request-v1", requestId: "request-1", strategyId: "k-edge", strategyVersion: "1.0.0", datasetId: "btc", datasetVersionHash: "a".repeat(64), feeModel: "fee-v2", latencyMs: 20, initialCash: "1000", maxPosition: "100" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function waitFor(service: BacktestJobService, runId: string, status: "succeeded" | "cancelled"): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (service.get(runId).status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`run ${runId} did not reach ${status}`);
}

test("backtest jobs are idempotent, report progress and persist queryable results", async () => {
  const root = await mkdtemp(join(tmpdir(), "backtests-"));
  const runner: BacktestRunner = { async run(input, context) { context.reportProgress(500); return { schemaVersion: "backtest-result-v1", runId: context.runId, request: input,
    startedAtUtc: "2026-01-01T00:00:00Z", completedAtUtc: "2026-01-01T00:00:01Z", metrics: { netPnl: "1", fees: "0.1", maxDrawdown: "0", fillRate: "1", winRate: "1", brier: "0.1" }, equityCurve: [], events: [] }; } };
  const service = new BacktestJobService(runner, new FileBacktestResultStore(root));
  const namedRequest = { ...request, displayName: "费用感知概率策略 · BTC 验证", description: "用于验证集的纸面回测。" };
  const first = service.start(namedRequest); assert.equal(service.start(namedRequest).runId, first.runId);
  assert.equal(first.displayName, namedRequest.displayName);
  await waitFor(service, first.runId, "succeeded");
  assert.equal(service.get(first.runId).status, "succeeded");
  assert.equal((await service.result(first.runId)).metrics.netPnl, "1");
  await writeFile(join(root, "workbench", "backtest-results", `${first.runId}.json`), "{}\n");
  await assert.rejects(service.result(first.runId), /integrity check failed/u);
});

test("backtest stop aborts the runner and unsafe requests fail before launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "backtests-"));
  const runner: BacktestRunner = { run: (_input, context) => new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) };
  const service = new BacktestJobService(runner, new FileBacktestResultStore(root));
  const job = service.start({ ...request, requestId: "request-2" }); await tick(); service.stop(job.runId); await waitFor(service, job.runId, "cancelled");
  assert.equal(service.get(job.runId).status, "cancelled");
  assert.throws(() => service.start({ ...request, requestId: "../escape" }), /invalid/u);
});
