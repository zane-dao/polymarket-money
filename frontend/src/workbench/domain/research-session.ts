import type { WorkbenchRouteId } from "./workbench.js";

export const RESEARCH_SESSION_SCHEMA_VERSION = "research-session-v1" as const;

export type WorkflowStage = "scope" | "assumptions" | "run" | "analysis" | "paper-review";

export type ResearchSession = Readonly<{
  schemaVersion: typeof RESEARCH_SESSION_SCHEMA_VERSION;
  sessionId: string;
  datasetId: string | null;
  datasetVersionHash: string | null;
  strategyId: string | null;
  strategyVersion: string | null;
  evaluationSplit: "VALIDATION" | "FINAL_TEST";
  feeModel: string;
  latencyMs: number;
  initialCash: string;
  maxPosition: string;
  runId: string | null;
  comparisonRunIds: readonly string[];
  analysisFromUtc: string | null;
  analysisToUtc: string | null;
  replayEventKind: string | null;
  stage: WorkflowStage;
}>;

export const INITIAL_RESEARCH_SESSION: ResearchSession = Object.freeze({
  schemaVersion: RESEARCH_SESSION_SCHEMA_VERSION,
  sessionId: "local-research",
  datasetId: null,
  datasetVersionHash: null,
  strategyId: null,
  strategyVersion: null,
  evaluationSplit: "VALIDATION",
  feeModel: "fee-v2",
  latencyMs: 1000,
  initialCash: "1000",
  maxPosition: "100",
  runId: null,
  comparisonRunIds: Object.freeze([]),
  analysisFromUtc: null,
  analysisToUtc: null,
  replayEventKind: null,
  stage: "scope",
});

const ROUTE_STAGE: Readonly<Partial<Record<WorkbenchRouteId, WorkflowStage>>> = Object.freeze({
  datasets: "scope",
  strategy: "scope",
  backtest: "run",
  replay: "analysis",
  compare: "analysis",
  live: "paper-review",
});

export function stageForRoute(routeId: WorkbenchRouteId, fallback: WorkflowStage): WorkflowStage {
  return ROUTE_STAGE[routeId] ?? fallback;
}

export function researchSessionFromUrl(search: string): Partial<ResearchSession> {
  const params = new URLSearchParams(search);
  const split = params.get("split");
  const latencyText = params.get("latencyMs");
  const latency = Number(latencyText);
  const comparisonRunIds = params.getAll("compare").filter(Boolean);
  return {
    ...(params.get("session") ? { sessionId: params.get("session")! } : {}),
    ...(params.get("dataset") ? { datasetId: params.get("dataset")! } : {}),
    ...(params.get("datasetHash") ? { datasetVersionHash: params.get("datasetHash")! } : {}),
    ...(params.get("strategy") ? { strategyId: params.get("strategy")! } : {}),
    ...(params.get("strategyVersion") ? { strategyVersion: params.get("strategyVersion")! } : {}),
    ...(params.get("run") ? { runId: params.get("run")! } : {}),
    ...(split === "VALIDATION" || split === "FINAL_TEST" ? { evaluationSplit: split } : {}),
    ...(params.get("feeModel") ? { feeModel: params.get("feeModel")! } : {}),
    ...(latencyText !== null && Number.isSafeInteger(latency) && Math.sign(latency) !== -1 ? { latencyMs: latency } : {}),
    ...(params.get("initialCash") ? { initialCash: params.get("initialCash")! } : {}),
    ...(params.get("maxPosition") ? { maxPosition: params.get("maxPosition")! } : {}),
    ...(comparisonRunIds.length ? { comparisonRunIds } : {}),
    ...(params.get("from") ? { analysisFromUtc: params.get("from")! } : {}),
    ...(params.get("to") ? { analysisToUtc: params.get("to")! } : {}),
    ...(params.get("eventKind") ? { replayEventKind: params.get("eventKind")! } : {}),
  };
}

export function researchSessionToSearch(session: ResearchSession): string {
  const params = new URLSearchParams();
  params.set("session", session.sessionId);
  if (session.datasetId) params.set("dataset", session.datasetId);
  if (session.datasetVersionHash) params.set("datasetHash", session.datasetVersionHash);
  if (session.strategyId) params.set("strategy", session.strategyId);
  if (session.strategyVersion) params.set("strategyVersion", session.strategyVersion);
  params.set("split", session.evaluationSplit);
  params.set("feeModel", session.feeModel);
  params.set("latencyMs", String(session.latencyMs));
  params.set("initialCash", session.initialCash);
  params.set("maxPosition", session.maxPosition);
  if (session.runId) params.set("run", session.runId);
  for (const runId of session.comparisonRunIds) params.append("compare", runId);
  if (session.analysisFromUtc) params.set("from", session.analysisFromUtc);
  if (session.analysisToUtc) params.set("to", session.analysisToUtc);
  if (session.replayEventKind) params.set("eventKind", session.replayEventKind);
  return `?${params.toString()}`;
}

const ROUTES = new Set<WorkbenchRouteId>(["overview", "live", "decisions", "strategy", "datasets", "backtest", "replay", "compare", "health"]);

export function workbenchRouteFromUrl(search: string): WorkbenchRouteId {
  const route = new URLSearchParams(search).get("view");
  return route !== null && ROUTES.has(route as WorkbenchRouteId) ? route as WorkbenchRouteId : "overview";
}

export function workbenchSearch(session: ResearchSession, routeId: WorkbenchRouteId): string {
  const params = new URLSearchParams(researchSessionToSearch(session));
  params.set("view", routeId);
  return `?${params.toString()}`;
}
