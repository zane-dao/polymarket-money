/** Research-only opportunity records. This module never creates an OrderIntent. */
export type OpportunityFamily =
  | "COMPLETE_SET_ARBITRAGE"
  | "CROSS_VENUE_LEAD_LAG"
  | "MAKER_SPREAD_REBATE"
  | "FAIR_VALUE_MISPRICING";

export type EvidenceLevel =
  | "NOT_OBSERVED"
  | "OBSERVED_NOT_EXECUTABLE"
  | "RESEARCH_CANDIDATE"
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

const positive = (value: string | null): number | null => {
  if (value === null || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
};

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
  const upAsk = positive(book.upAsk), downAsk = positive(book.downAsk);
  const upBid = positive(book.upBid), downBid = positive(book.downBid);
  const upAskSize = positive(book.upAskSize), downAskSize = positive(book.downAskSize);
  if (upAsk === null || downAsk === null || upAskSize === null || downAskSize === null || upAskSize === 0 || downAskSize === 0) {
    return rejected(family, book, "MISSING_OR_EMPTY_ASK_SIDE");
  }
  const visible = Math.min(upAskSize, downAskSize);
  const gross = 1 - upAsk - downAsk;
  const fee = feeRate === null ? null : positive(feeRate);
  const net = fee === null ? null : gross - fee * (upAsk * (1 - upAsk) + downAsk * (1 - downAsk));
  const candidate = net !== null && net > 0;
  return {
    opportunityId: id(family, book), family, marketId: book.marketId,
    startTime: book.observedAt, endTime: null, durationMs: null,
    marketState: { stale: false, sellQuoteAvailable: upBid !== null && downBid !== null },
    quotes: { upAsk: book.upAsk, downAsk: book.downAsk, upAskSize: book.upAskSize, downAskSize: book.downAskSize },
    feeRebateEvidence: fee === null ? "UNKNOWN_FEE" : "SCENARIO_ONLY",
    grossEdge: gross.toFixed(8), scenarioNetEdge: net === null ? null : net.toFixed(8),
    executableVisibleSize: candidate ? String(visible) : "0", latencyAssumptionMs: null,
    dataQuality: "PASS", continuity: book.continuity,
    rejectionReason: candidate ? null : (fee === null ? "UNKNOWN_FEE" : "NO_POSITIVE_NET_EDGE"),
    evidenceLevel: candidate ? "RESEARCH_CANDIDATE" : "OBSERVED_NOT_EXECUTABLE",
  };
}

export function observeMakerEnvelope(book: OpportunityBook): OpportunityRecord {
  const family = "MAKER_SPREAD_REBATE" as const;
  if (book.stale || book.continuity === "DISCONNECTED" || book.continuity === "STALE") return rejected(family, book, "STALE_OR_DISCONNECTED_BOOK");
  const bid = positive(book.upBid), ask = positive(book.upAsk), size = positive(book.upAskSize);
  if (bid === null || ask === null || size === null || ask < bid) return rejected(family, book, "INVALID_OR_EMPTY_QUOTE");
  return {
    opportunityId: id(family, book), family, marketId: book.marketId,
    startTime: book.observedAt, endTime: null, durationMs: null,
    marketState: { queuePositionKnown: false }, quotes: { bid: book.upBid, ask: book.upAsk },
    feeRebateEvidence: "SCENARIO_ONLY", grossEdge: (ask - bid).toFixed(8), scenarioNetEdge: null,
    executableVisibleSize: "0", latencyAssumptionMs: null, dataQuality: "PASS", continuity: book.continuity,
    rejectionReason: "QUEUE_POSITION_UNKNOWN", evidenceLevel: "OBSERVED_NOT_EXECUTABLE",
  };
}
