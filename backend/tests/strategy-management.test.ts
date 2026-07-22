import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDefaultStrategyCatalog, FileStrategyVersionStore, StrategyCatalog, type StrategyDefinitionV1, type StrategyVersionV1 } from "../strategy-management/index.js";

const definition: StrategyDefinitionV1 = {
  strategyId: "k-edge", displayName: "K Edge", runtime: "python", allowedModes: ["backtest", "paper"],
  parameters: { edge: { type: "number", required: true, minimum: 0, maximum: 1 }, partialFill: { type: "boolean", required: true } },
};

function version(parameters: StrategyVersionV1["parameters"] = { edge: 0.02, partialFill: true }): StrategyVersionV1 {
  return { schemaVersion: "strategy-version-v1", strategyId: "k-edge", version: "1.0.0", description: "frozen test", parameters, createdAtUtc: "2026-07-21T12:00:00Z" };
}

test("strategy backend validates, saves, lists and reloads immutable versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "strategy-store-"));
  const catalog = new StrategyCatalog(); catalog.register(definition);
  const store = new FileStrategyVersionStore(root);
  await store.save(catalog, version());
  assert.deepEqual(await store.list("k-edge"), ["1.0.0"]);
  assert.deepEqual(await store.load(catalog, "k-edge", "1.0.0"), version());
  await assert.rejects(store.save(catalog, version()), /EEXIST/u);
  const persisted = await readFile(join(root, "workbench", "strategy-versions", "k-edge", "1.0.0.json"), "utf8");
  assert.equal(persisted.includes("partialFill"), true);
  await assert.rejects(store.delete(catalog, "k-edge", "1.0.0", "wrong"), /confirmation/u);
  await store.delete(catalog, "k-edge", "1.0.0", "k-edge:1.0.0");
  assert.deepEqual(await store.list("k-edge"), []);
});

test("strategy backend rejects unknown, missing, out-of-range and path-like inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "strategy-store-"));
  const catalog = new StrategyCatalog(); catalog.register(definition);
  const store = new FileStrategyVersionStore(root);
  await assert.rejects(store.save(catalog, version({ edge: 2, partialFill: true })), /outside/u);
  await assert.rejects(store.save(catalog, version({ edge: 0.2 })), /missing/u);
  await assert.rejects(store.load(catalog, "../escape", "1.0.0"), /invalid/u);
  assert.throws(() => catalog.validateParameters("k-edge", { edge: 0.2, partialFill: true, secret: "x" }), /unknown parameter/u);
});

test("research-only L V2 cannot be selected for realtime Paper", () => {
  const catalog=createDefaultStrategyCatalog();
  assert.deepEqual(catalog.get("L_ADAPTIVE_EXECUTION_V1").allowedModes,[]);
  assert.equal(catalog.get("L_ADAPTIVE_EXECUTION_V1").researchStatus,"RESEARCH_GATE_FAILED");
  assert.equal(catalog.get("L_ADAPTIVE_EXECUTION_V1").displayName,"自适应执行（L V1 · 历史门失败）");
  assert.deepEqual(catalog.get("L_ADAPTIVE_EXECUTION_V2").allowedModes,["backtest"]);
  assert.equal(catalog.get("L_ADAPTIVE_EXECUTION_V2").researchStatus,"RESEARCH_ONLY");
  assert.equal(catalog.get("L_ADAPTIVE_EXECUTION_V2").parameters.maxStakeUsdc?.displayName,"单次最大投入");
  assert.equal(catalog.get("J_FEE_AWARE").parameters.edgeThreshold?.unit,"概率");
  assert.equal(catalog.get("J_FEE_AWARE").parameters.edgeThreshold?.defaultValue,0.05);
  assert.equal(catalog.get("J_FEE_AWARE").parameters.maxEdge?.defaultValue,0.25);
  assert.equal(catalog.get("L_ADAPTIVE_EXECUTION_V2").parameters.maxSignalEdge?.defaultValue,0.25);
  assert.deepEqual(catalog.get("J_FEE_AWARE").allowedModes,["backtest","paper"]);
  assert.doesNotThrow(()=>catalog.validateParameters("J_FEE_AWARE",{edgeThreshold:0.05,maxEdge:0.05,maxStakeUsdc:1,bookParticipation:0.000001}));
  assert.deepEqual(catalog.parameterWarnings("J_FEE_AWARE",{edgeThreshold:0.05,maxEdge:0.05,maxStakeUsdc:1,bookParticipation:0.000001}).map((warning)=>warning.code),["EMPTY_EDGE_WINDOW"]);
  assert.doesNotThrow(()=>catalog.validateParameters("L_ADAPTIVE_EXECUTION_V2",{maxSignalEdge:0,maxStakeUsdc:1,bookParticipation:0.000001}));
  assert.deepEqual(catalog.parameterWarnings("L_ADAPTIVE_EXECUTION_V2",{maxSignalEdge:0,maxStakeUsdc:1,bookParticipation:0.000001}).map((warning)=>warning.code),["ZERO_SIGNAL_EDGE_GUARD"]);
  assert.throws(()=>catalog.register({...definition,strategyId:"invalid-mode",allowedModes:[]}),/allowedModes/);
});
