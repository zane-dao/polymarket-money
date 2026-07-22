import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/u;

export type BacktestRequestV1 = Readonly<{
  schemaVersion: "backtest-request-v1";
  requestId: string;
  /** Backend-owned presentation metadata; absent only on legacy persisted requests. */
  displayName?: string;
  description?: string;
  strategyId: string;
  strategyVersion: string;
  datasetId: string;
  datasetVersionHash: string;
  feeModel: string;
  latencyMs: number;
  initialCash: string;
  maxPosition: string;
  evaluationSplit?: "VALIDATION" | "FINAL_TEST";
}>;

export type BacktestEventV1 = Readonly<{
  eventId: string;
  eventTimeUtc: string;
  kind: "decision" | "order" | "fill" | "settlement" | "incident";
  payload: Readonly<Record<string, string | number | boolean | null>>;
}>;

export type BacktestEvaluationScopeV1 = Readonly<{
  schemaVersion: "backtest-evaluation-scope-v1";
  split: "TRAIN" | "VALIDATION" | "FINAL_TEST";
  horizonSeconds: number;
  scenario: "BASE_1S" | "STRESS_1S_PLUS_TICK";
  cohortHash: string;
  cohortSize: number;
}>;

export type BacktestResultV1 = Readonly<{
  schemaVersion: "backtest-result-v1";
  runId: string;
  request: BacktestRequestV1;
  startedAtUtc: string;
  completedAtUtc: string;
  /** Absent only on legacy results; such results must fail closed for comparison. */
  evaluationScope?: BacktestEvaluationScopeV1;
  metrics: Readonly<{
    netPnl: string;
    fees: string;
    maxDrawdown: string;
    fillRate: string;
    winRate: string | null;
    brier: string | null;
  }>;
  equityCurve: readonly Readonly<{ timeUtc: string; equity: string }>[];
  events: readonly BacktestEventV1[];
}>;

export type BacktestJobV1 = Readonly<{
  schemaVersion: "backtest-job-v1";
  runId: string;
  requestId: string;
  displayName?: string;
  status: "queued" | "running" | "stopping" | "succeeded" | "failed" | "cancelled";
  progressPermille: number;
  error: string | null;
}>;

export interface BacktestRunner {
  run(input: BacktestRequestV1, context: Readonly<{ runId: string; signal: AbortSignal; reportProgress(value: number): void }>): Promise<BacktestResultV1>;
}

function validateRequest(input: BacktestRequestV1): void {
  if (input.schemaVersion !== "backtest-request-v1") throw new Error("unsupported backtest request");
  for (const [field, value] of [["requestId", input.requestId], ["strategyId", input.strategyId], ["datasetId", input.datasetId]] as const) {
    if (!SAFE_ID.test(value)) throw new Error(`${field} is invalid`);
  }
  if (!/^[0-9a-f]{64}$/u.test(input.datasetVersionHash)) throw new Error("datasetVersionHash is invalid");
  if (!Number.isSafeInteger(input.latencyMs) || input.latencyMs < 0 || input.latencyMs > 60_000) throw new Error("latencyMs is invalid");
  for (const [field, value] of [["initialCash", input.initialCash], ["maxPosition", input.maxPosition]] as const) {
    if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) throw new Error(`${field} must be a canonical non-negative decimal`);
  }
  if (input.feeModel.trim() === "" || input.strategyVersion.trim() === "") throw new Error("feeModel and strategyVersion are required");
  if (input.evaluationSplit !== undefined && input.evaluationSplit !== "VALIDATION" && input.evaluationSplit !== "FINAL_TEST") throw new Error("evaluationSplit is invalid");
  for (const [field, value] of [["displayName", input.displayName], ["description", input.description]] as const) {
    if (value !== undefined && (value.trim() === "" || value.length > 240 || /[\u0000-\u001f]/u.test(value))) throw new Error(`${field} is invalid`);
  }
}

