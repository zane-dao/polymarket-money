import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MetricBars } from "../src/workbench/components/LineChart.js";
import { CalibrationComparison } from "../src/workbench/components/QuantAnalysis.js";
import { deriveBacktestAnalytics } from "../src/workbench/domain/backtest-analytics.js";
import type { BacktestResultV1 } from "../src/workbench/services/workbench-commands.js";

function result(): BacktestResultV1 {
  return {
    schemaVersion: "backtest-result-v1",
    runId: "run-calibration",
    request: {
      schemaVersion: "backtest-request-v1",
      requestId: "request-calibration",
      strategyId: "J_FEE_AWARE",
      strategyVersion: "1.0.0",
      datasetId: "btc",
      datasetVersionHash: "a".repeat(64),
      feeModel: "fee-v2",
      latencyMs: 1000,
      initialCash: "1000",
      maxPosition: "100",
    },
    startedAtUtc: "2026-07-21T00:00:00Z",
    completedAtUtc: "2026-07-21T01:00:00Z",
    metrics: {
      netPnl: "2",
      fees: "0.2",
      maxDrawdown: "-1",
      fillRate: "1",
      winRate: "0.5",
      brier: "0.055",
    },
    equityCurve: [
      { timeUtc: "2026-07-21T00:00:00Z", equity: "1000" },
      { timeUtc: "2026-07-21T00:30:00Z", equity: "998" },
      { timeUtc: "2026-07-21T01:00:00Z", equity: "1002" },
    ],
    events: [
      {
        eventId: "decision-1",
        eventTimeUtc: "2026-07-21T00:10:00Z",
        kind: "decision",
        payload: {
          probability: "0.2",
          outcome: "DOWN",
          edge: "0.08",
          netEdge: "0.05",
          requiredEdge: "0.03",
          estimatedFee: "0.01",
          bookParticipation: "0.2",
          intendedQuantity: "10",
          approvedOrderQuantity: "8",
          riskStatus: "APPROVED",
        },
      },
      {
        eventId: "decision-2",
        eventTimeUtc: "2026-07-21T00:20:00Z",
        kind: "decision",
        payload: {
          probability: "0.7",
          outcome: "UP",
          edge: "0.06",
          netEdge: "0.02",
          requiredEdge: "0.03",
          estimatedFee: "0.01",
          bookParticipation: "0.4",
          intendedQuantity: "5",
          approvedOrderQuantity: "2",
          riskStatus: "REDUCED",
          riskReasonCodes: "MARKET_EXPOSURE|VISIBLE_DEPTH",
        },
      },
      {
        eventId: "decision-null",
        eventTimeUtc: "2026-07-21T00:30:00Z",
        kind: "decision",
        payload: { probability: null, outcome: "UP" },
      },
      {
        eventId: "decision-empty",
        eventTimeUtc: "2026-07-21T00:40:00Z",
        kind: "decision",
        payload: { probability: "", outcome: "DOWN" },
      },
      {
        eventId: "settlement-1",
        eventTimeUtc: "2026-07-21T00:50:00Z",
        kind: "settlement",
        payload: { marketId: "m1", pnl: "4" },
      },
      {
        eventId: "settlement-2",
        eventTimeUtc: "2026-07-21T00:55:00Z",
        kind: "settlement",
        payload: { marketId: "m2", pnl: "-2" },
      },
    ],
  };
}

describe("quant analysis", () => {
  it("calibrates uppercase backend outcomes and renders auditable Brier buckets", () => {
    render(
      <CalibrationComparison
        runs={[{ result: result(), label: "费用感知策略", color: "#33c7ea" }]}
      />,
    );

    const rows = screen.getAllByRole("row");
    expect(within(rows[1]!).getByText("0.0000")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("0.0400")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("1.0000")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("0.0900")).toBeInTheDocument();
    expect(rows).toHaveLength(3);
    expect(screen.getByText("Brier 分桶明细")).toBeInTheDocument();
  });

  it("renders net PnL on opposite sides of a visible zero axis", () => {
    const { container } = render(
      <MetricBars
        groups={[
          {
            label: "净盈亏",
            direction: "higher",
            values: [
              { label: "盈利策略", value: 12, color: "#4fd17d" },
              { label: "亏损策略", value: -8, color: "#ff676f" },
            ],
          },
        ]}
      />,
    );

    expect(
      container.querySelector(".metric-bars__track .is-positive"),
    ).toBeInTheDocument();
    expect(
      container.querySelector(".metric-bars__track .is-negative"),
    ).toBeInTheDocument();
    expect(screen.getByText("+12.0")).toHaveClass("positive");
    expect(screen.getByText("-8.00")).toHaveClass("negative");
  });

  it("derives probability and return metrics once from the frozen result", () => {
    const analytics = deriveBacktestAnalytics(result());

    expect(analytics.probability.observations).toHaveLength(2);
    expect(analytics.probability.brier).toBeCloseTo(0.065);
    expect(analytics.probability.logLoss).toBeCloseTo(0.289909, 5);
    expect(analytics.probability.ece).toBeCloseTo(0.25);
    expect(analytics.probability.mce).toBeCloseTo(0.3);
    expect(analytics.returns.totalReturn).toBeCloseTo(0.002);
    expect(analytics.returns.profitFactor).toBeCloseTo(2);
    expect(analytics.returns.var95).toBe(-2);
    expect(analytics.returns.cvar95).toBe(-2);
    expect(analytics.returns.recoverySamples).toBe(1);
    expect(analytics.execution.meanGrossEdge).toBeCloseTo(0.07);
    expect(analytics.execution.meanNetEdge).toBeCloseTo(0.035);
    expect(analytics.execution.approvalRatio).toBeCloseTo(2 / 3);
    expect(analytics.execution.riskStatusCounts).toEqual({
      APPROVED: 1,
      REDUCED: 1,
    });
    expect(analytics.execution.riskReasonCounts).toEqual({
      MARKET_EXPOSURE: 1,
      VISIBLE_DEPTH: 1,
    });
  });
});
