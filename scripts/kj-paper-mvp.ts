import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, open, mkdir, readFile, realpath, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  planKJPaperMvp,
  KJ_PAPER_WARMUP_SECONDS,
  type KJPaperMvpPlan,
} from "../execution/src/product/kj-paper-mvp.js";
import {
  campaignBinding,
  campaignRun,
  parseKJPaperCampaignArtifact,
} from "../execution/src/product/kj-paper-campaign.js";
import { buildKJPaperMvpResult } from "../execution/src/product/kj-paper-mvp-result.js";
import { KJPaperJournal } from "../execution/src/storage/kj-paper-journal.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer`);
  return parsed;
}

function signalSource(value: string | undefined): "binance" | "chainlink" {
  if (value === undefined || value === "binance") return "binance";
  if (value === "chainlink") return "chainlink";
  throw new Error("--kj-signal-source must be binance or chainlink");
}

function git(repository: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr).trim()}`);
  }
  return result.stdout.trim();
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function durablePipe(
  stream: NodeJS.ReadableStream,
  handle: FileHandle,
): Promise<void> {
  for await (const chunk of stream) await handle.write(chunk as Buffer);
  await handle.sync();
}

function runId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14);
  return `kj-paper-${stamp}-${randomUUID().slice(0, 8)}`;
}

async function inspectResult(plan: KJPaperMvpPlan, exitCode: number | null, commit: string): Promise<unknown> {
  const summary = JSON.parse(await readFile(plan.summaryPath, "utf8")) as unknown;
  const journal = await KJPaperJournal.open(plan.journalPath);
  try {
    return buildKJPaperMvpResult({
      plan,
      resultKind: "INITIAL",
      resultPath: plan.resultPath,
      childExitedCleanly: exitCode === 0,
      collectorGitCommit: commit,
      runtimeSummary: summary,
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
}

async function campaignSelection(commit: string): Promise<{
  readonly binding: ReturnType<typeof campaignBinding>;
  readonly run: ReturnType<typeof campaignRun>;
} | undefined> {
  const path = argument("--campaign-plan");
  const index = argument("--campaign-run");
  if ((path === undefined) !== (index === undefined)) {
    throw new Error("--campaign-plan and --campaign-run must be supplied together");
  }
  if (path === undefined) return undefined;
  if (!resolve(path).startsWith("/")) throw new Error("--campaign-plan must be an absolute regular file");
  const info = await lstat(resolve(path));
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("--campaign-plan must be a regular non-symlink file");
  const artifact = parseKJPaperCampaignArtifact(JSON.parse(await readFile(resolve(path), "utf8")) as unknown);
  if (artifact.campaign.collectorGitCommit !== commit) {
    throw new Error("campaign collectorGitCommit differs from current committed code");
  }
  const campaignRunIndex = positiveInteger(index!, "campaign-run");
  return Object.freeze({
    binding: campaignBinding(artifact, campaignRunIndex),
    run: campaignRun(artifact, campaignRunIndex),
  });
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write([
      "Usage: npm run paper:mvp -- [--markets 1] [--settlement-grace-seconds 600]",
      "       [--output-root /root/polymarket-money-data/paper-mvp]",
      "       [--campaign-plan /absolute/campaign.json --campaign-run 1] [--kj-signal-source binance|chainlink]",
      "",
      "Runs 1-12 complete BTC five-minute markets with public data and paper-only K/J wallets.",
      "",
    ].join("\n"));
    return;
  }
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const actualRepository = git(repository, ["rev-parse", "--show-toplevel"]);
  const trackedChanges = git(actualRepository, ["status", "--porcelain", "--untracked-files=no"]);
  if (trackedChanges !== "") {
    throw new Error("paper:mvp refuses uncommitted tracked code; commit the exact runtime before collecting evidence");
  }
  const commit = git(actualRepository, ["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new Error("committed collector object ID is invalid");

  const now = new Date();
  const selectedSignalSource = signalSource(argument("--kj-signal-source"));
  const selectedCampaign = await campaignSelection(commit);
  const plan = planKJPaperMvp({
    nowMilliseconds: now.getTime(),
    marketCount: positiveInteger(argument("--markets") ?? String(selectedCampaign?.run.targetMarketCount ?? 1), "markets"),
    settlementGraceSeconds: positiveInteger(
      argument("--settlement-grace-seconds") ?? String(selectedCampaign?.run.settlementGraceSeconds ?? 600),
      "settlement-grace-seconds",
    ),
    outputRoot: resolve(argument("--output-root") ?? "/root/polymarket-money-data/paper-mvp"),
    repositoryRoot: actualRepository,
    runId: selectedCampaign?.run.runId ?? runId(now),
    ...(selectedCampaign === undefined ? {} : {
      campaign: selectedCampaign.binding,
      campaignRun: selectedCampaign.run,
    }),
  });

  await mkdir(dirname(plan.runDirectory), { recursive: true, mode: 0o700 });
  if (await realpath(dirname(plan.runDirectory)) !== dirname(plan.runDirectory)) {
    throw new Error("MVP output root must not contain symlinks");
  }
  await mkdir(plan.runDirectory, { recursive: false, mode: 0o700 });
  await mkdir(plan.metricsDirectory, { recursive: false, mode: 0o700 });
  await writeFile(
    resolve(plan.runDirectory, "run-plan.json"),
    `${JSON.stringify({ ...plan, collectorGitCommit: commit }, null, 2)}\n`,
    { flag: "wx", mode: 0o400 },
  );
  const plannedJournal = await KJPaperJournal.open(plan.journalPath);
  try {
    await plannedJournal.appendRunPlan(plan.warmupSeconds !== undefined ? {
      schemaVersion: "kj-paper-run-plan-v3",
      runId: plan.runId,
      targetMarketCount: plan.targetMarketCount,
      firstFullMarketStart: plan.firstFullMarketStart,
      captureEnd: plan.captureEnd,
      collectorGitCommit: commit,
      warmupSeconds: plan.warmupSeconds,
      ...(plan.campaign === undefined ? {} : { campaign: plan.campaign }),
    } : plan.campaign === undefined ? {
      schemaVersion: "kj-paper-run-plan-v1",
      runId: plan.runId,
      targetMarketCount: plan.targetMarketCount,
      firstFullMarketStart: plan.firstFullMarketStart,
      captureEnd: plan.captureEnd,
      collectorGitCommit: commit,
    } : {
      schemaVersion: "kj-paper-run-plan-v2",
      runId: plan.runId,
      targetMarketCount: plan.targetMarketCount,
      firstFullMarketStart: plan.firstFullMarketStart,
      captureEnd: plan.captureEnd,
      collectorGitCommit: commit,
      ...plan.campaign,
    });
  } finally {
    await plannedJournal.close();
  }
  const stdoutHandle = await open(plan.runtimeStdoutPath, "wx", 0o600);
  const stderrHandle = await open(plan.runtimeStderrPath, "wx", 0o600);
  const runtime = fileURLToPath(new URL("./live-runtime.js", import.meta.url));
  const child = spawn(process.execPath, [
    "--use-env-proxy",
    runtime,
    "paper",
    "--duration-seconds", String(plan.durationSeconds),
    "--record", "metrics",
    "--output", plan.metricsDirectory,
    "--summary", plan.summaryPath,
    "--kj-paper-journal", plan.journalPath,
    "--settlement-grace-seconds", String(plan.settlementGraceSeconds),
    "--kj-market-start-at", plan.firstFullMarketStart,
    "--kj-warmup-until", plan.firstFullMarketStart,
    "--kj-market-start-before", plan.captureEnd,
    "--git-commit", commit,
    "--kj-signal-source", selectedSignalSource,
    "--json",
  ], { cwd: actualRepository, stdio: ["ignore", "pipe", "pipe"] });

  const forward = (signal: NodeJS.Signals): void => { child.kill(signal); };
  process.once("SIGINT", forward);
  process.once("SIGTERM", forward);
  process.stdout.write(`[MVP] run=${plan.runId} markets=${plan.targetMarketCount}\n`);
  process.stdout.write(`[MVP] warmup=${KJ_PAPER_WARMUP_SECONDS}s full-market-start=${plan.firstFullMarketStart} expected-finish=${plan.expectedFinishBy}\n`);
  process.stdout.write(`[MVP] artifacts=${plan.runDirectory}\n`);
  const heartbeat = setInterval(() => {
    process.stdout.write(`[MVP] running ${new Date().toISOString()}\n`);
  }, 30_000);
  heartbeat.unref();

  const stdoutPipe = durablePipe(child.stdout, stdoutHandle);
  const stderrPipe = durablePipe(child.stderr, stderrHandle);
  const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", resolveExit);
  });
  clearInterval(heartbeat);
  await Promise.all([stdoutPipe, stderrPipe]);
  await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
  process.removeListener("SIGINT", forward);
  process.removeListener("SIGTERM", forward);

  const result = await inspectResult(plan, exitCode, commit);
  await writeFile(plan.resultPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o400 });
  const accepted = object(result)?.accepted === true;
  process.stdout.write(`[MVP] accepted=${String(accepted)} result=${plan.resultPath}\n`);
  if (!accepted) process.exitCode = 2;
}

await main();
