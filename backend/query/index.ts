import type { BacktestEventV1, BacktestResultV1 } from "../backtest/jobs.js";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/u;
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 1_000_000;
const MAX_COMPARE_RUNS = 20;

export type PageRequestV1 = Readonly<{ page: number; pageSize: number }>;
export type PageV1<T> = Readonly<{
  schemaVersion: "query-page-v1";
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  items: readonly T[];
}>;

export type PublicBacktestEventV1 = Readonly<{
  schemaVersion: "public-backtest-event-v1";
  eventId: string;
  eventTimeUtc: string;
  kind: "decision" | "order" | "fill" | "settlement";
  data: Readonly<Record<string, string | number | boolean | null>>;
}>;

export type EquityPointV1 = Readonly<{
  schemaVersion: "equity-point-v1";
  timeUtc: string;
  equity: string;
}>;

export type RunComparisonV1 = Readonly<{
  schemaVersion: "run-comparison-v1";
  runId: string;
  /** Backend-owned presentation fields; absent only for legacy runs. */
  displayName?: string;
  description?: string;
  strategyId: string;
  strategyVersion: string;
  datasetId: string;
  completedAtUtc: string;
  evaluationScope: NonNullable<BacktestResultV1["evaluationScope"]>;
  metrics: BacktestResultV1["metrics"];
}>;

export type HealthInput = Readonly<{
  status: "healthy" | "degraded" | "unavailable";
  checkedAtUtc: string;
  database: "healthy" | "degraded" | "unavailable";
  datasets: "healthy" | "degraded" | "unavailable";
  jobs: "healthy" | "degraded" | "unavailable";
  activeJobs: number;
  failedJobs: number;
}>;

export type SystemHealthV1 = Readonly<HealthInput & {
  schemaVersion: "system-health-v1";
  liveTradingEnabled: false;
  executionMode: "paper-only";
}>;

export type IncidentInput = Readonly<{
  incidentId: string;
  occurredAtUtc: string;
  severity: "info" | "warning" | "error";
  component: "database" | "dataset" | "backtest" | "paper-execution" | "system";
  code: string;
  message: string;
  resolved: boolean;
}>;

export type SystemIncidentV1 = Readonly<IncidentInput & { schemaVersion: "system-incident-v1" }>;

export interface BacktestQueryRepository {
  load(runId: string): Promise<BacktestResultV1>;
}

export interface SystemStatusSource {
  health(): Promise<HealthInput>;
  incidents(): Promise<readonly IncidentInput[]>;
}

const PUBLIC_FIELDS: Readonly<Record<PublicBacktestEventV1["kind"], ReadonlySet<string>>> = Object.freeze({
  decision: new Set(["decisionId", "marketId", "tokenId", "action", "direction", "reason", "reasonCode", "probability", "edge", "netEdge", "requiredEdge", "outcome", "pnl", "decisionAsk", "executablePrice", "feeRate", "estimatedFee", "intendedQuantity", "intendedStake", "targetPositionQuantity", "currentPositionQuantity", "openOrderQuantity", "approvedOrderQuantity", "riskStatus", "riskReasonCodes", "visibleAskQuantity", "decisionVisibleAskQuantity", "bookParticipation"]),
  order: new Set(["orderId", "decisionId", "marketId", "tokenId", "side", "direction", "price", "quantity", "status", "timeInForce", "expiresAtUtc"]),
  fill: new Set(["fillId", "orderId", "marketId", "tokenId", "side", "direction", "price", "quantity", "fee", "status"]),
  settlement: new Set(["settlementId", "marketId", "tokenId", "outcome", "quantity", "payout", "fee", "pnl", "status"]),
});

function validateSafeId(name: string, value: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${name} is invalid`);
}

function validateUtc(name: string, value: string): void {
  if (!UTC_ISO.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${name} is invalid`);
}

function validatePage(request: PageRequestV1): void {
  if (!Number.isSafeInteger(request.page) || request.page < 1 || request.page > MAX_PAGE) throw new Error(`page must be between 1 and ${MAX_PAGE}`);
  if (!Number.isSafeInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > MAX_PAGE_SIZE) {
    throw new Error(`pageSize must be between 1 and ${MAX_PAGE_SIZE}`);
  }
}

function page<T>(items: readonly T[], request: PageRequestV1): PageV1<T> {
  validatePage(request);
  const start = (request.page - 1) * request.pageSize;
  return Object.freeze({
    schemaVersion: "query-page-v1",
    page: request.page,
    pageSize: request.pageSize,
    totalItems: items.length,
    totalPages: Math.ceil(items.length / request.pageSize),
    items: Object.freeze(items.slice(start, start + request.pageSize)),
  });
}

