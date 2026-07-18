import assert from "node:assert/strict";
import test from "node:test";

import {
  buildKJSignalCompareCampaign,
  parseKJSignalCompareCampaignArtifact,
} from "../../execution/src/product/kj-signal-compare-campaign.js";

const input = {
  campaignId: "paired-evidence-20260718",
  plannedAt: "2026-07-18T04:50:00.000Z",
  collectorGitCommit: "a".repeat(40),
  firstFullMarketStart: "2026-07-18T05:00:00.000Z",
  runCount: 2,
  targetMarketCount: 3,
  settlementGraceSeconds: 600,
  gapMarketCount: 2,
} as const;

test("paired signal campaign pre-registers matched per-source campaigns and pair plans", () => {
  const campaign = buildKJSignalCompareCampaign(input);
  assert.match(campaign.campaignHash, /^[0-9a-f]{64}$/u);
  assert.equal(campaign.comparisons.length, 2);
  assert.equal(campaign.binanceCampaign.campaign.runs[1]?.firstFullMarketStart, "2026-07-18T05:25:00.000Z");
  assert.deepEqual(campaign.comparisons[1]?.plan.sourceRuns, [
    { source: "BINANCE_SPOT", runId: "paired-evidence-20260718-binance-r002" },
    { source: "POLYMARKET_RTDS_CHAINLINK", runId: "paired-evidence-20260718-chainlink-r002" },
  ]);
  assert.equal(parseKJSignalCompareCampaignArtifact(campaign).campaignHash, campaign.campaignHash);
});

test("paired signal campaign rejects tampered source mapping and unsafe campaign IDs", () => {
  const campaign = buildKJSignalCompareCampaign(input);
  const altered = structuredClone(campaign) as unknown as Record<string, unknown>;
  const comparisons = altered.comparisons as Array<Record<string, unknown>>;
  const plan = comparisons[0]?.plan as Record<string, unknown>;
  plan.sourceRuns = [
    { source: "BINANCE_SPOT", runId: "paired-evidence-20260718-binance-r001" },
    { source: "POLYMARKET_RTDS_CHAINLINK", runId: "wrong-run-id" },
  ];
  assert.throws(() => parseKJSignalCompareCampaignArtifact(altered), /inconsistent|hash mismatch/u);
  assert.throws(() => buildKJSignalCompareCampaign({ ...input, campaignId: "x".repeat(56) }), /unsupported|safe source/u);
});
