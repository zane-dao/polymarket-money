import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

export const KJ_SIGNAL_COMPARE_CAMPAIGN_LAUNCH_CLAIM_VERSION =
  "kj-signal-compare-campaign-launch-claim-v1" as const;

export interface KJSignalCompareCampaignLaunchClaim {
  readonly schemaVersion: typeof KJ_SIGNAL_COMPARE_CAMPAIGN_LAUNCH_CLAIM_VERSION;
  readonly campaignId: string;
  readonly campaignHash: string;
  readonly collectorGitCommit: string;
  readonly claimedAt: string;
}

/**
 * Atomically reserves one immutable campaign launcher.  The claim deliberately
 * remains after a launcher crash: deleting or replacing a scheduled run would
 * turn a missed window into an unregistered rerun.
 */
export async function claimKJSignalCompareCampaignLaunch(
  outputRoot: string,
  claim: KJSignalCompareCampaignLaunchClaim,
): Promise<string> {
  const path = join(outputRoot, `${claim.campaignId}-launcher-claim.json`);
  let handle: FileHandle | null = null;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o400,
    );
    await handle.writeFile(`${JSON.stringify(claim, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`paired campaign launcher already claimed: ${path}`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
  return path;
}
