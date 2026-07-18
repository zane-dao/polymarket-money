import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, realpath, statfs, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildKJPaperCampaign, campaignArtifact } from "../execution/src/product/kj-paper-campaign.js";
import { buildKJSignalComparePlan, signalCompareArtifact } from "../execution/src/product/kj-signal-compare.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInteger(value: string | undefined, field: string, fallback: number): number {
  const parsed = Number(value ?? String(fallback));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer`);
  return parsed;
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

function defaultRunId(now: Date): string {
  return `kj-compare-${now.toISOString().replace(/[-:.TZ]/gu, "").slice(0, 12)}`;
}

function launch(
  runtime: string,
  repository: string,
  campaignPlan: string,
  outputRoot: string,
  source: "binance" | "chainlink",
): Promise<number | null> {
  const child = spawn(process.execPath, [
    "--use-env-proxy", runtime,
    "--campaign-plan", campaignPlan,
    "--campaign-run", "1",
    "--output-root", outputRoot,
    "--kj-signal-source", source,
  ], { cwd: repository, stdio: ["ignore", "inherit", "inherit"] });
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", resolveExit);
  });
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write("Usage: npm run paper:signal-compare-mvp -- [--markets 3] [--settlement-grace-seconds 600] [--output-root /root/polymarket-money-data/signal-compare]\n");
    return;
  }
  const repository = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
  if (git(repository, ["status", "--porcelain", "--untracked-files=no"]) !== "") {
    throw new Error("paper:signal-compare-mvp refuses uncommitted tracked code");
  }
  const commit = git(repository, ["rev-parse", "HEAD"]);
  const now = new Date();
  const first = (Math.floor(now.getTime() / 300_000) + 1) * 300_000;
  if (first - now.getTime() < 60_000) throw new Error("signal comparison must start at least 60 seconds before the next five-minute boundary");
  const compareRunId = argument("--compare-run-id") ?? defaultRunId(now);
  const targetMarketCount = positiveInteger(argument("--markets"), "markets", 3);
  const settlementGraceSeconds = positiveInteger(argument("--settlement-grace-seconds"), "settlement-grace-seconds", 600);
  const outputRootInput = argument("--output-root") ?? "/root/polymarket-money-data/signal-compare";
  if (!isAbsolute(outputRootInput)) throw new Error("--output-root must be absolute");
  const outputRoot = resolve(outputRootInput);
  if (inside(repository, outputRoot)) throw new Error("signal comparison artifacts must remain outside Git");
  const parent = dirname(outputRoot);
  if (await realpath(parent) !== parent) throw new Error("signal comparison output parent must not contain symlinks");
  const filesystem = await statfs(parent);
  if (new Set([0x01021997, 0x5346544e, 0x65735546]).has(Number(filesystem.type))) {
    throw new Error("signal comparison requires a Linux-native output filesystem");
  }
  const plan = buildKJSignalComparePlan({
    compareRunId, plannedAt: now.toISOString(), collectorGitCommit: commit,
    firstFullMarketStart: new Date(first).toISOString(), targetMarketCount, settlementGraceSeconds,
  });
  const directory = join(outputRoot, plan.compareRunId);
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await mkdir(directory, { recursive: false, mode: 0o700 });
  await syncDirectory(outputRoot);
  const sourcePlans = plan.sourceRuns.map((sourceRun) => {
    const suffix: "binance" | "chainlink" = sourceRun.source === "BINANCE_SPOT" ? "binance" : "chainlink";
    const campaign = campaignArtifact(buildKJPaperCampaign({
      campaignId: `${plan.compareRunId}-${suffix}`,
      plannedAt: plan.plannedAt,
      collectorGitCommit: plan.collectorGitCommit,
      firstFullMarketStart: plan.firstFullMarketStart,
      runCount: 1,
      targetMarketCount: plan.targetMarketCount,
      settlementGraceSeconds: plan.settlementGraceSeconds,
      gapMarketCount: 0,
    }));
    if (campaign.campaign.runs[0]?.runId !== sourceRun.runId) throw new Error("paired campaign run ID differs from comparison plan");
    return { sourceRun, suffix, campaign, path: join(directory, `${suffix}-campaign.json`) };
  });
  await durableWrite(join(directory, "compare-plan.json"), `${JSON.stringify(signalCompareArtifact(plan), null, 2)}\n`);
  for (const item of sourcePlans) await durableWrite(item.path, `${JSON.stringify(item.campaign, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ accepted: true, compareRunId: plan.compareRunId, planHash: signalCompareArtifact(plan).planHash, firstFullMarketStart: plan.firstFullMarketStart, captureEnd: plan.captureEnd, artifacts: directory })}\n`);
  const runtime = fileURLToPath(new URL("./kj-paper-mvp.js", import.meta.url));
  const results = await Promise.all(sourcePlans.map(async (item) => ({
    source: item.sourceRun.source,
    exitCode: await launch(runtime, repository, item.path, join(directory, item.suffix), item.suffix),
  })));
  await durableWrite(join(directory, "compare-result.json"), `${JSON.stringify({
    compareRunId: plan.compareRunId,
    planHash: signalCompareArtifact(plan).planHash,
    completedAt: new Date().toISOString(),
    results,
  }, null, 2)}\n`);
  if (results.some((result) => result.exitCode !== 0)) process.exitCode = 2;
}

await main();
