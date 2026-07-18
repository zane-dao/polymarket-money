import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, statfs, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseKJSignalCompareCampaignArtifact } from "../execution/src/product/kj-signal-compare-campaign.js";
import {
  claimKJSignalCompareCampaignLaunch,
  KJ_SIGNAL_COMPARE_CAMPAIGN_LAUNCH_CLAIM_VERSION,
} from "../execution/src/product/kj-signal-compare-campaign-launch-claim.js";
import { KJ_PAPER_WARMUP_SECONDS } from "../execution/src/product/kj-paper-mvp.js";

const LAUNCH_LEAD_SECONDS = KJ_PAPER_WARMUP_SECONDS + 30;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function git(repository: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr).trim()}`);
  }
  return result.stdout.trim();
}

function inside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function durableWrite(path: string, value: string): Promise<void> {
  let handle: FileHandle | null = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
  try { await handle.writeFile(value, "utf8"); await handle.sync(); } finally { await handle?.close(); }
  await syncDirectory(dirname(path));
}

async function waitUntil(time: number): Promise<void> {
  while (Date.now() < time) {
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, Math.min(time - Date.now(), 60_000)));
  }
}

function launch(runtime: string, repository: string, campaignPlan: string, campaignRunIndex: number, outputRoot: string): Promise<number | null> {
  const child = spawn(process.execPath, [
    "--use-env-proxy", runtime,
    "--compare-campaign-plan", campaignPlan,
    "--campaign-run", String(campaignRunIndex),
    "--output-root", outputRoot,
  ], { cwd: repository, stdio: ["ignore", "inherit", "inherit"] });
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", resolveExit);
  });
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write([
      "Usage: npm run paper:signal-compare-campaign-run -- --campaign-plan /absolute/campaign.json",
      "       [--output-root /root/polymarket-money-data/signal-compare-campaign]",
      "",
      "Launches every pre-registered paired run exactly at its fixed pre-warmup time.",
      "A missed launch window fails closed; it never shifts or replaces a run.",
      "",
    ].join("\n"));
    return;
  }
  const repository = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  if (git(repository, ["status", "--porcelain", "--untracked-files=no"]) !== "") {
    throw new Error("paired campaign launcher refuses uncommitted tracked code");
  }
  const campaignPathInput = argument("--campaign-plan");
  if (campaignPathInput === undefined || !isAbsolute(campaignPathInput)) {
    throw new Error("--campaign-plan must be an absolute artifact path");
  }
  const campaignPath = resolve(campaignPathInput);
  const campaign = parseKJSignalCompareCampaignArtifact(JSON.parse(await readFile(campaignPath, "utf8")) as unknown);
  if (campaign.collectorGitCommit !== git(repository, ["rev-parse", "HEAD"])) {
    throw new Error("paired campaign collector commit conflicts with current code");
  }
  const outputRootInput = argument("--output-root") ?? "/root/polymarket-money-data/signal-compare-campaign";
  if (!isAbsolute(outputRootInput)) throw new Error("--output-root must be absolute");
  const outputRoot = resolve(outputRootInput);
  if (inside(repository, outputRoot)) throw new Error("paired campaign artifacts must remain outside Git");
  const parent = dirname(outputRoot);
  if (await realpath(parent) !== parent) throw new Error("paired campaign output parent must not contain symlinks");
  const filesystem = await statfs(parent);
  if (new Set([0x01021997, 0x5346544e, 0x65735546]).has(Number(filesystem.type))) {
    throw new Error("paired campaign requires a Linux-native output filesystem");
  }
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await syncDirectory(parent);
  const resultPath = join(outputRoot, `${campaign.campaignId}-launcher-result.json`);
  try { await readFile(resultPath); throw new Error("paired campaign launcher result already exists"); } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await claimKJSignalCompareCampaignLaunch(outputRoot, {
    schemaVersion: KJ_SIGNAL_COMPARE_CAMPAIGN_LAUNCH_CLAIM_VERSION,
    campaignId: campaign.campaignId,
    campaignHash: campaign.campaignHash,
    collectorGitCommit: campaign.collectorGitCommit,
    claimedAt: new Date().toISOString(),
  });
  await syncDirectory(outputRoot);
  const runtime = fileURLToPath(new URL("./kj-signal-compare-mvp.js", import.meta.url));
  const launches: Array<Promise<Readonly<{ compareRunId: string; runIndex: number; launchedAt: string; exitCode: number | null }>>> = [];
  for (const [offset, artifact] of campaign.comparisons.entries()) {
    const runIndex = offset + 1;
    const launchAt = Date.parse(artifact.plan.firstFullMarketStart) - LAUNCH_LEAD_SECONDS * 1_000;
    if (Date.now() > launchAt) throw new Error(`paired campaign run ${runIndex} missed its fixed pre-warmup launch window`);
    await waitUntil(launchAt);
    const launchedAt = new Date().toISOString();
    launches.push(launch(runtime, repository, campaignPath, runIndex, outputRoot).then((exitCode) => Object.freeze({
      compareRunId: artifact.plan.compareRunId, runIndex, launchedAt, exitCode,
    })));
  }
  const results = await Promise.all(launches);
  await durableWrite(resultPath, `${JSON.stringify({
    schemaVersion: "kj-signal-compare-campaign-launcher-result-v1",
    campaignId: campaign.campaignId,
    campaignHash: campaign.campaignHash,
    completedAt: new Date().toISOString(),
    results,
  }, null, 2)}\n`);
  if (results.some((result) => result.exitCode !== 0)) process.exitCode = 2;
}

await main();
