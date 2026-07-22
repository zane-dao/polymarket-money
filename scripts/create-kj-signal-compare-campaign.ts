import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildKJSignalCompareCampaign } from "../backend/core/src/product/kj-signal-compare-campaign.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInteger(value: string | undefined, field: string, fallback: number): number {
  const parsed = Number(value ?? String(fallback));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(value: string | undefined, field: string, fallback: number): number {
  const parsed = Number(value ?? String(fallback));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${field} must be a non-negative integer`);
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

async function durableWrite(path: string, value: string): Promise<void> {
  let handle: FileHandle | null = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
  try { await handle.writeFile(value, "utf8"); await handle.sync(); } finally { await handle?.close(); }
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write([
      "Usage: npm run paper:signal-compare-campaign-plan -- --campaign-id paired-20260718 --first-full-market-start 2026-07-18T12:00:00.000Z --runs 3 --output /absolute/new-campaign.json",
      "       [--markets 3] [--gap-markets 2] [--settlement-grace-seconds 600]",
      "",
      "Creates one immutable Binance/Chainlink paired campaign artifact. It never starts collection.",
      "",
    ].join("\n"));
    return;
  }
  const repository = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  if (git(repository, ["status", "--porcelain", "--untracked-files=no"]) !== "") {
    throw new Error("paper:signal-compare-campaign-plan refuses uncommitted tracked code");
  }
  const output = argument("--output");
  if (output === undefined || !isAbsolute(output)) throw new Error("--output must be an absolute new file path");
  const outputPath = resolve(output);
  if (inside(repository, outputPath)) throw new Error("campaign artifact must remain outside Git");
  const parent = dirname(outputPath);
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || await realpath(parent) !== parent) {
    throw new Error("campaign artifact parent must be a real non-symlink directory");
  }
  try { await readFile(outputPath); throw new Error("campaign artifact output already exists"); } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const campaign = buildKJSignalCompareCampaign({
    campaignId: argument("--campaign-id") ?? (() => { throw new Error("--campaign-id is required"); })(),
    plannedAt: new Date().toISOString(),
    collectorGitCommit: git(repository, ["rev-parse", "HEAD"]),
    firstFullMarketStart: argument("--first-full-market-start") ?? (() => { throw new Error("--first-full-market-start is required"); })(),
    runCount: positiveInteger(argument("--runs"), "runs", 1),
    targetMarketCount: positiveInteger(argument("--markets"), "markets", 3),
    settlementGraceSeconds: positiveInteger(argument("--settlement-grace-seconds"), "settlement-grace-seconds", 600),
    gapMarketCount: nonNegativeInteger(argument("--gap-markets"), "gap-markets", 2),
  });
  await durableWrite(outputPath, `${JSON.stringify(campaign, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ accepted: true, campaignId: campaign.campaignId, campaignHash: campaign.campaignHash, outputPath })}\n`);
}

await main();

