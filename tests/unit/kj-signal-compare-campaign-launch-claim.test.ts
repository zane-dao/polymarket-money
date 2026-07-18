import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  claimKJSignalCompareCampaignLaunch,
  KJ_SIGNAL_COMPARE_CAMPAIGN_LAUNCH_CLAIM_VERSION,
} from "../../execution/src/product/kj-signal-compare-campaign-launch-claim.js";

test("campaign launcher makes a durable fail-closed single claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "kj-campaign-claim-"));
  const claim = {
    schemaVersion: KJ_SIGNAL_COMPARE_CAMPAIGN_LAUNCH_CLAIM_VERSION,
    campaignId: "paired-evidence-20260718",
    campaignHash: "a".repeat(64),
    collectorGitCommit: "b".repeat(40),
    claimedAt: "2026-07-18T08:00:00.000Z",
  } as const;
  try {
    const path = await claimKJSignalCompareCampaignLaunch(root, claim);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), claim);
    await assert.rejects(
      claimKJSignalCompareCampaignLaunch(root, claim),
      /paired campaign launcher already claimed/u,
    );
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), claim);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
