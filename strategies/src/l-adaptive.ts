import { Decimal } from "decimal.js";

export type LAdaptiveV2Input = Readonly<{
  currentPrice: string;
  openingPrice: string;
  remainingSeconds: string;
  elapsedSeconds: string;
  sigmaShort: string;
  sigmaMedium: string;
  sigmaLong: string;
  upBid: string;
  upAsk: string;
  upAskSize: string;
  downBid: string;
  downAsk: string;
  downAskSize: string;
  feeRate: string;
  bankroll: string;
  maxSignalEdge: string;
  maxStakeUsdc: string;
  bookParticipation: string;
}>;

export type LAdaptiveV2Decision = Readonly<{
  action: "NO_TRADE" | "TARGET_POSITION";
  reason: string;
  outcome: "UP" | "DOWN" | null;
  probabilityUp: string;
  sideProbability: string | null;
  edge: string | null;
  requiredEdge: string | null;
  targetStake: string;
  targetPositionQuantity: string;
  maximumAcceptablePrice: string | null;
  audit: Readonly<{
    sigmaBlended: string;
    volatilityShock: string;
    volatilityDrag: string;
    remainingUncertainty: string;
    criticalAnchorBandUsd: string;
  }>;
}>;

const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const HALF = new Decimal("0.5");
const D = (value: string): Decimal => {
  const parsed = new Decimal(value);
  if (!parsed.isFinite()) throw new Error("L adaptive input must be finite");
  return parsed;
};
const canonical = (value: Decimal): string => value.toFixed();

