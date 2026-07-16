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
    "createOpportunityRuntimeConfig",
    "leadLagObservations",
    "leadLagTriggers",
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
  assert.match(runtime, /leadLagEvidence\s*=\s*state\.leadLagObservations/u);
  assert.match(runtime, /AbortController/u);
  assert.match(runtime, /process\.once\("SIGTERM"/u);
  assert.match(runtime, /sessionAbort\.abort\(\)/u);
  assert.match(runtime, /retirePolymarketWorkingHistory/u);
  assert.match(runtime, /observedMilliseconds\s*>=\s*Date\.parse\(market\.intervalEnd\)/u);
  assert.doesNotMatch(runtime, /opportunities:\s*audits,\s*leadLagGrid:/u);
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
  assert.doesNotMatch(paper, /function\s+completeSetGrossEdge/u);
  assert.doesNotMatch(opportunities, /grossEdge:\s*result\?\./u);
  assert.match(paper, /evidence_status:\s*feeRate === null \? "MISSING"/u);
  assert.match(opportunities, /evidence_status:\s*feeRate === null \? "MISSING"/u);
});

test("live runtime wires K/J mutation only behind explicit durable paper journal", async () => {
  const runtime = await source("scripts/live-runtime.ts");
  assert.match(runtime, /config\.mode === "paper" && kjContext\.ready && state\.kjPaperJournal !== null/u);
  assert.match(runtime, /state\.kjPaperJournal\.appendContext\(kjContext\.context\)/u);
  assert.match(runtime, /KJPaperJournal\.open\(config\.kjPaperJournalPath\)/u);
  assert.match(runtime, /kjPaperEngineVersion:\s*KJ_PAPER_ENGINE_VERSION/u);
  assert.match(runtime, /kjPaperJournalLastRecordHash/u);
  assert.match(runtime, /settlementLoop\(/u);
  assert.match(runtime, /state\.kjPaperJournal\.appendGammaResolution/u);
  assert.match(runtime, /GammaResolutionPending/u);
  assert.match(runtime, /kjSettlementGraceMilliseconds/u);
  assert.match(runtime, /kjMarketStartBeforeMilliseconds/u);
  assert.match(runtime, /Date\.parse\(chosen\.intervalStart\)\s*>=\s*marketStartBeforeMilliseconds/u);
  assert.match(runtime, /kjPaperEvents/u);
  assert.match(runtime, /kjPaperWallets/u);
  assert.doesNotMatch(runtime, /kjPaperEngine\.settle\(/u);
});

test("active capture and runtime paths contain no empty catch disposition", async () => {
  const paths = [
    "scripts/live-runtime.ts",
    "scripts/smoke-capture.ts",
    "execution/src/adapters/market-data/public-sources.ts",
    "execution/src/adapters/market-data/parsers.ts",
    "execution/src/storage/raw-segment.ts",
    "execution/src/storage/kj-paper-journal.ts",
  ];
  for (const path of paths) {
    const text = await source(path);
    assert.doesNotMatch(text, /catch\s*\{/u, path);
    assert.doesNotMatch(text, /\.catch\(\(\)\s*=>\s*(?:undefined|null)\)/u, path);
  }
});
