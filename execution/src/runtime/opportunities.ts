import { Money } from "../domain/money.js";
import { FeeEdgeCalculator, type FeeScheduleEvidence } from "./fee-edge.js";

/** Research-only opportunity records. This module never creates an OrderIntent. */
export type OpportunityFamily =
  | "COMPLETE_SET_ARBITRAGE"
  | "CROSS_VENUE_LEAD_LAG"
  | "MAKER_SPREAD_REBATE"
  | "FAIR_VALUE_MISPRICING";

export type EvidenceLevel =
  | "NOT_OBSERVED"
  | "OBSERVED_NOT_EXECUTABLE"
  | "REQUIRES_PRIVATE_FILL_EVIDENCE";

export interface OpportunityRecord {
  readonly opportunityId: string;
  readonly family: OpportunityFamily;
  readonly marketId: string;
  readonly startTime: string;
  readonly endTime: string | null;
  readonly durationMs: number | null;
  readonly marketState: Readonly<Record<string, string | number | boolean | null>>;
  readonly quotes: Readonly<Record<string, string | number | null>>;
  readonly feeRebateEvidence: string;
  readonly grossEdge: string | null;
  readonly scenarioNetEdge: string | null;
  readonly executableVisibleSize: string;
  readonly latencyAssumptionMs: number | null;
  readonly dataQuality: "PASS" | "DEGRADED" | "REJECTED";
  readonly continuity: "UNVERIFIED" | "CONTINUOUS" | "DISCONNECTED" | "STALE";
  readonly rejectionReason: string | null;
  readonly evidenceLevel: EvidenceLevel;
}

export interface OpportunityBook {
  readonly marketId: string;
  readonly observedAt: string;
  readonly upBid: string | null;
  readonly upAsk: string | null;
  readonly upBidSize: string | null;
  readonly upAskSize: string | null;
  readonly downBid: string | null;
  readonly downAsk: string | null;
  readonly downBidSize: string | null;
  readonly downAskSize: string | null;
  readonly continuity: "UNVERIFIED" | "CONTINUOUS" | "DISCONNECTED" | "STALE";
  readonly stale: boolean;
}

const nonNegative = (value: string | null): Money | null => {
  if (value === null) return null;
  try {
    const result = Money.from(value);
    return result.comparedTo(Money.from("0")) >= 0 ? result : null;
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
};

function scenarioEvidence(book: OpportunityBook, feeRate: string): FeeScheduleEvidence {
  return Object.freeze({
    market_id: book.marketId,
    condition_id: `scenario:${book.marketId}`,
    effective_from: "1970-01-01T00:00:00.000Z",
    effective_to: "9999-12-31T23:59:59.999Z",
    fee_rate: feeRate,
    evidence_reference: "opportunity-scenario-input",
    evidence_status: "UNVERIFIED",
  });
}

const id = (family: OpportunityFamily, book: OpportunityBook): string =>
  `${family}:${book.marketId}:${book.observedAt}`;

const rejected = (
  family: OpportunityFamily,
  book: OpportunityBook,
  reason: string,
): OpportunityRecord => ({
  opportunityId: id(family, book), family, marketId: book.marketId,
  startTime: book.observedAt, endTime: null, durationMs: null,
  marketState: { stale: book.stale },
  quotes: {}, feeRebateEvidence: "NOT_EVALUATED", grossEdge: null,
  scenarioNetEdge: null, executableVisibleSize: "0", latencyAssumptionMs: null,
  dataQuality: "REJECTED", continuity: book.continuity, rejectionReason: reason,
  evidenceLevel: "NOT_OBSERVED",
});

/** Detects a two-leg quote only when both sides have positive visible size. */
export function observeCompleteSet(book: OpportunityBook, feeRate: string | null): OpportunityRecord {
  const family = "COMPLETE_SET_ARBITRAGE" as const;
  if (book.stale || book.continuity === "DISCONNECTED" || book.continuity === "STALE") {
    return rejected(family, book, "STALE_OR_DISCONNECTED_BOOK");
  }
  const upAsk = nonNegative(book.upAsk), downAsk = nonNegative(book.downAsk);
  const upBid = nonNegative(book.upBid), downBid = nonNegative(book.downBid);
  const upAskSize = nonNegative(book.upAskSize), downAskSize = nonNegative(book.downAskSize);
  if (upAsk === null || downAsk === null || upAskSize === null || downAskSize === null || upAskSize.isZero() || downAskSize.isZero()) {
    return rejected(family, book, "MISSING_OR_EMPTY_ASK_SIDE");
  }
  const result = feeRate === null ? null : new FeeEdgeCalculator().completeSet({
    marketId: book.marketId,
    conditionId: `scenario:${book.marketId}`,
    executableTime: book.observedAt,
    upAsk: upAsk.toCanonical(),
    downAsk: downAsk.toCanonical(),
    upAskSize: upAskSize.toCanonical(),
    downAskSize: downAskSize.toCanonical(),
    evidence: scenarioEvidence(book, feeRate),
  });
  const candidate = result?.scenarioNetEdgeAmount !== null
    && result?.scenarioNetEdgeAmount !== undefined
    && Money.from(result.scenarioNetEdgeAmount).isPositive();
  return {
    opportunityId: id(family, book), family, marketId: book.marketId,
    startTime: book.observedAt, endTime: null, durationMs: null,
    marketState: { stale: false, sellQuoteAvailable: upBid !== null && downBid !== null },
    quotes: { upAsk: book.upAsk, downAsk: book.downAsk, upAskSize: book.upAskSize, downAskSize: book.downAskSize },
    feeRebateEvidence: result === null ? "UNKNOWN_FEE" : "SCENARIO_ONLY",
    grossEdge: result?.grossEdgeAmount ?? Money.from("1").minus(upAsk).minus(downAsk).toCanonical(),
    scenarioNetEdge: result?.scenarioNetEdgeAmount ?? null,
    executableVisibleSize: candidate ? result!.visibleSize : "0", latencyAssumptionMs: null,
    dataQuality: "PASS", continuity: book.continuity,
    rejectionReason: candidate ? null : (result === null ? "UNKNOWN_FEE" : "NO_POSITIVE_NET_EDGE"),
    // A single quote is an observation, never an aggregate route verdict.
    evidenceLevel: "OBSERVED_NOT_EXECUTABLE",
  };
}

export function observeMakerEnvelope(book: OpportunityBook): OpportunityRecord {
  const family = "MAKER_SPREAD_REBATE" as const;
  if (book.stale || book.continuity === "DISCONNECTED" || book.continuity === "STALE") return rejected(family, book, "STALE_OR_DISCONNECTED_BOOK");
  const bid = nonNegative(book.upBid), ask = nonNegative(book.upAsk), size = nonNegative(book.upAskSize);
  if (bid === null || ask === null || size === null || ask.comparedTo(bid) < 0) return rejected(family, book, "INVALID_OR_EMPTY_QUOTE");
  return {
    opportunityId: id(family, book), family, marketId: book.marketId,
    startTime: book.observedAt, endTime: null, durationMs: null,
    marketState: { queuePositionKnown: false }, quotes: { bid: book.upBid, ask: book.upAsk },
    feeRebateEvidence: "SCENARIO_ONLY", grossEdge: ask.minus(bid).toCanonical(), scenarioNetEdge: null,
    executableVisibleSize: "0", latencyAssumptionMs: null, dataQuality: "PASS", continuity: book.continuity,
    rejectionReason: "QUEUE_POSITION_UNKNOWN", evidenceLevel: "OBSERVED_NOT_EXECUTABLE",
  };
}
