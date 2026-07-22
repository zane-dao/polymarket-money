import assert from "node:assert/strict";
import test from "node:test";

import {
  buildKJSignalComparePlan,
  kjSignalComparePlanHash,
  parseKJSignalCompareArtifact,
  signalCompareArtifact,
} from "../../backend/core/src/product/kj-signal-compare.js";

const input = {
  compareRunId: "kj-compare-20260718-0500",
  plannedAt: "2026-07-18T04:54:00.000Z",
  collectorGitCommit: "a".repeat(40),
  firstFullMarketStart: "2026-07-18T05:00:00.000Z",
  targetMarketCount: 3,
  settlementGraceSeconds: 600,
} as const;

test("signal comparison freezes one matched Binance and Chainlink run pair", () => {
  const plan = buildKJSignalComparePlan(input);
  assert.equal(plan.captureEnd, "2026-07-18T05:15:00.000Z");
  assert.deepEqual(plan.sourceRuns, [
    { source: "BINANCE_SPOT", runId: "kj-compare-20260718-0500-binance-r001" },
    { source: "POLYMARKET_RTDS_CHAINLINK", runId: "kj-compare-20260718-0500-chainlink-r001" },
  ]);
  assert.match(kjSignalComparePlanHash(plan), /^[0-9a-f]{64}$/u);
  assert.equal(parseKJSignalCompareArtifact(signalCompareArtifact(plan)).plan.compareRunId, plan.compareRunId);
});

test("signal comparison rejects a late, non-boundary, or tampered plan", () => {
  assert.throws(() => buildKJSignalComparePlan({ ...input, plannedAt: input.firstFullMarketStart }), /planned before/u);
  assert.throws(() => buildKJSignalComparePlan({ ...input, firstFullMarketStart: "2026-07-18T05:01:00.000Z" }), /five-minute boundary/u);
  const artifact = signalCompareArtifact(buildKJSignalComparePlan(input));
  assert.throws(() => parseKJSignalCompareArtifact({ ...artifact, planHash: "0".repeat(64) }), /hash mismatch/u);
});
