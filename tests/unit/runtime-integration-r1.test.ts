import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const source = (path: string): Promise<string> => readFile(new URL(path, root), "utf8");

test("live runtime is wired to the frozen R1 contracts", async () => {
  const runtime = await source("scripts/live-runtime.ts");
  for (const required of [
    "LeadLagEngine",
    "DEFAULT_LEAD_LAG_CONFIG",
    "FeeEdgeCalculator",
    "createOpportunityObservationV1",
    "createRouteEvaluationV1",
    "FailClosedRuntime",
    "createRuntimeIncident",
  ]) {
    assert.match(runtime, new RegExp(`\\b${required}\\b`, "u"), required);
  }
  assert.doesNotMatch(runtime, /\bleadLagObserver\b/u);
  assert.doesNotMatch(runtime, /previousSpot/u);
  assert.doesNotMatch(runtime, /receiveLatencyP(?:50|95)Ms/u);
  assert.doesNotMatch(runtime, /\blatencies\b/u);
  for (const sourceName of [
    "POLYMARKET_RTDS_CHAINLINK",
    "POLYMARKET_RTDS_BINANCE",
    "BINANCE_SPOT",
    "BINANCE_PERPETUAL",
  ]) assert.match(runtime, new RegExp(sourceName, "u"));
  assert.match(runtime, /leadLagGrid/u);
});

test("legacy observers delegate exact money and fee calculations", async () => {
  const [paper, opportunities] = await Promise.all([
    source("execution/src/runtime/paper.ts"),
    source("execution/src/runtime/opportunities.ts"),
  ]);
  assert.match(paper, /FeeEdgeCalculator/u);
  assert.match(paper, /Money/u);
  assert.doesNotMatch(paper, /interface DecimalValue/u);
  assert.match(opportunities, /FeeEdgeCalculator/u);
  assert.match(opportunities, /Money/u);
  assert.doesNotMatch(opportunities, /\bNumber\(/u);
});

test("active capture and runtime paths contain no empty catch disposition", async () => {
  const paths = [
    "scripts/live-runtime.ts",
    "scripts/smoke-capture.ts",
    "execution/src/adapters/market-data/public-sources.ts",
    "execution/src/adapters/market-data/parsers.ts",
    "execution/src/storage/raw-segment.ts",
  ];
  for (const path of paths) {
    const text = await source(path);
    assert.doesNotMatch(text, /catch\s*\{/u, path);
    assert.doesNotMatch(text, /\.catch\(\(\)\s*=>\s*(?:undefined|null)\)/u, path);
  }
});
