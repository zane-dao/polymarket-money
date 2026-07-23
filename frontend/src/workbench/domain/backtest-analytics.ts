import type { BacktestResultV1 } from "../services/workbench-commands.js";

export type ProbabilityObservation = Readonly<{
  probability: number;
  outcome: number;
  pnl: number;
}>;
export type CalibrationBucket = Readonly<{
  lower: number;
  upper: number;
  count: number;
  meanProbability: number;
  observedRate: number;
  brier: number;
  pnl: number;
}>;

export type DerivedBacktestAnalytics = Readonly<{
  probability: Readonly<{
    observations: readonly ProbabilityObservation[];
    buckets: readonly CalibrationBucket[];
    brier: number | null;
    logLoss: number | null;
    ece: number | null;
    mce: number | null;
    reliability: number | null;
    resolution: number | null;
    uncertainty: number | null;
    rollingBrier: readonly number[];
  }>;
  returns: Readonly<{
    settlementPnl: readonly number[];
    totalReturn: number | null;
    sharpe: number | null;
    sortino: number | null;
    calmar: number | null;
    profitFactor: number | null;
    var95: number | null;
    cvar95: number | null;
    recoverySamples: number | null;
    rollingSharpe: readonly number[];
  }>;
  execution: Readonly<{
    decisions: number;
    orders: number;
    fills: number;
    settlements: number;
    meanGrossEdge: number | null;
    meanNetEdge: number | null;
    meanRequiredEdge: number | null;
    meanEstimatedFee: number | null;
    meanBookParticipation: number | null;
    intendedQuantity: number;
    approvedQuantity: number;
    approvalRatio: number | null;
    riskStatusCounts: Readonly<Record<string, number>>;
    riskReasonCounts: Readonly<Record<string, number>>;
  }>;
}>;

