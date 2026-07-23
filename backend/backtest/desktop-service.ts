import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatasetApplicationService } from "../dataset-api/index.js";
import { createDefaultStrategyCatalog, FileStrategyVersionStore } from "../strategy-management/index.js";
import { FileBacktestResultStore, type BacktestJobV1, type BacktestRequestV1, type BacktestResultV1 } from "./jobs.js";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/u;
type PersistedJob = Readonly<{ schemaVersion: "desktop-backtest-job-v1"; job: BacktestJobV1; request: BacktestRequestV1; workerPid: number | null }>;

function publicJob(value: PersistedJob): BacktestJobV1 { return Object.freeze({ ...value.job, strategyId: value.request.strategyId, strategyVersion: value.request.strategyVersion, ...(value.request.comparisonGroupId === undefined ? {} : { comparisonGroupId: value.request.comparisonGroupId }) }); }

export class DesktopBacktestService {
  readonly #dataRoot: string; readonly #root: string; readonly #repo: string;
  constructor(dataRoot: string, repositoryRoot = process.cwd()) { if (!isAbsolute(dataRoot) || !isAbsolute(repositoryRoot)) throw new Error("desktop backtest roots must be absolute"); this.#dataRoot = resolve(dataRoot); this.#root = resolve(dataRoot, "workbench", "backtest-jobs"); this.#repo = resolve(repositoryRoot); }
  async start(request: BacktestRequestV1): Promise<BacktestJobV1> {
    const wantsBaselines = request.includeBaselines ?? !/^B[0-3]_/u.test(request.strategyId);
    const groupId = wantsBaselines ? request.comparisonGroupId ?? request.requestId : request.comparisonGroupId;
    const normalized = this.#withPresentation({ ...request, ...(groupId === undefined ? {} : { comparisonGroupId: groupId }) });
    await this.#validate(normalized);
    const baselines = wantsBaselines ? this.#baselineRequests(normalized) : [];
    for (const baseline of baselines) await this.#validate(baseline);
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    for (const value of await this.#all()) if (value.request.requestId === normalized.requestId) return publicJob(value);
    const runId = `bt-${Date.now()}-${randomUUID().slice(0, 8)}`; const directory = join(this.#root, runId); await mkdir(directory, { mode: 0o700 });
    const job: BacktestJobV1 = Object.freeze({ schemaVersion: "backtest-job-v1", runId, requestId: normalized.requestId, ...(normalized.displayName === undefined ? {} : { displayName: normalized.displayName }), strategyId: normalized.strategyId, strategyVersion: normalized.strategyVersion, status: "queued", progressPermille: 0, error: null });
    await this.#write(runId, { schemaVersion: "desktop-backtest-job-v1", job, request: normalized, workerPid: null });
    const worker = resolve(this.#repo, "dist", "scripts", "workbench-backtest-worker.js"); if (!existsSync(worker)) { await this.#update(runId, { ...job, status: "failed", error: "backtest worker is unavailable; run npm run build" }, null); return this.get(runId); }
    const child = spawn("/usr/local/bin/node", [worker, runId], { cwd: this.#repo, detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin", POLYMARKET_DATA_ROOT: this.#dataRoot } });
    if (child.pid === undefined) { await this.#update(runId, { ...job, status: "failed", error: "failed to start backtest worker" }, null); return this.get(runId); }
    await this.#update(runId, job, child.pid); child.unref();
    for (const baseline of baselines) await this.start(baseline);
    return this.get(runId);
  }
  async get(runId: string): Promise<BacktestJobV1> { return publicJob(await this.#read(runId)); }
  async list(): Promise<readonly BacktestJobV1[]> { return Object.freeze((await this.#all()).map(publicJob).sort((a, b) => b.runId.localeCompare(a.runId))); }
  async stop(runId: string): Promise<BacktestJobV1> { const value = await this.#read(runId); if ((value.job.status === "queued" || value.job.status === "running") && value.workerPid !== null) { try { process.kill(value.workerPid, "SIGTERM"); } catch { /* Worker may have completed between read and signal. */ } await this.#update(runId, { ...value.job, status: "stopping" }, value.workerPid); } return this.get(runId); }
  result(runId: string): Promise<BacktestResultV1> { return new FileBacktestResultStore(this.#dataRoot).load(runId); }
  async usesStrategyVersion(strategyId: string, version: string): Promise<boolean> { return (await this.#all()).some((value) => value.request.strategyId === strategyId && value.request.strategyVersion === version); }
  async usesDataset(datasetId: string, versionHash: string): Promise<boolean> { return (await this.#all()).some((value) => value.request.datasetId === datasetId && value.request.datasetVersionHash === versionHash); }
  async delete(runId: string, confirmation: string): Promise<void> {
    if (confirmation !== runId) throw new Error("backtest deletion confirmation does not match");
    const value = await this.#read(runId);
    if (value.job.status === "queued" || value.job.status === "running" || value.job.status === "stopping") throw new Error("an active backtest cannot be deleted");
    if (value.job.status === "succeeded") await new FileBacktestResultStore(this.#dataRoot).delete(runId);
    await rm(join(this.#root, runId), { recursive: true });
  }
  async #validate(request: BacktestRequestV1): Promise<void> {
    if (request.schemaVersion !== "backtest-request-v1" || !SAFE_ID.test(request.requestId) || !SAFE_ID.test(request.strategyId) || !SAFE_ID.test(request.datasetId) || !/^[0-9a-f]{64}$/u.test(request.datasetVersionHash)) throw new Error("invalid backtest request identity");
    if (request.feeModel !== "fee-v2") throw new Error("unsupported fee model"); if (request.latencyMs !== 1000) throw new Error("offline historical runner currently requires the verified 1000 ms execution scenario");
    if (request.evaluationSplit !== "VALIDATION" && request.evaluationSplit !== "FINAL_TEST") throw new Error("a verified evaluation split is required");
    for (const value of [request.initialCash, request.maxPosition]) if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value) || Number(value) <= 0) throw new Error("cash and position must be positive canonical decimals");
    await new DatasetApplicationService(this.#dataRoot, { repositoryRoot: this.#repo }).resolveForExecution({ schemaVersion:"dataset-selection-request-v1", datasetId:request.datasetId, versionHash:request.datasetVersionHash });
    const catalog = createDefaultStrategyCatalog();
    const definition = catalog.get(request.strategyId);
    if (!definition.allowedModes.includes("backtest")) throw new Error("strategy is not registered for backtest");
    if (definition.runtime !== "python") throw new Error("offline historical runner currently requires a registered Python adapter");
    await new FileStrategyVersionStore(this.#dataRoot).load(catalog, request.strategyId, request.strategyVersion);
  }
  #withPresentation(request: BacktestRequestV1): BacktestRequestV1 {
    const catalog = createDefaultStrategyCatalog();
    const definition = catalog.get(request.strategyId);
    const split = request.evaluationSplit === "FINAL_TEST" ? "最终测试集" : "验证集";
    const dataset = request.datasetId.replace(/[_-]+/gu, " ").replace(/\b\w/gu, (item) => item.toUpperCase());
    const displayName = request.displayName?.trim() || `${definition.displayName} · ${dataset} · ${split}`;
    const description = request.description?.trim() || `${definition.displayName} ${request.strategyVersion} 在 ${dataset} 上的 ${split}回测；费用 ${request.feeModel}，执行延迟 ${request.latencyMs} ms。`;
    return Object.freeze({ ...request, displayName, description });
  }
  #baselineRequests(request: BacktestRequestV1): readonly BacktestRequestV1[] {
    const catalog = createDefaultStrategyCatalog();
    return ["B0_NO_TRADE", "B1_MARKET_PROBABILITY", "B2_GBM_BINANCE_PROXY", "B3_MARKET_PRIOR_LOGISTIC"].map((strategyId) => {
      const definition = catalog.get(strategyId); const strategyVersion = catalog.builtInVersions(strategyId).at(-1);
      if (strategyVersion === undefined) throw new Error(`baseline has no frozen version: ${strategyId}`);
      return this.#withPresentation({ ...request, requestId: `${request.requestId}-${strategyId.slice(0, 2)}`, strategyId, strategyVersion, includeBaselines: false, displayName: `${definition.displayName} · 自动对照`, description: `与 ${request.displayName ?? request.strategyId} 使用同一数据、资金、费用和延迟假设的自动研究对照。` });
    });
  }
  async #all(): Promise<PersistedJob[]> { const entries = await readdir(this.#root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error)); const values: PersistedJob[] = []; for (const entry of entries) if (entry.isDirectory() && SAFE_ID.test(entry.name)) { try { values.push(await this.#read(entry.name)); } catch { /* Incomplete or corrupt jobs are not surfaced. */ } } return values; }
  async #read(runId: string): Promise<PersistedJob> { if (!SAFE_ID.test(runId)) throw new Error("invalid runId"); const value: unknown = JSON.parse(await readFile(join(this.#root, runId, "job.json"), "utf8")); if (typeof value !== "object" || value === null || Array.isArray(value) || (value as PersistedJob).schemaVersion !== "desktop-backtest-job-v1" || (value as PersistedJob).job.runId !== runId) throw new Error("invalid persisted backtest job"); return value as PersistedJob; }
  async #write(runId: string, value: PersistedJob): Promise<void> { const directory = join(this.#root, runId); const temporary = join(directory, `job.${process.pid}.${randomUUID()}.partial`); await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 }); await rename(temporary, join(directory, "job.json")); }
  #update(runId: string, job: BacktestJobV1, workerPid: number | null): Promise<void> { return this.#read(runId).then((value) => this.#write(runId, { ...value, job: Object.freeze(job), workerPid })); }
}

export async function runDesktopBacktestWorker(dataRoot: string, runId: string, repositoryRoot = process.cwd()): Promise<void> {
  const root = resolve(dataRoot, "workbench", "backtest-jobs"); const path = join(root, runId, "job.json"); const persisted = JSON.parse(await readFile(path, "utf8")) as PersistedJob;
  const write = async (job: BacktestJobV1) => { const temporary = join(root, runId, `job.${process.pid}.${randomUUID()}.partial`); await writeFile(temporary, `${JSON.stringify({ ...persisted, job, workerPid: process.pid })}\n`, { flag: "wx", mode: 0o600 }); await rename(temporary, path); };
  await write({ ...persisted.job, status: "running", progressPermille: 50 }); let child: ChildProcessWithoutNullStreams | null = null; let cancelled = false;
  process.once("SIGTERM", () => { cancelled = true; child?.kill("SIGTERM"); });
  try {
    const dataset = await new DatasetApplicationService(dataRoot, { repositoryRoot }).resolveForExecution({ schemaVersion:"dataset-selection-request-v1", datasetId:persisted.request.datasetId, versionHash:persisted.request.datasetVersionHash });
    const datasetPath = dataset.publicationDirectory;
    const catalog = createDefaultStrategyCatalog(); const definition = catalog.get(persisted.request.strategyId);
    if (!definition.allowedModes.includes("backtest") || definition.runtime !== "python") throw new Error("strategy is not executable by the offline historical runner");
    const version = await new FileStrategyVersionStore(dataRoot).load(catalog, persisted.request.strategyId, persisted.request.strategyVersion); const startedAtUtc = new Date().toISOString();
    const input = { runId, datasetPath, datasetVersionHash: persisted.request.datasetVersionHash, strategyId: persisted.request.strategyId, parameters: version.parameters, initialCash: persisted.request.initialCash, maxPosition: persisted.request.maxPosition, startedAtUtc, completedAtUtc: startedAtUtc, request: persisted.request };
    const output = await new Promise<string>((resolveOutput, rejectOutput) => { child = spawn("/usr/bin/python3", [resolve(repositoryRoot, "scripts", "run_workbench_backtest.py")], { cwd: repositoryRoot, env: { PATH: "/usr/bin:/bin", PYTHONPATH: repositoryRoot }, stdio: ["pipe", "pipe", "pipe"] }); let stdout = ""; let stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { stdout += chunk; if (stdout.length > 16 * 1024 * 1024) child?.kill(); }); child.stderr.on("data", (chunk: string) => { stderr += chunk; if (stderr.length > 16_384) child?.kill(); }); child.on("error", rejectOutput); child.on("close", (code) => code === 0 ? resolveOutput(stdout) : rejectOutput(new Error(stderr.trim() || `python backtest exited ${String(code)}`))); child.stdin.end(JSON.stringify(input)); });
    if (cancelled) { await write({ ...persisted.job, status: "cancelled", progressPermille: 50 }); return; }
    const result = JSON.parse(output) as BacktestResultV1; const completed = Object.freeze({ ...result, completedAtUtc: new Date().toISOString() }); await new FileBacktestResultStore(dataRoot).save(completed); await write({ ...persisted.job, status: "succeeded", progressPermille: 1000, error: null });
  } catch (error: unknown) { await write({ ...persisted.job, status: cancelled ? "cancelled" : "failed", error: cancelled ? null : error instanceof Error ? error.message : "backtest failed" }); }
}
