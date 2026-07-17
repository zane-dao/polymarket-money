import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { buildKJPaperMvpResult } from "../execution/src/product/kj-paper-mvp-result.js";
import type { KJPaperMvpPlan } from "../execution/src/product/kj-paper-mvp.js";
import { KJPaperJournal } from "../execution/src/storage/kj-paper-journal.js";

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

function plan(value: unknown, runDirectory: string): {
  readonly value: KJPaperMvpPlan;
  readonly collectorGitCommit: string;
} {
  const candidate = object(value, "run plan");
  if (candidate.schemaVersion !== "kj-paper-mvp-v1") throw new Error("run plan schema is unsupported");
  if (candidate.runDirectory !== runDirectory
    || candidate.journalPath !== join(runDirectory, "kj-inputs.ndjson")
    || candidate.summaryPath !== join(runDirectory, "runtime-summary.json")
    || candidate.resultPath !== join(runDirectory, "result.json")) {
    throw new Error("run plan artifact paths conflict with the selected run directory");
  }
  const targetMarketCount = candidate.targetMarketCount;
  const durationSeconds = candidate.durationSeconds;
  const settlementGraceSeconds = candidate.settlementGraceSeconds;
  if (!Number.isSafeInteger(targetMarketCount) || (targetMarketCount as number) <= 0
    || !Number.isSafeInteger(durationSeconds) || (durationSeconds as number) <= 0
    || !Number.isSafeInteger(settlementGraceSeconds) || (settlementGraceSeconds as number) <= 0) {
    throw new Error("run plan numeric fields are invalid");
  }
  const collectorGitCommit = text(candidate.collectorGitCommit, "collectorGitCommit");
  if (!/^[0-9a-f]{40,64}$/u.test(collectorGitCommit)) throw new Error("collectorGitCommit is invalid");
  return {
    value: candidate as unknown as KJPaperMvpPlan,
    collectorGitCommit,
  };
}

async function json(path: string, field: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`${field} is missing or invalid JSON`, { cause: error });
  }
}

async function optionalJson(path: string, field: string): Promise<unknown | null> {
  try {
    return await json(path, field);
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause !== null && typeof cause === "object" && "code" in cause
      && (cause as { code?: unknown }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function proveCleanRuntimeCompletion(
  value: unknown,
  expected: { readonly plan: KJPaperMvpPlan; readonly collectorGitCommit: string },
): void {
  const summary = object(value, "runtime summary");
  const safety = object(summary.safety, "runtime summary safety");
  if (summary.type !== "runtime_summary"
    || summary.mode !== "paper"
    || summary.collectorGitCommit !== expected.collectorGitCommit
    || summary.kjMarketStartBefore !== expected.plan.captureEnd
    || summary.kjPaperJournalPath !== expected.plan.journalPath
    || summary.stoppedByDuration !== true
    || summary.terminalFailure !== null
    || summary.realOrderCount !== 0
    || safety.liveClientConstructed !== false
    || safety.userChannelConnected !== false
    || safety.credentialsRead !== false
    || safety.ordersSent !== 0) {
    throw new Error("runtime summary does not prove a clean paper-only child completion");
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write("Usage: npm run paper:finalize -- /absolute/mvp-run-directory\n");
    return;
  }
  const input = process.argv[2];
  if (input === undefined || process.argv.length !== 3 || !isAbsolute(input)) {
    throw new Error("paper:finalize requires exactly one absolute MVP run directory");
  }
  const runDirectory = resolve(input);
  const info = await lstat(runDirectory);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(runDirectory) !== runDirectory) {
    throw new Error("MVP run directory must be a real non-symlink directory");
  }
  const parsedPlan = plan(await json(join(runDirectory, "run-plan.json"), "run plan"), runDirectory);
  const originalResultValue = await optionalJson(join(runDirectory, "result.json"), "original result");
  if (originalResultValue !== null) {
    const originalResult = object(originalResultValue, "original result");
    const originalChecks = object(originalResult.checks, "original result checks");
    if (originalResult.runId !== parsedPlan.value.runId
      || originalResult.collectorGitCommit !== parsedPlan.collectorGitCommit
      || originalChecks.childExitedCleanly !== true) {
      throw new Error("original result does not prove a clean child exit for this run");
    }
    if (originalResult.accepted === true) throw new Error("accepted runs do not require finalization");
  }
  const runtimeSummary = await json(join(runDirectory, "runtime-summary.json"), "runtime summary");
  proveCleanRuntimeCompletion(runtimeSummary, {
    plan: parsedPlan.value,
    collectorGitCommit: parsedPlan.collectorGitCommit,
  });
  const finalResultPath = join(runDirectory, "final-result.json");
  const journal = await KJPaperJournal.open(parsedPlan.value.journalPath);
  let finalResult;
  try {
    finalResult = buildKJPaperMvpResult({
      plan: parsedPlan.value,
      resultKind: "RECOVERED_FINAL",
      resultPath: finalResultPath,
      childExitedCleanly: true,
      collectorGitCommit: parsedPlan.collectorGitCommit,
      runtimeSummary,
      journalPath: journal.path,
      journalRecordCount: journal.recordCount,
      journalLastRecordHash: journal.lastRecordHash,
      journalRunPlan: journal.runPlanEvidence,
      unsettledMarkets: journal.unsettledMarkets(),
      snapshot: journal.engine.snapshot(),
    });
  } finally {
    await journal.close();
  }
  const resultObject = object(finalResult, "final result");
  if (resultObject.accepted !== true) {
    process.stdout.write(`${JSON.stringify(finalResult)}\n`);
    process.exitCode = 2;
    return;
  }
  const handle = await open(
    finalResultPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o400,
  );
  try {
    await handle.writeFile(`${JSON.stringify(finalResult, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directoryHandle = await open(runDirectory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
  process.stdout.write(`${JSON.stringify({
    accepted: true,
    resultKind: "RECOVERED_FINAL",
    resultPath: finalResultPath,
    journalRecordCount: resultObject.journalRecordCount,
    journalLastRecordHash: resultObject.journalLastRecordHash,
  })}\n`);
}

await main();
