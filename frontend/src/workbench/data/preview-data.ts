import type { DecisionRow, WorkbenchRunSummary, WorkbenchViewData } from "../domain/read-model.js";

export const PREVIEW_DECISIONS: readonly DecisionRow[] = Object.freeze([
  { id: "d-1", time: "23:16:55.068", event: "DECISION", market: "BTC 23:15–23:20", direction: "NO", probability: "0.606", price: "0.381", edge: "+0.36%", eligibility: "ELIGIBLE", pnl: "—" },
  { id: "d-2", time: "23:16:55.108", event: "FILL", market: "BTC 23:15–23:20", direction: "NO", probability: "0.606", price: "0.381", edge: "+0.36%", eligibility: "ELIGIBLE", pnl: "−3.42" },
  { id: "d-3", time: "23:14:58.004", event: "SETTLEMENT", market: "BTC 23:10–23:15", direction: "YES", probability: "0.641", price: "0.592", edge: "+1.04%", eligibility: "SETTLED", pnl: "+28.60" },
  { id: "d-4", time: "23:12:31.201", event: "DECISION", market: "BTC 23:10–23:15", direction: "YES", probability: "0.551", price: "0.548", edge: "+0.08%", eligibility: "EDGE<THRESHOLD", pnl: "—" },
  { id: "d-5", time: "23:09:44.118", event: "INCIDENT", market: "BTC 23:05–23:10", direction: "—", probability: "—", price: "—", edge: "—", eligibility: "DATA_STALE", pnl: "—" },
]);

export const CHART_SERIES = Object.freeze({
  raw: [42, 44, 43, 46, 48, 47, 51, 54, 52, 56, 59, 61, 58, 63, 66, 64, 68, 67],
  calibrated: [40, 42, 43, 44, 47, 48, 49, 52, 53, 55, 57, 59, 59, 61, 63, 64, 65, 66],
  bid: [31, 32, 31, 33, 34, 33, 35, 36, 35, 36, 37, 36, 37, 38, 37, 38, 39, 39],
  ask: [36, 37, 36, 38, 39, 38, 40, 41, 40, 41, 42, 41, 42, 43, 42, 43, 44, 44],
  pnl: [0, 4, 2, 9, 13, 11, 19, 23, 21, 29, 35, 32, 41, 49, 46, 58, 64, 71],
  brier: [19, 18, 18.5, 17, 16, 16.8, 15, 14.5, 14, 13.8, 13, 12.7, 12, 11.8, 11.2, 10.8, 10.2, 9.8],
});

export const RUNS: readonly WorkbenchRunSummary[] = Object.freeze([
  { id: "k04", name: "K-Edge v0.4", pnl: "+214.8", drawdown: "−41.7", brier: "0.0941", color: "blue" },
  { id: "k03", name: "K-Edge v0.3", pnl: "+162.4", drawdown: "−58.2", brier: "0.1098", color: "green" },
  { id: "j02", name: "J-Spread v0.2", pnl: "+88.1", drawdown: "−76.4", brier: "0.1284", color: "purple" },
  { id: "strict", name: "K-Edge Strict", pnl: "+181.2", drawdown: "−33.9", brier: "0.0912", color: "amber" },
]);

export const PREVIEW_WORKBENCH_DATA: WorkbenchViewData = Object.freeze({
  sourceKind: "preview",
  decisions: PREVIEW_DECISIONS,
  chartSeries: CHART_SERIES,
  runs: RUNS,
});