export class FileBacktestResultStore {
  readonly #root: string;
  constructor(dataRoot: string) {
    if (!isAbsolute(dataRoot)) throw new Error("dataRoot must be absolute");
    this.#root = resolve(dataRoot, "workbench", "backtest-results");
  }
  async save(result: BacktestResultV1): Promise<void> {
    if (!SAFE_ID.test(result.runId) || result.schemaVersion !== "backtest-result-v1") throw new Error("invalid backtest result");
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const bytes = `${JSON.stringify(result, null, 2)}\n`;
    await writeFile(join(this.#root, `${result.runId}.json`), bytes, { flag: "wx", mode: 0o600 });
    await writeFile(join(this.#root, `${result.runId}.sha256`), `${createHash("sha256").update(bytes).digest("hex")}\n`, { flag: "wx", mode: 0o600 });
  }
  async load(runId: string): Promise<BacktestResultV1> {
    if (!SAFE_ID.test(runId)) throw new Error("runId is invalid");
    const bytes = await readFile(join(this.#root, `${runId}.json`), "utf8");
    const expected = (await readFile(join(this.#root, `${runId}.sha256`), "utf8")).trim();
    if (!/^[0-9a-f]{64}$/u.test(expected) || createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("backtest result integrity check failed");
    const value: unknown = JSON.parse(bytes);
    if (typeof value !== "object" || value === null || Array.isArray(value) || (value as BacktestResultV1).schemaVersion !== "backtest-result-v1" || (value as BacktestResultV1).runId !== runId) {
      throw new Error("invalid persisted backtest result");
    }
    return value as BacktestResultV1;
  }

  async delete(runId: string): Promise<void> {
    if (!SAFE_ID.test(runId)) throw new Error("runId is invalid");
    await this.load(runId);
    await unlink(join(this.#root, `${runId}.json`));
    await unlink(join(this.#root, `${runId}.sha256`));
  }
}

export class BacktestJobService {
  readonly #runner: BacktestRunner;
  readonly #store: FileBacktestResultStore;
  readonly #jobs = new Map<string, { view: BacktestJobV1; controller: AbortController }>();
  readonly #requests = new Map<string, string>();
  #ordinal = 0;

  constructor(runner: BacktestRunner, store: FileBacktestResultStore) { this.#runner = runner; this.#store = store; }

  start(input: BacktestRequestV1): BacktestJobV1 {
    validateRequest(input);
    const existing = this.#requests.get(input.requestId);
    if (existing !== undefined) return this.get(existing);
    const runId = `bt-${Date.now()}-${++this.#ordinal}`;
    const controller = new AbortController();
    const state = { view: Object.freeze({ schemaVersion: "backtest-job-v1" as const, runId, requestId: input.requestId, ...(input.displayName === undefined ? {} : { displayName: input.displayName }), status: "queued" as const, progressPermille: 0, error: null }), controller };
    this.#jobs.set(runId, state); this.#requests.set(input.requestId, runId);
    queueMicrotask(() => void this.#execute(input, state));
    return state.view;
  }

  get(runId: string): BacktestJobV1 {
    const job = this.#jobs.get(runId); if (job === undefined) throw new Error(`unknown backtest run: ${runId}`); return job.view;
  }

  list(): readonly BacktestJobV1[] { return Object.freeze([...this.#jobs.values()].map((item) => item.view)); }

  stop(runId: string): BacktestJobV1 {
    const state = this.#jobs.get(runId); if (state === undefined) throw new Error(`unknown backtest run: ${runId}`);
    if (state.view.status === "queued" || state.view.status === "running") {
      state.view = Object.freeze({ ...state.view, status: "stopping" }); state.controller.abort();
    }
    return state.view;
  }

  async result(runId: string): Promise<BacktestResultV1> { return this.#store.load(runId); }

  async #execute(input: BacktestRequestV1, state: { view: BacktestJobV1; controller: AbortController }): Promise<void> {
    state.view = Object.freeze({ ...state.view, status: "running" });
    try {
      const result = await this.#runner.run(input, { runId: state.view.runId, signal: state.controller.signal, reportProgress: (value) => {
        if (!Number.isFinite(value)) return;
        state.view = Object.freeze({ ...state.view, progressPermille: Math.max(state.view.progressPermille, Math.min(999, Math.round(value))) });
      }});
      if (state.controller.signal.aborted) { state.view = Object.freeze({ ...state.view, status: "cancelled" }); return; }
      if (result.runId !== state.view.runId || result.request.requestId !== input.requestId) throw new Error("runner returned a mismatched result");
      await this.#store.save(result);
      state.view = Object.freeze({ ...state.view, status: "succeeded", progressPermille: 1000 });
    } catch (error: unknown) {
      state.view = state.controller.signal.aborted
        ? Object.freeze({ ...state.view, status: "cancelled" })
        : Object.freeze({ ...state.view, status: "failed", error: error instanceof Error ? error.message : "backtest failed" });
    }
  }
}
