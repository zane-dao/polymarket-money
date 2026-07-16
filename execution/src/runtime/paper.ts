import { Money } from "../domain/money.js";
import { canonicalDecimalString } from "../adapters/market-data/parsers.js";
import { FeeEdgeCalculator, type FeeScheduleEvidence } from "./fee-edge.js";

export type ObserverName =
  | "NO_TRADE"
  | "COMPLETE_SET_ARBITRAGE_OBSERVER"
  | "LEAD_LAG_OBSERVER"
  | "MAKER_ENVELOPE_OBSERVER";

export interface TopOfBookSide {
  readonly bid: string;
  readonly ask: string;
  readonly bidSize: string;
  readonly askSize: string;
}

export interface PaperSnapshot {
  readonly observedAt: string;
  readonly marketId: string;
  readonly up: TopOfBookSide;
  readonly down: TopOfBookSide;
  readonly chainlink: string | null;
  readonly binanceSpot: string | null;
  readonly binancePerpetual: string | null;
  readonly continuity: "UNVERIFIED";
}

export interface TheoreticalFill {
  readonly classification: "THEORETICAL_FILL";
  readonly token: "UP" | "DOWN";
  readonly side: "BUY";
  readonly price: string;
  readonly quantity: string;
  readonly observedAt: string;
}

export interface PaperAudit {
  readonly observer: ObserverName;
  readonly observedAt: string;
  readonly marketId: string;
  readonly orderSubmitted: false;
  readonly claimsRealProfit: false;
  readonly fills: readonly TheoreticalFill[];
  readonly executableQuantity: string;
  readonly grossEdge: string | null;
  readonly edgeAfterFees: string | null;
  readonly leggingRisk: "NONE_NO_TRADE" | "TWO_LEG_ATOMICITY_UNAVAILABLE" | "NOT_APPLICABLE";
  readonly queuePosition: null;
  readonly fillLowerBound: string | null;
  readonly fillUpperBound: string | null;
  readonly details: Readonly<Record<string, string | boolean | null>>;
}

const ZERO = Money.from("0");

function scenarioEvidence(snapshot: PaperSnapshot, feeRate: string): FeeScheduleEvidence {
  return Object.freeze({
    market_id: snapshot.marketId,
    condition_id: `scenario:${snapshot.marketId}`,
    effective_from: "1970-01-01T00:00:00.000Z",
    effective_to: "9999-12-31T23:59:59.999Z",
    fee_rate: feeRate,
    evidence_reference: "paper-scenario-input",
    evidence_status: "UNVERIFIED",
  });
}

function base(snapshot: PaperSnapshot, observer: ObserverName): Omit<PaperAudit, "fills" | "executableQuantity" | "grossEdge" | "edgeAfterFees" | "leggingRisk" | "fillLowerBound" | "fillUpperBound" | "details"> {
  return {
    observer,
    observedAt: snapshot.observedAt,
    marketId: snapshot.marketId,
    orderSubmitted: false,
    claimsRealProfit: false,
    queuePosition: null,
  };
}

function completeSetGrossEdge(snapshot: PaperSnapshot): string {
  const upSize = Money.from(canonicalDecimalString(snapshot.up.askSize));
  const downSize = Money.from(canonicalDecimalString(snapshot.down.askSize));
  const visible = upSize.comparedTo(downSize) <= 0 ? upSize : downSize;
  return visible.times(
    Money.from("1")
      .minus(Money.from(canonicalDecimalString(snapshot.up.ask)))
      .minus(Money.from(canonicalDecimalString(snapshot.down.ask))),
  ).toCanonical();
}

export function noTradeObserver(snapshot: PaperSnapshot): PaperAudit {
  return {
    ...base(snapshot, "NO_TRADE"),
    fills: [],
    executableQuantity: "0",
    grossEdge: null,
    edgeAfterFees: null,
    leggingRisk: "NONE_NO_TRADE",
    fillLowerBound: null,
    fillUpperBound: null,
    details: { reason: "EXPLICIT_NO_TRADE" },
  };
}

