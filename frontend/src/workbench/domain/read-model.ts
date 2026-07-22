export type DecisionRow = Readonly<{
  id: string;
  time: string;
  event: "DECISION" | "ORDER" | "FILL" | "SETTLEMENT" | "INCIDENT";
  market: string;
  direction: "YES" | "NO" | "—";
  probability: string;
  price: string;
  edge: string;
  eligibility: "ELIGIBLE" | "EDGE<THRESHOLD" | "DATA_STALE" | "SETTLED";
  pnl: string;
}>;

export type WorkbenchRunSummary = Readonly<{
  id: string;
  name: string;
  pnl: string;
  drawdown: string;
  brier: string;
  color: "blue" | "green" | "purple" | "amber";
}>;

export type WorkbenchViewData = Readonly<{
  sourceKind: "preview" | "verified-local";
  decisions: readonly DecisionRow[];
  chartSeries: Readonly<{
    raw: readonly number[];
    calibrated: readonly number[];
    bid: readonly number[];
    ask: readonly number[];
    pnl: readonly number[];
    brier: readonly number[];
  }>;
  runs: readonly WorkbenchRunSummary[];
}>;
