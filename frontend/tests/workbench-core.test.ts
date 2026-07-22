import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIAL_WORKBENCH_STATE,
  reduceWorkbenchState,
} from "../src/workbench/domain/workbench.js";
import {
  parseWorkbenchManifestV1,
  WorkbenchManifestError,
} from "../src/workbench/services/workbench-manifest.js";
import { parseWorkbenchViewV1 } from "../src/workbench/services/tauri-workbench-data-source.js";

const capabilities = [
  ["overview", "总览", "O"],
  ["live", "实时驾驶舱", "L"],
  ["decisions", "决策记录", "D"],
  ["strategy", "策略工作室", "S"],
  ["datasets", "数据集管理", "T"],
  ["backtest", "回测实验室", "B"],
  ["replay", "市场回放", "R"],
  ["compare", "策略竞技场", "A"],
  ["health", "系统健康", "H"],
].map(([routeId, label, shortLabel]) => ({
  routeId,
  label,
  shortLabel,
  availability: { status: "unavailable", reason: "只读数据源尚未接入" },
}));

test("workbench manifest requires all routes and rejects unknown fields", () => {
  const source = {
    schemaVersion: "workbench-manifest-v1",
    generatedAtUtc: "2026-07-21T10:00:00Z",
    capabilities,
  };
  assert.equal(parseWorkbenchManifestV1(source).capabilities.length, 9);
  assert.throws(
    () => parseWorkbenchManifestV1({ ...source, capabilities: capabilities.slice(1) }),
    WorkbenchManifestError,
  );
  assert.throws(
    () => parseWorkbenchManifestV1({ ...source, sourcePath: "/secret" }),
    WorkbenchManifestError,
  );
});

test("workbench reducer keeps navigation, selection and replay independent", () => {
  const navigated = reduceWorkbenchState(INITIAL_WORKBENCH_STATE, {
    type: "navigate",
    routeId: "replay",
  });
  const selected = reduceWorkbenchState(navigated, {
    type: "select-decision",
    decisionId: "decision-42",
  });
  const playing = reduceWorkbenchState(selected, {
    type: "set-replay-playing",
    playing: true,
  });
  assert.equal(playing.activeRoute, "replay");
  assert.equal(playing.selectedDecisionId, "decision-42");
  assert.equal(playing.replayPlaying, true);
  assert.equal(INITIAL_WORKBENCH_STATE.activeRoute, "overview");
});

test("workbench reducer clamps replay and toggles comparison runs", () => {
  let state = reduceWorkbenchState(INITIAL_WORKBENCH_STATE, {
    type: "seek-replay",
    positionPermille: 1200.4,
  });
  assert.equal(state.replayPositionPermille, 1000);
  state = reduceWorkbenchState(state, { type: "toggle-run", runId: "run-a" });
  assert.deepEqual(state.selectedRunIds, ["run-a"]);
  state = reduceWorkbenchState(state, { type: "toggle-run", runId: "run-a" });
  assert.deepEqual(state.selectedRunIds, []);
});

test("workbench reducer switches between automatic, verified and locked demo views", () => {
  const demo = reduceWorkbenchState(INITIAL_WORKBENCH_STATE, { type: "set-data-view", dataView: "demo" });
  assert.equal(demo.dataView, "demo");
  const verified = reduceWorkbenchState(demo, { type: "set-data-view", dataView: "verified" });
  assert.equal(verified.dataView, "verified");
  assert.equal(INITIAL_WORKBENCH_STATE.dataView, "auto");
});

test("desktop view parser accepts verified DTOs and rejects preview or path leakage", () => {
  const source = {
    schemaVersion: "workbench-view-v1",
    sourceKind: "verified-local",
    decisions: [{ id: "d1", time: "00:00:00Z", event: "DECISION", market: "BTC", direction: "YES", probability: "0.6", price: "0.5", edge: "0.1", eligibility: "ELIGIBLE", pnl: "0" }],
    chartSeries: { raw: [1], calibrated: [1], bid: [1], ask: [1], pnl: [0], brier: [0.2] },
    runs: [{ id: "r1", name: "K", pnl: "0", drawdown: "0", brier: "0.2", color: "blue" }],
  };
  assert.equal(parseWorkbenchViewV1(source).sourceKind, "verified-local");
  assert.throws(() => parseWorkbenchViewV1({ ...source, sourceKind: "preview" }));
  assert.throws(() => parseWorkbenchViewV1({ ...source, databasePath: "/secret/db.sqlite" }));
});
