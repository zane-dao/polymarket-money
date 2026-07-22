import assert from "node:assert/strict";
import test from "node:test";

import {
  buildKJPaperCampaign,
  campaignArtifact,
  campaignBinding,
  campaignRun,
  parseKJPaperCampaignArtifact,
} from "../../backend/core/src/product/kj-paper-campaign.js";

const input = {
  campaignId: "kj-evidence-july",
  plannedAt: "2026-07-17T00:00:00.000Z",
  collectorGitCommit: "a".repeat(40),
  firstFullMarketStart: "2026-07-17T01:00:00.000Z",
  runCount: 3,
  targetMarketCount: 3,
  settlementGraceSeconds: 600,
  gapMarketCount: 1,
} as const;

test("campaign pre-registers deterministic non-overlapping paper windows", () => {
  const campaign = buildKJPaperCampaign(input);
  assert.deepEqual(campaign.runs.map((run) => run.runId), [
    "kj-evidence-july-r001", "kj-evidence-july-r002", "kj-evidence-july-r003",
  ]);
  assert.equal(campaign.runs[0]?.captureEnd, "2026-07-17T01:15:00.000Z");
  assert.equal(campaign.runs[1]?.firstFullMarketStart, "2026-07-17T01:20:00.000Z");
  const artifact = campaignArtifact(campaign);
  assert.equal(parseKJPaperCampaignArtifact(artifact).campaignHash, artifact.campaignHash);
  assert.deepEqual(campaignRun(artifact, 2), campaign.runs[1]);
  assert.deepEqual(campaignBinding(artifact, 2), {
    campaignId: campaign.campaignId, campaignHash: artifact.campaignHash, campaignRunIndex: 2,
  });
});

test("campaign rejects post-start, non-boundary and tampered schedules", () => {
  assert.throws(() => buildKJPaperCampaign({ ...input, plannedAt: input.firstFullMarketStart }), /planned before/u);
  assert.throws(() => buildKJPaperCampaign({ ...input, firstFullMarketStart: "2026-07-17T01:01:00.000Z" }), /five-minute boundary/u);
  const artifact = campaignArtifact(buildKJPaperCampaign(input));
  assert.throws(() => parseKJPaperCampaignArtifact({ ...artifact, campaignHash: "0".repeat(64) }), /hash mismatch/u);
});
