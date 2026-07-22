import { listMvpResearchDiagnostics, type MvpResearchDiagnostic } from "../../scripts/mvp-console.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { BacktestResultV1 } from "../backtest/jobs.js";

export const WORKBENCH_VIEW_SCHEMA_V1 = "workbench-view-v1" as const;
export const WORKBENCH_MANIFEST_SCHEMA_V1 = "workbench-manifest-v1" as const;

const ROUTES = [
  ["overview", "总览", "O"], ["live", "实时驾驶舱", "L"],
  ["decisions", "决策记录", "D"], ["strategy", "策略工作室", "S"],
  ["datasets", "数据集管理", "T"], ["backtest", "回测实验室", "B"], ["replay", "市场回放", "R"],
  ["compare", "策略竞技场", "A"], ["health", "系统健康", "H"],
] as const;

export type WorkbenchViewV1 = Readonly<{
  schemaVersion: typeof WORKBENCH_VIEW_SCHEMA_V1;
  sourceKind: "verified-local";
  decisions: readonly Readonly<{ id: string; time: string; event: "DECISION" | "ORDER" | "FILL" | "SETTLEMENT" | "INCIDENT"; market: string; direction: "YES" | "NO" | "—"; probability: string; price: string; edge: string; eligibility: "ELIGIBLE" | "EDGE<THRESHOLD" | "DATA_STALE" | "SETTLED"; pnl: string }>[];
  chartSeries: Readonly<{
    raw: readonly number[];
    calibrated: readonly number[];
    bid: readonly number[];
    ask: readonly number[];
    pnl: readonly number[];
    brier: readonly number[];
  }>;
  runs: readonly Readonly<{
    id: string;
    name: string;
    pnl: string;
    drawdown: string;
    brier: string;
    color: "blue" | "green" | "purple" | "amber";
  }>[];
}>;

export type WorkbenchManifestV1 = Readonly<{
  schemaVersion: typeof WORKBENCH_MANIFEST_SCHEMA_V1;
  generatedAtUtc: string;
  capabilities: readonly Readonly<{
    routeId: typeof ROUTES[number][0];
    label: string;
    shortLabel: string;
    availability: Readonly<{ status: "ready"; asOfUtc: string }> | Readonly<{ status: "unavailable"; reason: string }>;
  }>[];
}>;

export interface WorkbenchArtifactReader {
  listDiagnostics(dataRoot: string): readonly MvpResearchDiagnostic[];
  listBacktests(dataRoot: string): readonly BacktestResultV1[];
}

function listVerifiedBacktests(dataRoot: string): readonly BacktestResultV1[] {
  const directory = resolve(dataRoot, "workbench", "backtest-results"); if (!existsSync(directory)) return Object.freeze([]);
  const results: BacktestResultV1[] = [];
  for (const name of readdirSync(directory).filter((item) => item.endsWith(".json")).sort().reverse().slice(0, 20)) {
    try { const path = resolve(directory, name); if (statSync(path).size > 16 * 1024 * 1024) continue; const bytes = readFileSync(path, "utf8"); const expected = readFileSync(resolve(directory, `${name.slice(0, -5)}.sha256`), "utf8").trim(); if (!/^[0-9a-f]{64}$/u.test(expected) || createHash("sha256").update(bytes).digest("hex") !== expected) continue; const value = JSON.parse(bytes) as BacktestResultV1; if (value.schemaVersion === "backtest-result-v1" && `${value.runId}.json` === name && Array.isArray(value.events) && Array.isArray(value.equityCurve)) results.push(value); } catch { /* Incomplete or tampered results are unavailable. */ }
  }
  return Object.freeze(results);
}

export const verifiedArtifactReader: WorkbenchArtifactReader = Object.freeze({
  listDiagnostics: listMvpResearchDiagnostics,
  listBacktests: listVerifiedBacktests,
});

