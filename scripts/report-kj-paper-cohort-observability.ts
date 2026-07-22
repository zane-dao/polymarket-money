import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, statfs, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildKJPaperCohortObservabilityReport,
  kjPaperCohortObservabilityReportHash,
  type KJPaperCohortObservabilityInput,
} from "../backend/core/src/product/kj-paper-cohort-observability-report.js";
import {
  buildKJPaperCampaignCohortObservabilityReport,
  kjPaperCampaignCohortObservabilityReportHash,
} from "../backend/core/src/product/kj-paper-campaign-cohort-observability-report.js";
import { KJPaperJournal } from "../backend/core/src/storage/kj-paper-journal.js";

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

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be non-empty`);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function inside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
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

async function regularFile(path: string, field: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${field} must be absolute`);
  const resolved = resolve(path);
  const info = await lstat(resolved);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(resolved) !== resolved) {
    throw new Error(`${field} must be a real non-symlink file`);
  }
  return resolved;
}

async function regularText(path: string, field: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error(`${field} must be a real non-symlink file`);
  }
  return readFile(path, "utf8");
}

async function json(path: string, field: string): Promise<{ readonly raw: string; readonly value: unknown }> {
  const raw = await regularText(path, field);
  try {
    return Object.freeze({ raw, value: JSON.parse(raw) as unknown });
  } catch (error) {
    throw new Error(`${field} is invalid JSON`, { cause: error });
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function durableWrite(path: string, value: string): Promise<void> {
  let handle: FileHandle | null = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o400,
  );
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await syncDirectory(dirname(path));
  } finally { await handle?.close(); }
}

async function observabilityInput(reportDirectory: string, repository: string): Promise<KJPaperCohortObservabilityInput> {
  const summaryPath = join(reportDirectory, "summary.json");
  const artifact = await json(summaryPath, "paper report summary");
  const outer = object(artifact.value, "paper report artifact");
  const report = object(outer.report, "paper report");
  const run = object(report.run, "paper report run");
  const journalPath = text(run.journalPath, "paper report journal path");
  if (!isAbsolute(journalPath)) throw new Error("paper report journal path must be absolute");
  const runDirectory = await regularDirectory(dirname(journalPath), "MVP run directory");
  if (inside(repository, runDirectory)
    || journalPath !== join(runDirectory, "kj-inputs.ndjson")) {
    throw new Error("paper report journal path conflicts with a safe MVP run directory");
  }
  const sourceHashes = object(outer.sourceFileSha256, "paper report source hashes");
  const plan = await json(join(runDirectory, "run-plan.json"), "MVP run plan");
  const resultFileName = outer.resultFileName === "result.json" || outer.resultFileName === "final-result.json"
    ? outer.resultFileName : (() => { throw new Error("paper report result file name is invalid"); })();
  const result = await json(join(runDirectory, resultFileName), "MVP result");
  const runtime = await json(join(runDirectory, "runtime-summary.json"), "runtime summary");
  for (const [field, raw] of Object.entries({ runPlan: plan.raw, result: result.raw, runtimeSummary: runtime.raw })) {
    if (sha256(raw) !== text(sourceHashes[field], `paper report ${field} hash`)) {
      throw new Error(`paper report ${field} source file hash mismatch`);
    }
  }
  const journal = await KJPaperJournal.open(journalPath);
  try {
    return Object.freeze({
      sourcePath: summaryPath,
      artifact: artifact.value,
      runtimeSummary: runtime.value,
      runtimeSummarySha256: sha256(runtime.raw),
      journalRecordCount: journal.recordCount,
      journalLastRecordHash: journal.lastRecordHash,
      events: journal.engine.events(),
    });
  } finally {
    await journal.close();
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    const command = process.argv.includes("--require-campaign")
      ? "paper:campaign-cohort-observability-report"
      : "paper:cohort-observability-report";
    const campaign = process.argv.includes("--require-campaign")
      ? " --campaign-plan /absolute/campaign.json"
      : " [--campaign-plan /absolute/campaign.json]";
    process.stdout.write(`Usage: npm run ${command} --${campaign} --input /absolute/report-dir [--input /absolute/report-dir] --output /absolute/new-observability-directory\n`);
    return;
  }
  const sources = inputs();
  const outputInput = argument("--output");
  const campaignPlanInput = argument("--campaign-plan");
  const requireCampaign = process.argv.includes("--require-campaign");
  if (sources.length === 0) throw new Error("paper:cohort-observability-report requires at least one --input");
  if (outputInput === undefined || !isAbsolute(outputInput)) {
    throw new Error("paper:cohort-observability-report requires an absolute --output directory");
  }
  const repository = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
  if (requireCampaign && campaignPlanInput === undefined) throw new Error("campaign observability requires --campaign-plan");
  const campaignPlan = campaignPlanInput === undefined ? undefined : await regularFile(campaignPlanInput, "campaign plan");
  const reportDirectories = await Promise.all(sources.map((source) => regularDirectory(source, "paper report input")));
  if ((campaignPlan !== undefined && inside(repository, campaignPlan)) || reportDirectories.some((directory) => inside(repository, directory))) {
    throw new Error("paper observability inputs must remain outside Git");
  }
  const outputDirectory = resolve(outputInput);
  if (inside(repository, outputDirectory)) throw new Error("paper observability output must remain outside Git");
  const parent = dirname(outputDirectory);
  if (await realpath(parent) !== parent) throw new Error("paper observability output parent must not contain symlinks");
  const filesystem = await statfs(parent);
  if (new Set([0x01021997, 0x5346544e, 0x65735546]).has(Number(filesystem.type))) {
    throw new Error("paper observability output requires a Linux-native filesystem");
  }
  const reportInputs = await Promise.all(
    reportDirectories.map((directory) => observabilityInput(directory, repository)),
  );
  const report = campaignPlan === undefined
    ? buildKJPaperCohortObservabilityReport(reportInputs)
    : buildKJPaperCampaignCohortObservabilityReport({
      campaignArtifact: (await json(campaignPlan, "campaign plan")).value,
      reports: reportInputs,
    });
  let reportHash: string;
  let runCount: string;
  if ("campaignCohort" in report) {
    reportHash = kjPaperCampaignCohortObservabilityReportHash(report);
    runCount = report.campaignCohort.cohort.runCount;
  } else {
    reportHash = kjPaperCohortObservabilityReportHash(report);
    runCount = report.pnlCohort.runCount;
  }
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  await syncDirectory(parent);
  await durableWrite(join(outputDirectory, "summary.json"), `${JSON.stringify({ report, reportHash }, null, 2)}\n`);
  writeSync(process.stdout.fd, `${JSON.stringify({
    accepted: true,
    evidenceStatus: report.evidenceStatus,
    profitabilityClaimEligible: report.profitabilityClaimEligible,
    runCount,
    reportHash,
    outputDirectory,
  })}\n`);
}

await main();
