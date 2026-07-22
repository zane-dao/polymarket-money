import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FileBacktestResultStore, type BacktestResultV1 } from "../backtest/jobs.js";

const command = fileURLToPath(new URL("../../scripts/workbench-command.js", import.meta.url));

async function invoke(root: string, mode: string, payload: unknown = {}): Promise<unknown> {
  const result = await new Promise<{ stdout: string; stderr: string }>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [command, mode], { env: { PATH: process.env.PATH ?? "", POLYMARKET_DATA_ROOT: root }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; if (stdout.length > 2 * 1024 * 1024) child.kill(); });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; if (stderr.length > 16_384) child.kill(); });
    child.on("error", rejectRun);
    child.on("close", (code) => code === 0 ? resolveRun({ stdout, stderr }) : rejectRun(new Error(stderr || `command exited ${String(code)}`)));
    child.stdin.end(JSON.stringify(payload));
  });
  return JSON.parse(result.stdout) as unknown;
}

test("fixed desktop backend command provides a path-free strategy round trip", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-command-"));
  const definitions = await invoke(root, "list-strategy-definitions") as Array<{ strategyId: string }>;
  assert.deepEqual(definitions.map((item) => item.strategyId), ["J_FEE_AWARE", "K_DUAL_VOL", "L_ADAPTIVE_EXECUTION_V2"]);
  const value = { schemaVersion: "strategy-version-v1", strategyId: "K_DUAL_VOL", version: "1.0.0", description: "frozen desktop version",
    parameters: { edgeThreshold: 0.05, maxEdge: 0.25, maxStakeUsdc: 400, bookParticipation: 0.5 }, createdAtUtc: "2026-07-21T12:00:00Z" };
  assert.deepEqual(await invoke(root, "save-strategy-version", { value }), value);
  assert.deepEqual(await invoke(root, "list-strategy-versions", { strategyId: "K_DUAL_VOL" }), ["1.0.0"]);
  assert.deepEqual(await invoke(root, "get-strategy-version", { strategyId: "K_DUAL_VOL", version: "1.0.0" }), value);
  assert.equal(JSON.stringify(await invoke(root, "view")).includes(root), false);
});

test("fixed desktop backend command rejects unknown commands and path traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-command-"));
  await assert.rejects(invoke(root, "get-strategy-version", { strategyId: "../escape", version: "1.0.0" }));
  await assert.rejects(invoke(root, "shell", { command: "whoami" }));
});

test("fixed desktop backend exposes integrity-checked backtest queries and honest system status", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-command-"));
  const result: BacktestResultV1 = {
    schemaVersion: "backtest-result-v1", runId: "run-query-1",
    request: { schemaVersion: "backtest-request-v1", requestId: "request-query-1", strategyId: "K_DUAL_VOL", strategyVersion: "1.0.0", datasetId: "btc", datasetVersionHash: "a".repeat(64), feeModel: "fee-v2", latencyMs: 1000, initialCash: "1000", maxPosition: "100" },
    startedAtUtc: "2026-07-21T12:00:00Z", completedAtUtc: "2026-07-21T12:05:00Z",
    metrics: { netPnl: "1", fees: "0.1", maxDrawdown: "0.2", fillRate: "0.5", winRate: "1", brier: "0.1" },
    equityCurve: [{ timeUtc: "2026-07-21T12:05:00Z", equity: "1001" }],
    events: [
      { eventId: "decision-1", eventTimeUtc: "2026-07-21T12:01:00Z", kind: "decision", payload: { action: "BUY", edge: "0.1", secret: "hidden" } },
      { eventId: "order-1", eventTimeUtc: "2026-07-21T12:02:00Z", kind: "order", payload: { orderId: "order-1", price: "0.5" } },
      { eventId: "fill-1", eventTimeUtc: "2026-07-21T12:03:00Z", kind: "fill", payload: { fillId: "fill-1", quantity: "2" } },
      { eventId: "settlement-1", eventTimeUtc: "2026-07-21T12:04:00Z", kind: "settlement", payload: { settlementId: "settlement-1", pnl: "1" } },
    ],
  };
  await new FileBacktestResultStore(root).save(result);
  const page = { page: { page: 1, pageSize: 10 }, runId: result.runId };
  assert.equal((await invoke(root, "get-backtest-decisions", page) as { totalItems: number }).totalItems, 1);
  assert.equal((await invoke(root, "get-backtest-orders", page) as { totalItems: number }).totalItems, 1);
  assert.equal((await invoke(root, "get-backtest-fills", page) as { totalItems: number }).totalItems, 1);
  assert.equal((await invoke(root, "get-backtest-settlements", page) as { totalItems: number }).totalItems, 1);
  assert.equal((await invoke(root, "get-backtest-equity", page) as { totalItems: number }).totalItems, 1);
  assert.equal((await invoke(root, "get-backtest-replay", page) as { totalItems: number }).totalItems, 4);
  assert.equal((await invoke(root, "compare-backtests", { runIds: [result.runId] }) as unknown[]).length, 1);
  const health = await invoke(root, "get-system-health") as { database: string; executionMode: string };
  assert.equal(health.database, "unavailable");
  assert.equal(health.executionMode, "paper-only");
  assert.deepEqual((await invoke(root, "list-system-incidents", { page: { page: 1, pageSize: 10 } }) as { items: unknown[] }).items, []);
  assert.equal(JSON.stringify(await invoke(root, "get-backtest-decisions", page)).includes("secret"), false);
});