function validateResult(result: BacktestResultV1, runId: string): void {
  if (result.schemaVersion !== "backtest-result-v1" || result.runId !== runId) throw new Error("invalid persisted backtest result");
  validateSafeId("persisted runId", result.runId);
  validateUtc("completedAtUtc", result.completedAtUtc);
  if (!Array.isArray(result.events) || !Array.isArray(result.equityCurve)) throw new Error("invalid persisted backtest result");
}

function validateEvaluationScope(scope:NonNullable<BacktestResultV1["evaluationScope"]>):void {
  if(scope.schemaVersion!=="backtest-evaluation-scope-v1"||!["TRAIN","VALIDATION","FINAL_TEST"].includes(scope.split)||!["BASE_1S","STRESS_1S_PLUS_TICK"].includes(scope.scenario)||!Number.isSafeInteger(scope.horizonSeconds)||scope.horizonSeconds<=0||!Number.isSafeInteger(scope.cohortSize)||scope.cohortSize<=0||!/^[0-9a-f]{64}$/u.test(scope.cohortHash))throw new Error("backtest evaluation cohort evidence is invalid");
}

function publicEvent(event: BacktestEventV1): PublicBacktestEventV1 | null {
  if (event.kind === "incident") return null;
  validateSafeId("eventId", event.eventId);
  validateUtc("eventTimeUtc", event.eventTimeUtc);
  const allowed = PUBLIC_FIELDS[event.kind];
  const data: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(event.payload)) {
    if (!allowed.has(key)) continue;
    if (value === null || typeof value === "boolean") data[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) data[key] = value;
    else if (typeof value === "string" && value.length <= 500) data[key] = value;
  }
  return Object.freeze({ schemaVersion: "public-backtest-event-v1", eventId: event.eventId, eventTimeUtc: event.eventTimeUtc, kind: event.kind, data: Object.freeze(data) });
}

function validateHealth(input: HealthInput): void {
  validateUtc("checkedAtUtc", input.checkedAtUtc);
  const statuses = [input.status, input.database, input.datasets, input.jobs];
  if (statuses.some((value) => value !== "healthy" && value !== "degraded" && value !== "unavailable")) throw new Error("health status is invalid");
  if (!Number.isSafeInteger(input.activeJobs) || input.activeJobs < 0 || !Number.isSafeInteger(input.failedJobs) || input.failedJobs < 0) {
    throw new Error("health job counts are invalid");
  }
}

function publicIncident(input: IncidentInput): SystemIncidentV1 {
  validateSafeId("incidentId", input.incidentId);
  validateSafeId("incident code", input.code);
  validateUtc("occurredAtUtc", input.occurredAtUtc);
  if (input.message.length < 1 || input.message.length > 500 || /(?:api[_-]?key|private[_-]?key|secret|password|cookie|\/root\/|[a-zA-Z]:\\)/iu.test(input.message)) {
    throw new Error("incident message is unsafe");
  }
  if (!(["info", "warning", "error"] as const).includes(input.severity)) throw new Error("incident severity is invalid");
  if (!(["database", "dataset", "backtest", "paper-execution", "system"] as const).includes(input.component)) throw new Error("incident component is invalid");
  if (typeof input.resolved !== "boolean") throw new Error("incident resolved flag is invalid");
  return Object.freeze({ schemaVersion: "system-incident-v1", incidentId: input.incidentId, occurredAtUtc: input.occurredAtUtc, severity: input.severity, component: input.component, code: input.code, message: input.message, resolved: input.resolved });
}

export class BackendQueryService {
  readonly #backtests: BacktestQueryRepository;
  readonly #status: SystemStatusSource;

  constructor(backtests: BacktestQueryRepository, status: SystemStatusSource) {
    this.#backtests = backtests;
    this.#status = status;
  }

