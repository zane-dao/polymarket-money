import {
  Money,
  minimumMoney,
  roundFeeToFiveDecimals,
} from "../domain/money.js";

export type LiquidityRole = "TAKER" | "MAKER";
export type FeeEvidenceStatus = "VERIFIED" | "UNVERIFIED" | "MISSING";

export interface FeeScheduleEvidence {
  readonly market_id: string;
  readonly condition_id: string;
  readonly effective_from: string;
  readonly effective_to: string;
  readonly fee_rate: string;
  readonly evidence_reference: string;
  readonly evidence_status: FeeEvidenceStatus;
}

export interface FeeQuoteInput {
  readonly marketId: string;
  readonly conditionId: string;
  readonly executableTime: string;
  readonly liquidityRole: LiquidityRole;
  readonly price: string;
  readonly quantity: string;
  readonly evidence: FeeScheduleEvidence;
}

export interface FeeQuote {
  readonly amount: string | null;
  readonly verified: boolean;
  readonly reasonCode: "ROUNDING_TIE_UNVERIFIED" | "MISSING_FEE_EVIDENCE" | "UNVERIFIED_FEE_EVIDENCE" | null;
  readonly evidenceReference: string;
  readonly feeRate: string;
  readonly liquidityRole: LiquidityRole;
}

export interface CompleteSetInput {
  readonly marketId: string;
  readonly conditionId: string;
  readonly executableTime: string;
  readonly upAsk: string;
  readonly downAsk: string;
  readonly upAskSize: string;
  readonly downAskSize: string;
  readonly evidence: FeeScheduleEvidence;
}

export interface CompleteSetResult {
  readonly visibleSize: string;
  readonly upFee: FeeQuote;
  readonly downFee: FeeQuote;
  readonly grossEdgeAmount: string;
  readonly scenarioNetEdgeAmount: string | null;
}

function required(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value;
}

function utc(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!value.endsWith("Z") || !Number.isFinite(parsed)) throw new Error(`${field} must be UTC`);
  return parsed;
}

export class FeeEdgeCalculator {
  quoteFee(input: FeeQuoteInput): FeeQuote {
    const evidence = input.evidence;
    if (required(input.marketId, "marketId") !== required(evidence.market_id, "evidence.market_id")) {
      throw new Error("fee evidence market does not match");
    }
    if (required(input.conditionId, "conditionId") !== required(evidence.condition_id, "evidence.condition_id")) {
      throw new Error("fee evidence condition does not match");
    }
    const time = utc(input.executableTime, "executableTime");
    if (time < utc(evidence.effective_from, "effective_from") || time >= utc(evidence.effective_to, "effective_to")) {
      throw new Error("fee evidence is not effective at executableTime");
    }
    const price = Money.from(input.price);
    const quantity = Money.from(input.quantity);
    const rate = Money.from(evidence.fee_rate);
    const zero = Money.from("0");
    const one = Money.from("1");
    if (price.comparedTo(zero) < 0 || price.comparedTo(one) > 0) throw new Error("price must be between 0 and 1");
    if (!quantity.isPositive()) throw new Error("quantity must be positive");
    if (rate.comparedTo(zero) < 0) throw new Error("fee rate must not be negative");
    required(evidence.evidence_reference, "evidence_reference");

    if (input.liquidityRole === "MAKER") {
      return Object.freeze({
        amount: "0",
        verified: evidence.evidence_status === "VERIFIED",
        reasonCode: evidence.evidence_status === "UNVERIFIED" ? "UNVERIFIED_FEE_EVIDENCE" : null,
        evidenceReference: evidence.evidence_reference,
        feeRate: evidence.fee_rate,
        liquidityRole: input.liquidityRole,
      });
    }
    if (evidence.evidence_status === "MISSING") {
      return Object.freeze({
        amount: null, verified: false, reasonCode: "MISSING_FEE_EVIDENCE",
        evidenceReference: evidence.evidence_reference, feeRate: evidence.fee_rate,
        liquidityRole: input.liquidityRole,
      });
    }
    const raw = quantity.times(rate).times(price).times(one.minus(price));
    const rounded = roundFeeToFiveDecimals(raw);
    if (rounded.tie || rounded.value === null) {
      return Object.freeze({
        amount: null, verified: false, reasonCode: "ROUNDING_TIE_UNVERIFIED",
        evidenceReference: evidence.evidence_reference, feeRate: evidence.fee_rate,
        liquidityRole: input.liquidityRole,
      });
    }
    return Object.freeze({
      amount: rounded.value.toCanonical(),
      verified: evidence.evidence_status === "VERIFIED",
      reasonCode: evidence.evidence_status === "VERIFIED" ? null : "UNVERIFIED_FEE_EVIDENCE",
      evidenceReference: evidence.evidence_reference,
      feeRate: evidence.fee_rate,
      liquidityRole: input.liquidityRole,
    });
  }

  completeSet(input: CompleteSetInput): CompleteSetResult {
    const upAsk = Money.from(input.upAsk);
    const downAsk = Money.from(input.downAsk);
    const visible = minimumMoney(Money.from(input.upAskSize), Money.from(input.downAskSize));
    if (!visible.isPositive()) throw new Error("complete-set visible size must be positive");
    const upFee = this.quoteFee({
      marketId: input.marketId, conditionId: input.conditionId, executableTime: input.executableTime,
      liquidityRole: "TAKER", price: input.upAsk, quantity: visible.toCanonical(), evidence: input.evidence,
    });
    const downFee = this.quoteFee({
      marketId: input.marketId, conditionId: input.conditionId, executableTime: input.executableTime,
      liquidityRole: "TAKER", price: input.downAsk, quantity: visible.toCanonical(), evidence: input.evidence,
    });
    const gross = visible.times(Money.from("1").minus(upAsk).minus(downAsk));
    const scenarioNet = upFee.amount === null || downFee.amount === null
      ? null
      : gross.minus(Money.from(upFee.amount)).minus(Money.from(downFee.amount)).toCanonical();
    return Object.freeze({
      visibleSize: visible.toCanonical(),
      upFee,
      downFee,
      grossEdgeAmount: gross.toCanonical(),
      scenarioNetEdgeAmount: scenarioNet,
    });
  }
}
