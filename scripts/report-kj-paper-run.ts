import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  statfs,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildKJPaperReport,
  kjPaperReportArtifactHash,
  kjPaperReportCsv,
} from "../execution/src/product/kj-paper-report.js";
import { KJPaperJournal } from "../execution/src/storage/kj-paper-journal.js";

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

function inside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (
    child !== ".."
    && !child.startsWith("../")
    && !child.startsWith("..\\")
    && !isAbsolute(child)
  );
}

async function readJson(path: string, field: string): Promise<{ readonly raw: string; readonly value: unknown }> {
  const raw = await readFile(path, "utf8");
  try {
    return { raw, value: JSON.parse(raw) as unknown };
  } catch (error) {
    throw new Error(`${field} is invalid JSON`, { cause: error });
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function notFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
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
  } finally {
    await handle?.close();
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write([
      "Usage: npm run paper:report -- /absolute/mvp-run-directory",
      "       --output /absolute/new-report-directory",
      "",
    ].join("\n"));
    return;
  }
  const runInput = process.argv[2];
  const outputInput = argument("--output");
  if (runInput === undefined || !isAbsolute(runInput)) {
    throw new Error("paper:report requires an absolute MVP run directory");
  }
  if (outputInput === undefined || !isAbsolute(outputInput)) {
    throw new Error("paper:report requires an absolute --output directory");
  }
  const runDirectory = resolve(runInput);
  const outputDirectory = resolve(outputInput);
  const runInfo = await lstat(runDirectory);
  if (!runInfo.isDirectory() || runInfo.isSymbolicLink() || await realpath(runDirectory) !== runDirectory) {
    throw new Error("MVP run directory must be a real non-symlink directory");
  }
  const repository = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
  if (inside(repository, outputDirectory)) throw new Error("paper report output must remain outside Git");
  const outputParent = dirname(outputDirectory);
  if (await realpath(outputParent) !== outputParent) {
    throw new Error("paper report output parent must not contain symlinks");
  }
  const filesystem = await statfs(outputParent);
  if (new Set([0x01021997, 0x5346544e, 0x65735546]).has(Number(filesystem.type))) {
    throw new Error("paper report output requires a Linux-native filesystem");
  }

  const planEvidence = await readJson(join(runDirectory, "run-plan.json"), "run plan");
  let resultFileName: "result.json" | "final-result.json" = "result.json";
  try {
    const finalInfo = await lstat(join(runDirectory, "final-result.json"));
    if (!finalInfo.isFile() || finalInfo.isSymbolicLink()) {
      throw new Error("final-result.json must be a regular non-symlink file");
    }
    resultFileName = "final-result.json";
  } catch (error) {
    if (!notFound(error)) throw error;
  }
  const resultEvidence = await readJson(join(runDirectory, resultFileName), "MVP result");
  const runtimeEvidence = await readJson(join(runDirectory, "runtime-summary.json"), "runtime summary");
  const runPlan = object(planEvidence.value, "run plan");
  const journalPath = text(runPlan.journalPath, "run plan journalPath");
  if (runPlan.runDirectory !== runDirectory
    || journalPath !== join(runDirectory, "kj-inputs.ndjson")
    || runPlan.resultPath !== join(runDirectory, "result.json")
    || runPlan.summaryPath !== join(runDirectory, "runtime-summary.json")) {
    throw new Error("run plan artifact paths do not match the selected run directory");
  }

  const journal = await KJPaperJournal.open(journalPath);
  let report;
  try {
    report = buildKJPaperReport({
      plan: planEvidence.value,
      result: resultEvidence.value,
      runtimeSummary: runtimeEvidence.value,
      journalPath: journal.path,
      journalRecordCount: journal.recordCount,
      journalLastRecordHash: journal.lastRecordHash,
      journalRunPlan: journal.runPlanEvidence,
      unsettledMarketIds: journal.unsettledMarkets().map((market) => market.marketId),
      snapshot: journal.engine.snapshot(),
      events: journal.engine.events(),
    });
  } finally {
    await journal.close();
  }
  const csv = kjPaperReportCsv(report);
  const artifactCore = Object.freeze({
    schemaVersion: "kj-paper-report-artifact-v1" as const,
    report,
    sourceFileSha256: Object.freeze({
      runPlan: sha256(planEvidence.raw),
      result: sha256(resultEvidence.raw),
      runtimeSummary: sha256(runtimeEvidence.raw),
    }),
    resultFileName,
    marketsCsvSha256: sha256(csv),
  });
  const artifactHash = kjPaperReportArtifactHash(artifactCore);
  const summary = Object.freeze({ ...artifactCore, artifactHash });

  await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  await syncDirectory(outputParent);
  await durableWrite(join(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await durableWrite(join(outputDirectory, "markets.csv"), csv);
  process.stdout.write(`${JSON.stringify({
    accepted: true,
    evidenceStatus: report.evidenceStatus,
    planBinding: report.planBinding,
    artifactHash,
    outputDirectory,
    targetMarketCount: report.run.targetMarketCount,
    strategies: report.strategies,
  })}\n`);
}

await main();