function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  return sign * (1 - (((((1.061405429 * t - 1.453152027) * t)
    + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
}

function noTrade(
  reason: string,
  probabilityUp: Decimal,
  audit: LAdaptiveV2Decision["audit"],
  values: Partial<Pick<LAdaptiveV2Decision, "outcome" | "sideProbability" | "edge" | "requiredEdge">> = {},
): LAdaptiveV2Decision {
  return Object.freeze({
    action: "NO_TRADE", reason, outcome: values.outcome ?? null,
    probabilityUp: canonical(probabilityUp), sideProbability: values.sideProbability ?? null,
    edge: values.edge ?? null, requiredEdge: values.requiredEdge ?? null,
    targetStake: "0", targetPositionQuantity: "0", maximumAcceptablePrice: null,
    audit,
  });
}

export function decideLAdaptiveV2(input: LAdaptiveV2Input): LAdaptiveV2Decision {
  const current = D(input.currentPrice); const opening = D(input.openingPrice);
  const remaining = D(input.remainingSeconds); const elapsed = D(input.elapsedSeconds);
  const short = D(input.sigmaShort); const medium = D(input.sigmaMedium); const long = D(input.sigmaLong);
  if (!current.isPositive() || !opening.isPositive() || !remaining.isPositive() || !elapsed.isPositive()
    || short.isNegative() || medium.isNegative() || long.isNegative()) throw new Error("L adaptive market inputs are outside their allowed range");
  const blended = short.pow(2).times("0.5").plus(medium.pow(2).times("0.3"))
    .plus(long.pow(2).times("0.2")).plus(new Decimal("0.000005").pow(2)).sqrt();
  const shock = short.minus(medium).abs().div(short.plus(medium).plus("0.000005"))
    .plus(medium.minus(long).abs().div(medium.plus(long).plus("0.000005"))).div(2);
  const sigma = blended.times(ONE.plus(shock.times("0.35")));
  const remainingSqrt = remaining.sqrt();
  const rawNumber = 0.5 * (1 + erf(Number(current.div(opening).ln().div(sigma.times(remainingSqrt))) / Math.sqrt(2)));
  const raw = Decimal.min(Decimal.max(new Decimal(rawNumber.toString()), "0.02"), "0.98");
  const remainingUncertainty = sigma.times(remainingSqrt);
  const drag = new Decimal("0.55").times(ONE.minus(new Decimal(
    Math.exp(-Number(remainingUncertainty.div("0.004"))).toString(),
  )));
  const probabilityUp = Decimal.min(Decimal.max(HALF.plus(raw.minus(HALF).times(ONE.minus(drag))), "0.02"), "0.98");
  const relativeNoise = new Decimal("0.0001");
  const anchorBand = current.times(relativeNoise.pow(2)
    .plus(remainingUncertainty.times("0.35").pow(2)).sqrt());
  const audit = Object.freeze({
    sigmaBlended: canonical(blended), volatilityShock: canonical(shock),
    volatilityDrag: canonical(drag), remainingUncertainty: canonical(remainingUncertainty),
    criticalAnchorBandUsd: canonical(anchorBand),
  });
  if (current.minus(opening).abs().lt(anchorBand)) return noTrade("DYNAMIC_OPENING_ANCHOR_BAND", probabilityUp, audit);

  const upBid = D(input.upBid); const upAsk = D(input.upAsk); const downBid = D(input.downBid); const downAsk = D(input.downAsk);
  if (!(upBid.gt(0) && upBid.lte(upAsk) && upAsk.lt(1) && downBid.gt(0) && downBid.lte(downAsk) && downAsk.lt(1))) {
    return noTrade("INVALID_DECISION_TOP_OF_BOOK", probabilityUp, audit);
  }
  const downProbability = ONE.minus(probabilityUp);
  const upEdge = probabilityUp.minus(upAsk); const downEdge = downProbability.minus(downAsk);
  const outcome = upEdge.gte(downEdge) ? "UP" : "DOWN";
  const sideProbability = outcome === "UP" ? probabilityUp : downProbability;
  const ask = outcome === "UP" ? upAsk : downAsk;
  const visible = D(outcome === "UP" ? input.upAskSize : input.downAskSize);
  if (!visible.isPositive()) return noTrade("NO_VISIBLE_DECISION_ASK_SIZE", probabilityUp, audit, { outcome });
  if (!ask.gt("0.20") || !ask.lt("0.80")) return noTrade("ENTRY_PRICE_OUTSIDE_V2_RANGE", probabilityUp, audit, { outcome });

  const edge = sideProbability.minus(ask); const feeRate = D(input.feeRate);
  const rawKelly = Decimal.max(ZERO, edge.div(ONE.minus(ask)));
  const fraction = Decimal.min(rawKelly.times("0.25"), "0.02");
  const feePerStake = feeRate.times(ONE.minus(ask));
  const bankroll = D(input.bankroll);
  const cashCap = bankroll.times("0.02").div(ONE.plus(feePerStake));
  const targetStake = Decimal.min(bankroll.times(fraction), cashCap, D(input.maxStakeUsdc));
  const executableNotional = visible.times(ask).times(D(input.bookParticipation));
  const depthPressure = targetStake.isPositive() && executableNotional.isPositive()
    ? ONE.minus(new Decimal(Math.exp(-Number(targetStake.div(executableNotional))).toString())) : ZERO;
  const speed = current.div(opening).ln().abs().div(elapsed);
  const quoteRisk = upAsk.minus(upBid).plus(downAsk.minus(downBid)).div(2);
  const required = feeRate.times(ask).times(ONE.minus(ask))
    .plus(Decimal.max(ZERO, upAsk.plus(downAsk).minus(ONE)).div(2))
    .plus("0.0025")
    .plus(speed.times(2))
    .plus(quoteRisk.times("0.20"))
    .plus(remainingUncertainty.times("0.15"))
    .plus(depthPressure.times("0.02"));
  const common = {
    outcome, sideProbability: canonical(sideProbability), edge: canonical(edge), requiredEdge: canonical(required),
  } as const;
  if (edge.lte(required)) return noTrade("EDGE_BELOW_DYNAMIC_EXECUTION_THRESHOLD", probabilityUp, audit, common);
  if (edge.gt(D(input.maxSignalEdge))) return noTrade("EDGE_ABOVE_STALE_QUOTE_GUARD", probabilityUp, audit, common);
  const quantity = Decimal.min(targetStake.div(ask), visible.times(D(input.bookParticipation)));
  if (quantity.times(ask).lt(1)) return noTrade("BELOW_MINIMUM_INTENT_STAKE", probabilityUp, audit, common);
  return Object.freeze({
    action: "TARGET_POSITION", reason: "EDGE_ACCEPTED", outcome,
    probabilityUp: canonical(probabilityUp), sideProbability: canonical(sideProbability),
    edge: canonical(edge), requiredEdge: canonical(required),
    targetStake: canonical(targetStake), targetPositionQuantity: canonical(quantity),
    maximumAcceptablePrice: canonical(Decimal.min(ask.plus("0.01"), ONE)), audit,
  });
}
