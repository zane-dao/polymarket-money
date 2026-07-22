import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, statfs, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildKJSignalCompareReport,
  kjSignalCompareReportHash,
} from "../backend/core/src/product/kj-signal-compare-report.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
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
    process.stdout.write("Usage: npm run paper:signal-compare-report -- --compare-plan /absolute/compare-plan.json --binance-report /absolute/report-dir --chainlink-report /absolute/report-dir --output /absolute/new-report-directory\n");
    return;
  }
  const comparePlanInput = argument("--compare-plan");
  const binanceReportInput = argument("--binance-report");
  const chainlinkReportInput = argument("--chainlink-report");
  const outputInput = argument("--output");
  if (comparePlanInput === undefined || binanceReportInput === undefined || chainlinkReportInput === undefined) {
    throw new Error("paper:signal-compare-report requires --compare-plan, --binance-report, and --chainlink-report");
  }
  if (outputInput === undefined || !isAbsolute(outputInput)) throw new Error("--output must be an absolute directory");
  const repository = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
  const comparePlan = await regularFile(comparePlanInput, "compare plan");
  const binanceReport = await regularDirectory(binanceReportInput, "Binance paper report");
  const chainlinkReport = await regularDirectory(chainlinkReportInput, "Chainlink paper report");
  const outputDirectory = resolve(outputInput);
  if (inside(repository, comparePlan) || inside(repository, binanceReport) || inside(repository, chainlinkReport) || inside(repository, outputDirectory)) {
    throw new Error("signal comparison inputs and output must remain outside Git");
  }
  const outputParent = dirname(outputDirectory);
  if (await realpath(outputParent) !== outputParent) throw new Error("signal comparison output parent must not contain symlinks");
  const filesystem = await statfs(outputParent);
  if (new Set([0x01021997, 0x5346544e, 0x65735546]).has(Number(filesystem.type))) {
    throw new Error("signal comparison output requires a Linux-native filesystem");
  }
  const [binanceArtifact, chainlinkArtifact] = await Promise.all([
    json(join(binanceReport, "summary.json"), "Binance paper report"),
    json(join(chainlinkReport, "summary.json"), "Chainlink paper report"),
  ]);
  const runtimePath = (artifact: unknown, field: string): string => {
    if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) throw new Error(`${field} artifact must be an object`);
    const report = (artifact as Record<string, unknown>).report;
    if (report === null || typeof report !== "object" || Array.isArray(report)) throw new Error(`${field} report must be an object`);
    const run = (report as Record<string, unknown>).run;
    if (run === null || typeof run !== "object" || Array.isArray(run) || typeof (run as Record<string, unknown>).journalPath !== "string") {
      throw new Error(`${field} report journalPath is invalid`);
    }
    return join(dirname((run as Record<string, unknown>).journalPath as string), "runtime-summary.json");
  };
  const [binanceRuntime, chainlinkRuntime] = await Promise.all([
    json(await regularFile(runtimePath(binanceArtifact, "Binance"), "Binance runtime summary"), "Binance runtime summary"),
    json(await regularFile(runtimePath(chainlinkArtifact, "Chainlink"), "Chainlink runtime summary"), "Chainlink runtime summary"),
  ]);
  const report = buildKJSignalCompareReport({
    compareArtifact: await json(comparePlan, "compare plan"),
    binanceArtifact,
    binanceRuntimeSummary: binanceRuntime,
    chainlinkArtifact,
    chainlinkRuntimeSummary: chainlinkRuntime,
  });
  const reportHash = kjSignalCompareReportHash(report);
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  await syncDirectory(outputParent);
  await durableWrite(join(outputDirectory, "summary.json"), `${JSON.stringify({ report, reportHash }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ accepted: true, compareRunId: report.compareRunId, reportHash, outputDirectory, strategies: report.strategies })}\n`);
}

await main();
