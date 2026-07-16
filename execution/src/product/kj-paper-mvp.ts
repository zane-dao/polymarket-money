import { isAbsolute, join, relative, resolve } from "node:path";

export const KJ_PAPER_MVP_VERSION = "kj-paper-mvp-v1" as const;
export const KJ_MARKET_INTERVAL_MILLISECONDS = 300_000;

export interface KJPaperMvpPlanInput {
  readonly nowMilliseconds: number;
  readonly marketCount: number;
  readonly settlementGraceSeconds: number;
  readonly outputRoot: string;
  readonly repositoryRoot: string;
  readonly runId: string;
}

export interface KJPaperMvpPlan {
  readonly schemaVersion: typeof KJ_PAPER_MVP_VERSION;
  readonly runId: string;
  readonly targetMarketCount: number;
  readonly plannedAt: string;
  readonly firstFullMarketStart: string;
  readonly captureEnd: string;
  readonly expectedFinishBy: string;
  readonly durationSeconds: number;
  readonly settlementGraceSeconds: number;
  readonly runDirectory: string;
  readonly metricsDirectory: string;
  readonly journalPath: string;
  readonly summaryPath: string;
  readonly runtimeStdoutPath: string;
  readonly runtimeStderrPath: string;
  readonly resultPath: string;
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

function safeInteger(value: number, field: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${field} must be an integer from 1 through ${maximum}`);
  }
}

export function planKJPaperMvp(input: KJPaperMvpPlanInput): KJPaperMvpPlan {
  if (!Number.isSafeInteger(input.nowMilliseconds) || input.nowMilliseconds < 0) {
    throw new Error("nowMilliseconds must be a non-negative safe integer");
  }
  safeInteger(input.marketCount, "marketCount", 12);
  safeInteger(input.settlementGraceSeconds, "settlementGraceSeconds", 1_800);
  if (!isAbsolute(input.outputRoot)) throw new Error("MVP output root must be absolute");
  if (!isAbsolute(input.repositoryRoot)) throw new Error("repository root must be absolute");
  if (!/^[a-z0-9][a-z0-9-]{7,79}$/u.test(input.runId)) {
    throw new Error("runId contains unsupported characters");
  }

  const outputRoot = resolve(input.outputRoot);
  const repositoryRoot = resolve(input.repositoryRoot);
  if (inside(repositoryRoot, outputRoot)) {
    throw new Error("MVP artifacts must remain outside the Git repository");
  }

  // Always choose the next boundary. This gives the engine time to observe the
  // opening anchor instead of inventing one for a market already in progress.
  const firstFullMarketStart = (
    Math.floor(input.nowMilliseconds / KJ_MARKET_INTERVAL_MILLISECONDS) + 1
  ) * KJ_MARKET_INTERVAL_MILLISECONDS;
  const captureEnd = firstFullMarketStart
    + input.marketCount * KJ_MARKET_INTERVAL_MILLISECONDS;
  const durationSeconds = Math.ceil((captureEnd - input.nowMilliseconds) / 1_000);
  const runDirectory = join(outputRoot, input.runId);

  return Object.freeze({
    schemaVersion: KJ_PAPER_MVP_VERSION,
    runId: input.runId,
    targetMarketCount: input.marketCount,
    plannedAt: new Date(input.nowMilliseconds).toISOString(),
    firstFullMarketStart: new Date(firstFullMarketStart).toISOString(),
    captureEnd: new Date(captureEnd).toISOString(),
    expectedFinishBy: new Date(captureEnd + input.settlementGraceSeconds * 1_000).toISOString(),
    durationSeconds,
    settlementGraceSeconds: input.settlementGraceSeconds,
    runDirectory,
    metricsDirectory: join(runDirectory, "metrics"),
    journalPath: join(runDirectory, "kj-inputs.ndjson"),
    summaryPath: join(runDirectory, "runtime-summary.json"),
    runtimeStdoutPath: join(runDirectory, "runtime.ndjson"),
    runtimeStderrPath: join(runDirectory, "runtime.stderr.log"),
    resultPath: join(runDirectory, "result.json"),
  });
}