function finite(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cumulative(values: readonly number[]): number[] {
  let total = 0;
  return values.map((value) => (total += value));
}

/**
 * Builds a UI DTO from hash-verified derived publications only. The DTO contains
 * neither a data-root path nor a database/file handle, so the renderer cannot
 * bypass the backend boundary.
 */
export function buildWorkbenchViewV1(
  dataRoot: string,
  reader: WorkbenchArtifactReader = verifiedArtifactReader,
): WorkbenchViewV1 {
  const diagnostics = reader.listDiagnostics(dataRoot);
  const backtests = reader.listBacktests(dataRoot);
  const colors = ["blue", "green", "purple", "amber"] as const;
  const persistedRuns = backtests.slice(0, 4).map((item, index) => ({ id: item.runId, name: `${item.request.strategyId} · ${item.runId}`, pnl: item.metrics.netPnl, drawdown: item.metrics.maxDrawdown, brier: item.metrics.brier ?? "—", color: colors[index] ?? "blue" }));
  const diagnosticRuns = diagnostics.slice(0, Math.max(0, 4 - persistedRuns.length)).map((item, index) => ({
    id: `${item.runId}:${item.strategy}`,
    name: `${item.strategy} · ${item.runId}`,
    pnl: item.dailyPnl.reduce((total, row) => total + (finite(row.pnl) ?? 0), 0).toFixed(8).replace(/\.?0+$/u, ""),
    drawdown: item.maxDrawdown ?? "—",
    brier: item.brierScore ?? "—",
    color: colors[index + persistedRuns.length] ?? "blue",
  }));
  const runs = [...persistedRuns, ...diagnosticRuns];
  const primary = diagnostics[0];
  const latestBacktest = backtests[0];
  const daily = latestBacktest?.equityCurve.map((row) => finite(row.equity) ?? 0) ?? primary?.dailyPnl.map((row) => finite(row.pnl) ?? 0) ?? [];
  const calibration = primary?.calibration.filter((bucket) => bucket.count > 0) ?? [];
  const brier = finite(latestBacktest?.metrics.brier ?? primary?.brierScore ?? null);
  const decisions = (latestBacktest?.events ?? []).slice(-2000).map((event) => { const payload = event.payload; const side = payload.direction ?? payload.side; const status = payload.status; const reason = payload.reason; return { id: event.eventId, time: event.eventTimeUtc, event: event.kind.toUpperCase() as "DECISION" | "ORDER" | "FILL" | "SETTLEMENT" | "INCIDENT", market: typeof payload.marketId === "string" ? payload.marketId : typeof payload.market_id === "string" ? payload.market_id : latestBacktest!.request.datasetId, direction: side === "UP" || side === "YES" ? "YES" as const : side === "DOWN" || side === "NO" ? "NO" as const : "—" as const, probability: typeof payload.probability === "string" ? payload.probability : typeof payload.probability_up === "string" ? payload.probability_up : "—", price: typeof payload.price === "string" ? payload.price : typeof payload.decision_ask === "string" ? payload.decision_ask : typeof payload.fill_price === "string" ? payload.fill_price : "—", edge: typeof payload.edge === "string" ? payload.edge : "—", eligibility: event.kind === "settlement" ? "SETTLED" as const : reason === "DATA_STALE" ? "DATA_STALE" as const : status === "FILLED" ? "ELIGIBLE" as const : "EDGE<THRESHOLD" as const, pnl: typeof payload.pnl === "string" ? payload.pnl : typeof payload.net_pnl === "string" ? payload.net_pnl : "0" }; });
  return Object.freeze({
    schemaVersion: WORKBENCH_VIEW_SCHEMA_V1,
    sourceKind: "verified-local",
    decisions: Object.freeze(decisions),
    chartSeries: Object.freeze({
      raw: Object.freeze(calibration.map((bucket) => bucket.meanProbabilityUp ?? 0)),
      calibrated: Object.freeze(calibration.map((bucket) => bucket.observedUpRate ?? 0)),
      bid: Object.freeze([]),
      ask: Object.freeze([]),
      pnl: Object.freeze(latestBacktest === undefined ? cumulative(daily) : daily),
      brier: Object.freeze(brier === null ? [] : daily.map(() => brier)),
    }),
    runs: Object.freeze(runs),
  });
}

export function buildWorkbenchManifestV1(
  generatedAtUtc: string,
  view: WorkbenchViewV1,
): WorkbenchManifestV1 {
  if (Number.isNaN(Date.parse(generatedAtUtc)) || !generatedAtUtc.endsWith("Z")) throw new Error("generatedAtUtc must be UTC");
  // Availability describes whether the route has a real backend capability,
  // not whether the current repository happens to contain rows. Empty results
  // are a valid, queryable state and are rendered explicitly by every route.
  void view;
  return Object.freeze({
    schemaVersion: WORKBENCH_MANIFEST_SCHEMA_V1,
    generatedAtUtc,
    capabilities: Object.freeze(ROUTES.map(([routeId, label, shortLabel]) => ({
      routeId, label, shortLabel,
      availability: { status: "ready" as const, asOfUtc: generatedAtUtc },
    }))),
  });
}