export function completeSetArbitrageObserver(
  snapshot: PaperSnapshot,
  options: {
    readonly feeRate: string | null;
    readonly latencyMilliseconds: number;
    readonly latencySatisfied: boolean;
  },
): PaperAudit {
  if (!Number.isSafeInteger(options.latencyMilliseconds) || options.latencyMilliseconds < 0) {
    throw new Error("latencyMilliseconds must be a non-negative safe integer");
  }
  if (options.feeRate === null) {
    return {
      ...base(snapshot, "COMPLETE_SET_ARBITRAGE_OBSERVER"),
      fills: [],
      executableQuantity: "0",
      grossEdge: completeSetGrossEdge(snapshot),
      edgeAfterFees: null,
      leggingRisk: "NOT_APPLICABLE",
      fillLowerBound: null,
      fillUpperBound: null,
      details: {
        feeRate: null,
        configuredLatencyMilliseconds: String(options.latencyMilliseconds),
        latencySatisfied: options.latencySatisfied,
        warning: "UNKNOWN_FEE_RATE_NO_EXECUTABLE_EDGE",
      },
    };
  }
  const result = new FeeEdgeCalculator().completeSet({
    marketId: snapshot.marketId,
    conditionId: `scenario:${snapshot.marketId}`,
    executableTime: snapshot.observedAt,
    upAsk: canonicalDecimalString(snapshot.up.ask),
    downAsk: canonicalDecimalString(snapshot.down.ask),
    upAskSize: canonicalDecimalString(snapshot.up.askSize),
    downAskSize: canonicalDecimalString(snapshot.down.askSize),
    evidence: scenarioEvidence(snapshot, options.feeRate),
  });
  const executable = result.scenarioNetEdgeAmount !== null
    && Money.from(result.scenarioNetEdgeAmount).isPositive()
    && options.latencySatisfied;
  return {
    ...base(snapshot, "COMPLETE_SET_ARBITRAGE_OBSERVER"),
    fills: executable
      ? [
          { classification: "THEORETICAL_FILL", token: "UP", side: "BUY", price: snapshot.up.ask, quantity: result.visibleSize, observedAt: snapshot.observedAt },
          { classification: "THEORETICAL_FILL", token: "DOWN", side: "BUY", price: snapshot.down.ask, quantity: result.visibleSize, observedAt: snapshot.observedAt },
        ]
      : [],
    executableQuantity: executable ? result.visibleSize : "0",
    grossEdge: result.grossEdgeAmount,
    edgeAfterFees: result.scenarioNetEdgeAmount,
    leggingRisk: executable ? "TWO_LEG_ATOMICITY_UNAVAILABLE" : "NOT_APPLICABLE",
    fillLowerBound: null,
    fillUpperBound: null,
    details: {
      feeRate: options.feeRate,
      configuredLatencyMilliseconds: String(options.latencyMilliseconds),
      latencySatisfied: options.latencySatisfied,
      warning: options.latencySatisfied
        ? "THEORETICAL_TWO_LEG_EXECUTION_NOT_ATOMIC"
        : "WAITING_FOR_ACTUAL_POST_LATENCY_QUOTE",
    },
  };
}

export function leadLagObserver(
  snapshot: PaperSnapshot,
  options: { readonly referenceChangeBps: string; readonly thresholdBps: string },
): PaperAudit {
  const detected = Money.from(options.referenceChangeBps).abs().comparedTo(Money.from(options.thresholdBps)) >= 0;
  return {
    ...base(snapshot, "LEAD_LAG_OBSERVER"),
    fills: [],
    executableQuantity: "0",
    grossEdge: null,
    edgeAfterFees: null,
    leggingRisk: "NOT_APPLICABLE",
    fillLowerBound: null,
    fillUpperBound: null,
    details: {
      detected,
      referenceChangeBps: options.referenceChangeBps,
      thresholdBps: options.thresholdBps,
      warning: "OBSERVER_ONLY_NO_FAIR_VALUE_ORDER",
    },
  };
}

export function makerEnvelopeObserver(
  snapshot: PaperSnapshot,
  options: { readonly markoutPrice: string | null },
): PaperAudit {
  const spread = Money.from(snapshot.up.ask).minus(Money.from(snapshot.up.bid));
  const markout = options.markoutPrice === null
    ? null
    : Money.from(options.markoutPrice).minus(Money.from(snapshot.up.bid)).toCanonical();
  return {
    ...base(snapshot, "MAKER_ENVELOPE_OBSERVER"),
    fills: [],
    executableQuantity: "0",
    grossEdge: spread.toCanonical(),
    edgeAfterFees: null,
    leggingRisk: "NOT_APPLICABLE",
    fillLowerBound: ZERO.toCanonical(),
    fillUpperBound: snapshot.up.askSize,
    details: {
      spread: spread.toCanonical(),
      markout,
      adverseSelection: markout === null ? null : ZERO.minus(Money.from(markout)).toCanonical(),
      warning: "NO_QUEUE_POSITION_OR_FILL_CLAIM",
    },
  };
}
