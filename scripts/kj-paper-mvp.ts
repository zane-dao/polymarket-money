import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, realpath, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Money } from "../execution/src/domain/money.js";
import {
  KJ_PAPER_MVP_VERSION,
  planKJPaperMvp,
  type KJPaperMvpPlan,
} from "../execution/src/product/kj-paper-mvp.js";
import { DEFAULT_KJ_PAPER_ENGINE_CONFIG } from "../execution/src/runtime/kj-paper-engine.js";
import { KJPaperJournal } from "../execution/src/storage/kj-paper-journal.js";

interface RuntimeSummary {
  readonly runId?: unknown;
  readonly terminalFailure?: unknown;
  readonly realOrderCount?: unknown;
  readonly kjSettledMarketCount?: unknown;
  readonly safety?: unknown;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInteger(value: string, field: string): number {
  const parsed = Number(value);
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
  const summary = JSON.parse(await readFile(plan.summaryPath, "utf8")) as RuntimeSummary;
  const journal = await KJPaperJournal.open(plan.journalPath);
  try {
    const state = journal.engine.snapshot();
    const completedMarkets = state.markets.filter((market) => market.state === "DONE").length;
    const unsettledMarkets = journal.unsettledMarkets().map((market) => market.marketId);
    const safety = object(summary.safety);
    const checks = Object.freeze({
      childExitedCleanly: exitCode === 0,
      noTerminalFailure: summary.terminalFailure === null,
      noRealOrders: summary.realOrderCount === 0
        && safety?.ordersSent === 0
        && safety.liveClientConstructed === false
        && safety.userChannelConnected === false
        && safety.credentialsRead === false,
      targetMarketsSettled: completedMarkets >= plan.targetMarketCount
        && summary.kjSettledMarketCount === completedMarkets,
      noPendingMarkets: unsettledMarkets.length === 0 && state.pendingIntents.length === 0,
      durableInputsPresent: journal.recordCount > 1 && journal.lastRecordHash !== null,
    });
    const accepted = Object.values(checks).every(Boolean);
    const cash = state.wallets;
    return Object.freeze({
      schemaVersion: KJ_PAPER_MVP_VERSION,
      accepted,
      checks,
      runId: plan.runId,
      runtimeRunId: typeof summary.runId === "string" ? summary.runId : null,
      collectorGitCommit: commit,
      targetMarketCount: plan.targetMarketCount,
      completedMarketCount: completedMarkets,
      journalRecordCount: journal.recordCount,
      journalLastRecordHash: journal.lastRecordHash,
      unsettledMarketIds: unsettledMarkets,
      strategies: {
        J_FEE_AWARE: {
          finalCash: cash.J_FEE_AWARE.cash,
          netPnl: Money.from(cash.J_FEE_AWARE.cash)
            .minus(Money.from(DEFAULT_KJ_PAPER_ENGINE_CONFIG.initialCash)).toCanonical(),
        },
        K_DUAL_VOL: {
          finalCash: cash.K_DUAL_VOL.cash,
          netPnl: Money.from(cash.K_DUAL_VOL.cash)
            .minus(Money.from(DEFAULT_KJ_PAPER_ENGINE_CONFIG.initialCash)).toCanonical(),
        },
      },
      engineState: state,
      artifacts: {
        runDirectory: plan.runDirectory,
        journal: plan.journalPath,
        summary: plan.summaryPath,
        runtimeLog: plan.runtimeStdoutPath,
        runtimeErrorLog: plan.runtimeStderrPath,
      },
    });
  } finally {
    await journal.close();
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write([
      "Usage: npm run paper:mvp -- [--markets 1] [--settlement-grace-seconds 90]",
      "       [--output-root /root/polymarket-money-data/paper-mvp]",
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
  const plan = planKJPaperMvp({
    nowMilliseconds: now.getTime(),
    marketCount: positiveInteger(argument("--markets") ?? "1", "markets"),
    settlementGraceSeconds: positiveInteger(
      argument("--settlement-grace-seconds") ?? "90",
      "settlement-grace-seconds",
    ),
    outputRoot: resolve(argument("--output-root") ?? "/root/polymarket-money-data/paper-mvp"),
    repositoryRoot: actualRepository,
    runId: runId(now),
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
    "--git-commit", commit,
    "--json",
  ], { cwd: actualRepository, stdio: ["ignore", "pipe", "pipe"] });

  const forward = (signal: NodeJS.Signals): void => { child.kill(signal); };
  process.once("SIGINT", forward);
  process.once("SIGTERM", forward);
  process.stdout.write(`[MVP] run=${plan.runId} markets=${plan.targetMarketCount}\n`);
  process.stdout.write(`[MVP] full-market-start=${plan.firstFullMarketStart} expected-finish=${plan.expectedFinishBy}\n`);
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