export function deriveBacktestAnalytics(
  result: BacktestResultV1,
): DerivedBacktestAnalytics {
  const observations = probabilityObservations(result);
  const buckets = calibrationBuckets(observations);
  const populated = buckets.filter((bucket) => bucket.count > 0);
  const baseRate = mean(observations.map((item) => item.outcome));
  const reliability =
    observations.length === 0
      ? null
      : populated.reduce(
          (sum, bucket) =>
            sum +
            (bucket.count / observations.length) *
              (bucket.meanProbability - bucket.observedRate) ** 2,
          0,
        );
  const resolution =
    observations.length === 0 || baseRate === null
      ? null
      : populated.reduce(
          (sum, bucket) =>
            sum +
            (bucket.count / observations.length) *
              (bucket.observedRate - baseRate) ** 2,
          0,
        );
  const uncertainty = baseRate === null ? null : baseRate * (1 - baseRate);
  const brier = mean(
    observations.map((item) => (item.probability - item.outcome) ** 2),
  );
  const logLoss = mean(
    observations.map((item) => {
      const probability = Math.min(
        1 - 1e-12,
        Math.max(1e-12, item.probability),
      );
      return -(
        item.outcome * Math.log(probability) +
        (1 - item.outcome) * Math.log(1 - probability)
      );
    }),
  );
  const calibrationErrors = populated.map((bucket) =>
    Math.abs(bucket.observedRate - bucket.meanProbability),
  );
  const ece =
    observations.length === 0
      ? null
      : populated.reduce(
          (sum, bucket) =>
            sum +
            (bucket.count / observations.length) *
              Math.abs(bucket.observedRate - bucket.meanProbability),
          0,
        );
  const mce =
    calibrationErrors.length === 0 ? null : Math.max(...calibrationErrors);

  const settlementPnl = result.events
    .filter((event) => event.kind === "settlement")
    .map((event) => Number(event.payload.pnl))
    .filter(Number.isFinite);
  const initialCash = Number(result.request.initialCash);
  const netPnl = Number(result.metrics.netPnl);
  const maxDrawdown = Math.abs(Number(result.metrics.maxDrawdown));
  const totalReturn =
    Number.isFinite(initialCash) && initialCash !== 0 && Number.isFinite(netPnl)
      ? netPnl / initialCash
      : null;
  const grossProfit = settlementPnl
    .filter((value) => value > 0)
    .reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(
    settlementPnl
      .filter((value) => value < 0)
      .reduce((sum, value) => sum + value, 0),
  );
  const profitFactor =
    grossLoss > 0
      ? grossProfit / grossLoss
      : grossProfit > 0
        ? Number.POSITIVE_INFINITY
        : null;
  const sharpe = normalizedRatio(settlementPnl, settlementPnl);
  const downside = settlementPnl.map((value) => Math.min(0, value));
  const sortino = normalizedRatio(settlementPnl, downside);
  const calmar =
    totalReturn !== null && maxDrawdown > 0 && initialCash > 0
      ? totalReturn / (maxDrawdown / initialCash)
      : null;
  const sorted = [...settlementPnl].sort((left, right) => left - right);
  const tailCount = Math.max(1, Math.ceil(sorted.length * 0.05));
  const tail = sorted.slice(0, tailCount);
  const equity = result.equityCurve
    .map((point) => Number(point.equity))
    .filter(Number.isFinite);
  const decisions = result.events.filter((event) => event.kind === "decision");
  const numericDecisionField = (field: string): number[] =>
    decisions.flatMap((event) => {
      const raw = event.payload[field];
      if (
        raw === null ||
        raw === undefined ||
        typeof raw === "boolean" ||
        (typeof raw === "string" && raw.trim() === "")
      )
        return [];
      const value = Number(raw);
      return Number.isFinite(value) ? [value] : [];
    });
  const intendedQuantity = numericDecisionField("intendedQuantity").reduce(
    (sum, value) => sum + value,
    0,
  );
  const approvedQuantity = numericDecisionField("approvedOrderQuantity").reduce(
    (sum, value) => sum + value,
    0,
  );

  return {
    probability: {
      observations,
      buckets,
      brier,
      logLoss,
      ece,
      mce,
      reliability,
      resolution,
      uncertainty,
      rollingBrier: rollingMetric(
        observations.map((item) => (item.probability - item.outcome) ** 2),
        100,
        (values) => mean(values),
      ),
    },
    returns: {
      settlementPnl,
      totalReturn,
      sharpe,
      sortino,
      calmar,
      profitFactor,
      var95:
        sorted.length === 0
          ? null
          : (sorted[Math.max(0, Math.ceil(sorted.length * 0.05) - 1)] ?? null),
      cvar95: mean(tail),
      recoverySamples: drawdownRecoverySamples(equity),
      rollingSharpe: rollingMetric(settlementPnl, 100, (values) =>
        normalizedRatio(values, values),
      ),
    },
    execution: {
      decisions: decisions.length,
      orders: result.events.filter((event) => event.kind === "order").length,
      fills: result.events.filter((event) => event.kind === "fill").length,
      settlements: result.events.filter((event) => event.kind === "settlement")
        .length,
      meanGrossEdge: mean(numericDecisionField("edge")),
      meanNetEdge: mean(numericDecisionField("netEdge")),
      meanRequiredEdge: mean(numericDecisionField("requiredEdge")),
      meanEstimatedFee: mean(numericDecisionField("estimatedFee")),
      meanBookParticipation: mean(numericDecisionField("bookParticipation")),
      intendedQuantity,
      approvedQuantity,
      approvalRatio:
        intendedQuantity > 0 ? approvedQuantity / intendedQuantity : null,
      riskStatusCounts: countTextValues(
        decisions.map((event) => event.payload.riskStatus),
      ),
      riskReasonCounts: countTextValues(
        decisions.flatMap((event) =>
          splitReasons(event.payload.riskReasonCodes),
        ),
      ),
    },
  };
}