  async decisions(runId: string, request: PageRequestV1): Promise<PageV1<PublicBacktestEventV1>> { return this.#events(runId, "decision", request); }
  async orders(runId: string, request: PageRequestV1): Promise<PageV1<PublicBacktestEventV1>> { return this.#events(runId, "order", request); }
  async fills(runId: string, request: PageRequestV1): Promise<PageV1<PublicBacktestEventV1>> { return this.#events(runId, "fill", request); }
  async settlements(runId: string, request: PageRequestV1): Promise<PageV1<PublicBacktestEventV1>> { return this.#events(runId, "settlement", request); }

  async equityCurve(runId: string, request: PageRequestV1): Promise<PageV1<EquityPointV1>> {
    validatePage(request);
    const result = await this.#load(runId);
    const points = result.equityCurve.map((point) => {
      validateUtc("equity timeUtc", point.timeUtc);
      if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(point.equity)) throw new Error("invalid persisted equity point");
      return Object.freeze({ schemaVersion: "equity-point-v1" as const, timeUtc: point.timeUtc, equity: point.equity });
    });
    return page(points, request);
  }

  async replay(runId: string, request: PageRequestV1): Promise<PageV1<PublicBacktestEventV1>> {
    validatePage(request);
    const result = await this.#load(runId);
    const events = result.events.map(publicEvent).filter((event): event is PublicBacktestEventV1 => event !== null)
      .sort((left, right) => left.eventTimeUtc.localeCompare(right.eventTimeUtc) || left.eventId.localeCompare(right.eventId));
    return page(events, request);
  }

  async compare(runIds: readonly string[]): Promise<readonly RunComparisonV1[]> {
    if (runIds.length < 1 || runIds.length > MAX_COMPARE_RUNS || new Set(runIds).size !== runIds.length) throw new Error(`runIds must contain 1 to ${MAX_COMPARE_RUNS} unique values`);
    for (const runId of runIds) validateSafeId("runId", runId);
    const results = await Promise.all(runIds.map((runId) => this.#load(runId)));
    const baseline = results[0]?.request;
    const baselineScope = results[0]?.evaluationScope;
    if (baselineScope === undefined || results.some((result) => result.evaluationScope === undefined)) {
      throw new Error("backtest runs are not comparable: verified evaluation cohort evidence is missing");
    }
    for(const result of results)validateEvaluationScope(result.evaluationScope!);
    if (baseline !== undefined) {
      for (const result of results.slice(1)) {
        const request = result.request;
        if (request.datasetId !== baseline.datasetId || request.datasetVersionHash !== baseline.datasetVersionHash ||
          request.feeModel !== baseline.feeModel || request.latencyMs !== baseline.latencyMs ||
          request.initialCash !== baseline.initialCash || request.maxPosition !== baseline.maxPosition) {
          throw new Error("backtest runs are not comparable: dataset, fee, latency, cash and position assumptions must match");
        }
        const scope = result.evaluationScope!;
        if (scope.split !== baselineScope.split || scope.horizonSeconds !== baselineScope.horizonSeconds ||
          scope.scenario !== baselineScope.scenario || scope.cohortHash !== baselineScope.cohortHash ||
          scope.cohortSize !== baselineScope.cohortSize) {
          throw new Error("backtest runs are not comparable: split, horizon, scenario and evaluated cohort must match");
        }
      }
    }
    return Object.freeze(results.map((result) => {
      validateSafeId("strategyId", result.request.strategyId);
      validateSafeId("datasetId", result.request.datasetId);
      if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/u.test(result.request.strategyVersion)) throw new Error("strategyVersion is invalid");
      for (const value of Object.values(result.metrics)) if (value !== null && !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) throw new Error("comparison metric is invalid");
      return Object.freeze({
        schemaVersion: "run-comparison-v1" as const,
        runId: result.runId,
        ...(result.request.displayName === undefined ? {} : { displayName: result.request.displayName }),
        ...(result.request.description === undefined ? {} : { description: result.request.description }),
        strategyId: result.request.strategyId,
        strategyVersion: result.request.strategyVersion,
        datasetId: result.request.datasetId,
        completedAtUtc: result.completedAtUtc,
        evaluationScope: Object.freeze({ ...result.evaluationScope! }),
        metrics: Object.freeze({
          netPnl: result.metrics.netPnl,
          fees: result.metrics.fees,
          maxDrawdown: result.metrics.maxDrawdown,
          fillRate: result.metrics.fillRate,
          winRate: result.metrics.winRate,
          brier: result.metrics.brier,
        }),
      });
    }));
  }

  async health(): Promise<SystemHealthV1> {
    const value = await this.#status.health();
    validateHealth(value);
    return Object.freeze({
      schemaVersion: "system-health-v1",
      status: value.status,
      checkedAtUtc: value.checkedAtUtc,
      database: value.database,
      datasets: value.datasets,
      jobs: value.jobs,
      activeJobs: value.activeJobs,
      failedJobs: value.failedJobs,
      liveTradingEnabled: false,
      executionMode: "paper-only",
    });
  }

  async incidents(request: PageRequestV1): Promise<PageV1<SystemIncidentV1>> {
    validatePage(request);
    const incidents = (await this.#status.incidents()).map(publicIncident)
      .sort((left, right) => right.occurredAtUtc.localeCompare(left.occurredAtUtc) || left.incidentId.localeCompare(right.incidentId));
    return page(incidents, request);
  }

  async #events(runId: string, kind: PublicBacktestEventV1["kind"], request: PageRequestV1): Promise<PageV1<PublicBacktestEventV1>> {
    validatePage(request);
    const result = await this.#load(runId);
    const events = result.events.filter((event) => event.kind === kind).map(publicEvent).filter((event): event is PublicBacktestEventV1 => event !== null);
    return page(events, request);
  }

  async #load(runId: string): Promise<BacktestResultV1> {
    validateSafeId("runId", runId);
    const result = await this.#backtests.load(runId);
    validateResult(result, runId);
    return result;
  }
}

export const QUERY_LIMITS = Object.freeze({ maxPage: MAX_PAGE, maxPageSize: MAX_PAGE_SIZE, maxCompareRuns: MAX_COMPARE_RUNS });
