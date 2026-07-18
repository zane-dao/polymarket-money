import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, statfs, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildKJPaperCampaignCohortReport,
  kjPaperCampaignCohortReportHash,
} from "../execution/src/product/kj-paper-campaign-cohort-report.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function inputs(): string[] {
  const values: string[] = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === "--input") {
      const value = process.argv[index + 1];
      if (value === undefined) throw new Error("--input requires an absolute report directory");
      values.push(value);
      index += 1;
    }
  }
  return values;
}

function inside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function regularFile(path: string, field: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${field} must be absolute`);
  const resolved = resolve(path);
  const info = await lstat(resolved);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${field} must be a regular non-symlink file`);
  return resolved;
}

async function regularDirectory(path: string, field: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${field} must be absolute`);
  const resolved = resolve(path);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(resolved) !== resolved) {
    throw new Error(`${field} must be a real non-symlink directory`);
  }
  return resolved;
}

async function json(path: string, field: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")) as unknown; } catch (error) {
    throw new Error(`${field} is invalid JSON`, { cause: error });
  }
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

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write("Usage: npm run paper:campaign-cohort-report -- --campaign-plan /absolute/campaign.json --input /absolute/report-dir [--input /absolute/report-dir] --output /absolute/new-cohort-directory\n");
    return;
  }
  const campaignPathInput = argument("--campaign-plan");
  const outputInput = argument("--output");
  if (campaignPathInput === undefined) throw new Error("--campaign-plan is required");
  if (outputInput === undefined || !isAbsolute(outputInput)) throw new Error("--output must be an absolute directory");
  const repository = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
  const campaignPath = await regularFile(campaignPathInput, "campaign plan");
  const reportDirectories = await Promise.all(inputs().map((source) => regularDirectory(source, "paper report input")));
  if (reportDirectories.length === 0) throw new Error("campaign cohort requires at least one --input");
  if (inside(repository, campaignPath) || reportDirectories.some((directory) => inside(repository, directory))) {
    throw new Error("campaign cohort inputs must remain outside Git");
  }
  const outputDirectory = resolve(outputInput);
  if (inside(repository, outputDirectory)) throw new Error("campaign cohort output must remain outside Git");
  const parent = dirname(outputDirectory);
  if (await realpath(parent) !== parent) throw new Error("campaign cohort output parent must not contain symlinks");
  const filesystem = await statfs(parent);
  if (new Set([0x01021997, 0x5346544e, 0x65735546]).has(Number(filesystem.type))) {
    throw new Error("campaign cohort output requires a Linux-native filesystem");
  }
  const reportInputs = await Promise.all(reportDirectories.map(async (directory) => ({
    sourcePath: join(directory, "summary.json"),
    artifact: await json(join(directory, "summary.json"), "paper report summary"),
  })));
  const report = buildKJPaperCampaignCohortReport({
    campaignArtifact: await json(campaignPath, "campaign plan"), reports: reportInputs,
  });
  const cohortHash = kjPaperCampaignCohortReportHash(report);
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  await syncDirectory(parent);
  await durableWrite(join(outputDirectory, "summary.json"), `${JSON.stringify({ report, cohortHash }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ accepted: true, campaignId: report.campaign.campaignId, runCount: report.cohort.runCount, cohortHash, outputDirectory })}\n`);
}

await main();