export function probabilityValue(
  raw: string | number | boolean | null | undefined,
): number | null {
  if (
    raw === null ||
    raw === undefined ||
    typeof raw === "boolean" ||
    (typeof raw === "string" && raw.trim() === "")
  )
    return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

export function probabilityObservations(
  result: BacktestResultV1,
): readonly ProbabilityObservation[] {
  const pnlByMarket = new Map<string, number>();
  for (const event of result.events) {
    if (event.kind !== "settlement") continue;
    const marketId = String(event.payload.marketId ?? "");
    const pnl = Number(event.payload.pnl);
    if (marketId !== "" && Number.isFinite(pnl)) pnlByMarket.set(marketId, pnl);
  }
  return result.events.flatMap((event) => {
    if (event.kind !== "decision") return [];
    const probability = probabilityValue(
      event.payload.probability ??
        event.payload.modelProbabilityYes ??
        event.payload.p_cal,
    );
    const outcome = String(event.payload.outcome ?? "").toLowerCase();
    if (probability === null || (outcome !== "up" && outcome !== "down"))
      return [];
    return [
      {
        probability,
        outcome: outcome === "up" ? 1 : 0,
        pnl: pnlByMarket.get(String(event.payload.marketId ?? "")) ?? 0,
      },
    ];
  });
}

export function calibrationBuckets(
  observations: readonly ProbabilityObservation[],
): readonly CalibrationBucket[] {
  return Array.from({ length: 10 }, (_, index) => {
    const lower = index / 10;
    const upper = (index + 1) / 10;
    const rows = observations.filter(
      (item) =>
        item.probability >= lower &&
        (index === 9 ? item.probability <= upper : item.probability < upper),
    );
    return {
      lower,
      upper,
      count: rows.length,
      meanProbability: mean(rows.map((item) => item.probability)) ?? 0,
      observedRate: mean(rows.map((item) => item.outcome)) ?? 0,
      brier:
        mean(rows.map((item) => (item.probability - item.outcome) ** 2)) ?? 0,
      pnl: rows.reduce((sum, item) => sum + item.pnl, 0),
    };
  });
}

function normalizedRatio(
  numeratorValues: readonly number[],
  riskValues: readonly number[],
): number | null {
  const average = mean(numeratorValues);
  if (average === null || riskValues.length < 2) return null;
  const risk = standardDeviation(riskValues);
  return risk > 0 ? (average / risk) * Math.sqrt(numeratorValues.length) : null;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: readonly number[]): number {
  const average = mean(values) ?? 0;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      Math.max(1, values.length - 1),
  );
}

function rollingMetric(
  values: readonly number[],
  windowSize: number,
  calculate: (window: readonly number[]) => number | null,
): readonly number[] {
  if (values.length < 2) return [];
  const window = Math.min(windowSize, values.length);
  return values.slice(window - 1).flatMap((_, index) => {
    const value = calculate(values.slice(index, index + window));
    return value === null || !Number.isFinite(value) ? [] : [value];
  });
}

function drawdownRecoverySamples(equity: readonly number[]): number | null {
  if (equity.length < 2) return null;
  let peak = equity[0]!;
  let peakIndex = 0;
  let troughIndex = 0;
  let worstDrawdown = 0;
  for (let index = 1; index < equity.length; index += 1) {
    const value = equity[index]!;
    if (value >= peak) {
      peak = value;
      peakIndex = index;
    }
    const drawdown = value - peak;
    if (drawdown < worstDrawdown) {
      worstDrawdown = drawdown;
      troughIndex = index;
    }
  }
  if (worstDrawdown === 0) return 0;
  const targetPeak = Math.max(...equity.slice(0, troughIndex + 1));
  const recoveryIndex = equity.findIndex(
    (value, index) => index > troughIndex && value >= targetPeak,
  );
  return recoveryIndex < 0 ? null : recoveryIndex - troughIndex;
}

function splitReasons(
  value: string | number | boolean | null | undefined,
): readonly string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[|,;]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function countTextValues(
  values: readonly (string | number | boolean | null | undefined)[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    if (typeof value !== "string" || value.trim() === "") continue;
    const key = value.trim();
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.freeze(counts);
}
