/** Fixed desktop backend entry. The sole path input is a validated, read-only dataset source registration; arbitrary executable, SQL and network input remain forbidden. */
import { buildWorkbenchManifestV1, buildWorkbenchViewV1 } from "../backend/workbench/index.js";
import { readFileSync, writeSync } from "node:fs";
import { createDefaultStrategyCatalog, FileStrategyVersionStore, type StrategyParameterValue, type StrategyVersionV1 } from "../backend/strategy-management/index.js";
import { DatasetApplicationService } from "../backend/dataset-api/index.js";
import { normalizeRawDataset } from "../backend/dataset-api/raw-normalizer.js";
import { DesktopBacktestService } from "../backend/backtest/desktop-service.js";
import { FileBacktestResultStore, type BacktestRequestV1 } from "../backend/backtest/jobs.js";
import { BackendQueryService, type PageRequestV1, type SystemStatusSource } from "../backend/query/index.js";
import { FilePaperSessionStateStore, PaperSessionService, queryPaperReplay, type CallerManagedPublicMarketAdapter, type PaperSessionStartV1 } from "../backend/paper-session/index.js";
import type { PaperOrderRequest, PaperToken } from "../backend/paper-simulation/index.js";

function dataRoot(override?: string): string {
  const value = override ?? process.env.POLYMARKET_DATA_ROOT;
  if (value === undefined || !value.startsWith("/")) throw new Error("POLYMARKET_DATA_ROOT must be an absolute path");
  return value;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string`);
  return value;
}

function parameterMap(value: unknown): Readonly<Record<string, StrategyParameterValue>> {
  const input = object(value, "parameters");
  for (const [name, item] of Object.entries(input)) {
    if (typeof item !== "string" && typeof item !== "boolean" && (typeof item !== "number" || !Number.isFinite(item))) throw new Error(`parameter ${name} is invalid`);
  }
  return input as Record<string, StrategyParameterValue>;
}

function pageRequest(value: unknown): PageRequestV1 {
  const input = object(value, "page");
  return { page: input.page as number, pageSize: input.pageSize as number };
}

function runIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("runIds must be an array of strings");
  return value;
}

export async function executeWorkbenchCommand(command: string, payload: unknown = {}, generatedAtUtc = new Date().toISOString(), dataRootOverride?: string): Promise<unknown> {
  const root = dataRoot(dataRootOverride);
  const view = buildWorkbenchViewV1(root);
  if (command === "view") return view;
  if (command === "manifest") return buildWorkbenchManifestV1(generatedAtUtc, view);
  const input = object(payload, "command payload");
  const catalog = createDefaultStrategyCatalog();
  const store = new FileStrategyVersionStore(root);
  const datasets = new DatasetApplicationService(root, { clock: () => generatedAtUtc });
  const backtests = new DesktopBacktestService(root);
  const status: SystemStatusSource = {
    async health() {
      let datasetStatus: "healthy" | "unavailable" = "healthy";
      let jobsStatus: "healthy" | "unavailable" = "healthy";
      let jobs: Awaited<ReturnType<DesktopBacktestService["list"]>> = [];
      try { await datasets.scan(); } catch { datasetStatus = "unavailable"; }
      try { jobs = await backtests.list(); } catch { jobsStatus = "unavailable"; }
      return {
        status: "degraded",
        checkedAtUtc: generatedAtUtc,
        database: "unavailable",
        datasets: datasetStatus,
        jobs: jobsStatus,
        activeJobs: jobs.filter((job) => job.status === "queued" || job.status === "running" || job.status === "stopping").length,
        failedJobs: jobs.filter((job) => job.status === "failed").length,
      };
    },
    async incidents() { return []; },
  };
  const queries = new BackendQueryService(new FileBacktestResultStore(root), status);
  const offlineAdapter: CallerManagedPublicMarketAdapter = Object.freeze({ adapterId: "desktop-public-market-adapter", source: "PUBLIC_MARKET_DATA", lifecycle: "CALLER_MANAGED", isReady: () => false, latest: () => null });
  const paper = new PaperSessionService(offlineAdapter, new FilePaperSessionStateStore(root)); await paper.initialize();
  if (command === "list-strategy-definitions") return catalog.list();
  if (command === "list-strategy-versions") return store.list(text(input.strategyId, "strategyId"));
  if (command === "get-strategy-version") return store.load(catalog, text(input.strategyId, "strategyId"), text(input.version, "version"));
  if (command === "validate-strategy-parameters") {
    try { const strategyId = text(input.strategyId, "strategyId"); const parameters = parameterMap(input.parameters); catalog.validateParameters(strategyId, parameters); return { schemaVersion: "strategy-validation-v1", valid: true, errors: [], warnings: catalog.parameterWarnings(strategyId, parameters) }; }
    catch (error: unknown) { return { schemaVersion: "strategy-validation-v1", valid: false, errors: [error instanceof Error ? error.message : "invalid parameters"], warnings: [] }; }
  }
  if (command === "save-strategy-version") {
    const value = object(input.value, "value") as StrategyVersionV1;
    await store.save(catalog, value);
    return store.load(catalog, value.strategyId, value.version);
  }
  if (command === "delete-strategy-version") {
    const strategyId=text(input.strategyId,"strategyId"),version=text(input.version,"version");
    if(await backtests.usesStrategyVersion(strategyId,version))throw new Error("strategy version is referenced by a persisted backtest");
    await store.delete(catalog,strategyId,version,text(input.confirmation,"confirmation"));
    return {schemaVersion:"deletion-receipt-v1",entityType:"strategy-version",entityId:`${strategyId}:${version}`,deletedAtUtc:generatedAtUtc};
  }
  if (command === "register-dataset-source") return datasets.registerSource(input.request as never);
  if (command === "normalize-raw-dataset") return normalizeRawDataset(dataRoot(dataRootOverride), process.cwd(), input.request as never);
  if (command === "scan-datasets" || command === "list-datasets") {
    const scan = await datasets.scan();
    return command === "scan-datasets" ? scan : datasets.list();
  }
  if (command === "get-dataset") {
    await datasets.scan();
    return datasets.get(text(input.datasetId, "datasetId"), text(input.versionHash, "versionHash"));
  }
  if (command === "validate-dataset-selection") {
    await datasets.scan();
    return datasets.validateSelection(input.selection as never);
  }
  if(command==="delete-dataset"){
    const datasetId=text(input.datasetId,"datasetId"),versionHash=text(input.versionHash,"versionHash");
    if(await backtests.usesDataset(datasetId,versionHash))throw new Error("dataset version is referenced by a persisted backtest");
    await datasets.deleteManagedPublication(datasetId,versionHash,text(input.confirmation,"confirmation"));
    return {schemaVersion:"deletion-receipt-v1",entityType:"dataset",entityId:`${datasetId}:${versionHash}`,deletedAtUtc:generatedAtUtc};
  }
  if (command === "start-backtest") return backtests.start(object(input.request, "request") as BacktestRequestV1);
  if (command === "get-backtest-job") return backtests.get(text(input.runId, "runId"));
  if (command === "list-backtest-jobs") return backtests.list();
  if (command === "stop-backtest") return backtests.stop(text(input.runId, "runId"));
  if (command === "get-backtest-result") return backtests.result(text(input.runId, "runId"));
  if(command==="delete-backtest"){
    const runId=text(input.runId,"runId");await backtests.delete(runId,text(input.confirmation,"confirmation"));
    return {schemaVersion:"deletion-receipt-v1",entityType:"backtest",entityId:runId,deletedAtUtc:generatedAtUtc};
  }
  if (command === "get-backtest-decisions") return queries.decisions(text(input.runId, "runId"), pageRequest(input.page));
  if (command === "get-backtest-orders") return queries.orders(text(input.runId, "runId"), pageRequest(input.page));
  if (command === "get-backtest-fills") return queries.fills(text(input.runId, "runId"), pageRequest(input.page));
  if (command === "get-backtest-settlements") return queries.settlements(text(input.runId, "runId"), pageRequest(input.page));
  if (command === "get-backtest-equity") return queries.equityCurve(text(input.runId, "runId"), pageRequest(input.page));
  if (command === "get-backtest-replay") return queries.replay(text(input.runId, "runId"), pageRequest(input.page));
  if (command === "compare-backtests") return queries.compare(runIds(input.runIds));
  if (command === "get-system-health") return queries.health();
  if (command === "list-system-incidents") return queries.incidents(pageRequest(input.page));
  if (command === "list-paper-sessions") return paper.list();
  if (command === "get-paper-replay") return queryPaperReplay(root, paper, Number(input.page), Number(input.pageSize));
  if (command === "start-paper-session") return paper.start(object(input.request, "request") as PaperSessionStartV1);
  if (command === "get-paper-session-status") return paper.status(text(input.sessionId, "sessionId"));
  if (command === "get-paper-session-detail") return paper.detail(text(input.sessionId, "sessionId"));
  if (command === "stop-paper-session") return paper.stop(text(input.sessionId, "sessionId"), generatedAtUtc);
  if (command === "resume-paper-session") return paper.resume(text(input.sessionId, "sessionId"), generatedAtUtc);
  if (command === "submit-paper-order") return paper.submitOrder(text(input.sessionId, "sessionId"), object(input.request, "request") as PaperOrderRequest, generatedAtUtc);
  if (command === "cancel-paper-order") return paper.cancelOrder(text(input.sessionId, "sessionId"), text(input.orderId, "orderId"), generatedAtUtc, text(input.reason, "reason"));
  if (command === "reprice-paper-order") return paper.repriceOrder(text(input.sessionId, "sessionId"), text(input.orderId, "orderId"), object(input.replacement, "replacement") as PaperOrderRequest, generatedAtUtc);
  if (command === "expire-paper-orders") return paper.expireOrders(text(input.sessionId, "sessionId"), generatedAtUtc);
  if (command === "settle-paper-market") { if (input.evidenceMode !== "MANUAL_PAPER_TEST" || (input.winningToken !== "YES" && input.winningToken !== "NO")) throw new Error("manual Paper settlement evidence is invalid"); return paper.settleMarket(text(input.sessionId, "sessionId"), text(input.marketId, "marketId"), input.winningToken as PaperToken, generatedAtUtc); }
  if (command === "get-paper-system-control") return paper.systemStatus();
  if (command === "set-paper-kill-switch") { if (typeof input.enabled !== "boolean") throw new Error("enabled must be boolean"); return paper.setSystemKillSwitch(input.enabled, generatedAtUtc, text(input.reason, "reason")); }
  throw new Error("unsupported workbench backend command");
}

if (process.argv[1]?.endsWith("workbench-command.js")) {
  try {
    const stdin = readFileSync(0, "utf8");
    const payload: unknown = stdin.trim() === "" ? {} : JSON.parse(stdin);
    writeSync(1, `${JSON.stringify(await executeWorkbenchCommand(process.argv[2] ?? "", payload))}\n`);
  } catch (error: unknown) {
    writeSync(2, `${error instanceof Error ? error.message : "workbench backend failed"}\n`);
    process.exitCode = 1;
  }
}
