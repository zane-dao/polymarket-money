import type {
  Balance,
  Order,
  Position,
  RiskDecision,
  SignalDecision,
  Timestamp,
  DecimalString,
} from "../domain/index.js";
import { Money, minimumMoney } from "../domain/money.js";

export interface RiskConfig {
  readonly maxOrderAmountUsd: DecimalString;
  readonly maxPositionPerMarketTokens: DecimalString;
  readonly maxDailyLossUsd: DecimalString;
  readonly maxSlippageBps: DecimalString;
  readonly maxOpenOrders: number;
  readonly maxDataAgeMs: number;
  readonly maxWebSocketDisconnectMs: number;
  readonly requireUniqueIdempotencyKey: boolean;
}

export const DEFAULT_RISK_CONFIG: Readonly<RiskConfig> = Object.freeze({
  maxOrderAmountUsd: "100",
  maxPositionPerMarketTokens: "500",
  maxDailyLossUsd: "100",
  maxSlippageBps: "100",
  maxOpenOrders: 10,
  maxDataAgeMs: 5_000,
  maxWebSocketDisconnectMs: 10_000,
  requireUniqueIdempotencyKey: true,
});

export interface RiskContext {
  readonly processTime: Timestamp;
  readonly dataReceiveTime: Timestamp;
  readonly webSocketConnected: boolean;
  readonly webSocketLastReceiveTime: Timestamp;
  readonly dailyPnlUsd: DecimalString;
  readonly positions: readonly Position[];
  readonly balances: readonly Balance[];
  readonly openOrders: readonly Order[];
  readonly observedIdempotencyKeys: ReadonlySet<string>;
}

export interface RiskEngine {
  evaluate(
    signal: Readonly<SignalDecision>,
    context: Readonly<RiskContext>,
    config: Readonly<RiskConfig>,
  ): Readonly<RiskDecision>;
}

/**
 * A strategy expresses the total position it wants to hold, not an order size.
 * The execution layer supplies already-held and resting quantity, then this
 * deterministic review produces the only order quantity it may submit.
 *
 * This contract intentionally has no vendor, storage, or order-side dependency:
 * it is shared by paper execution now and can be reused by replay/backtest.
 */
export type TargetPositionReviewInputV1 = Readonly<{
  requestedTargetQuantity: string;
  currentPositionQuantity: string;
  openOrderQuantity: string;
  executablePrice: string;
  maximumFillPrice: string;
  feeRate: string;
  visibleAskQuantity: string;
  bookParticipation: string;
  availableCash: string;
  currentMarketNotional: string;
  currentTotalNotional: string;
  maximumOrderNotional: string;
  maximumMarketNotional: string;
  maximumTotalNotional: string;
}>;

export type TargetPositionReviewV1 = Readonly<{
  schemaVersion: "target-position-review-v1";
  status: "APPROVED" | "REDUCED" | "REJECTED";
  requestedTargetQuantity: string;
  coveredQuantity: string;
  requestedOrderQuantity: string;
  approvedOrderQuantity: string;
  estimatedAveragePrice: string;
  estimatedFee: string;
  reservedAmount: string;
  reasonCodes: readonly string[];
}>;

const ZERO = Money.from("0");
const ONE = Money.from("1");

function nonNegative(value: string, field: string): Money {
  const parsed = Money.from(value);
  if (parsed.comparedTo(ZERO) < 0) throw new Error(`${field} must not be negative`);
  return parsed;
}

function positive(value: string, field: string): Money {
  const parsed = Money.from(value);
  if (!parsed.isPositive()) throw new Error(`${field} must be positive`);
  return parsed;
}

/**
 * Applies order-book, cash, per-order, per-market and total-exposure caps in
 * one place. A missing or exhausted capacity rejects the target; a binding cap
 * returns REDUCED instead of silently changing the order.
 */
export function reviewTargetPositionV1(input: TargetPositionReviewInputV1): TargetPositionReviewV1 {
  const requestedTarget = nonNegative(input.requestedTargetQuantity, "requestedTargetQuantity");
  const current = nonNegative(input.currentPositionQuantity, "currentPositionQuantity");
  const open = nonNegative(input.openOrderQuantity, "openOrderQuantity");
  const executablePrice = positive(input.executablePrice, "executablePrice");
  const maximumFillPrice = positive(input.maximumFillPrice, "maximumFillPrice");
  if (maximumFillPrice.comparedTo(executablePrice) < 0) throw new Error("maximumFillPrice must cover executablePrice");
  const feeRate = nonNegative(input.feeRate, "feeRate");
  const visible = nonNegative(input.visibleAskQuantity, "visibleAskQuantity");
  const participation = positive(input.bookParticipation, "bookParticipation");
  if (participation.comparedTo(ONE) > 0) throw new Error("bookParticipation must not exceed one");
  const availableCash = nonNegative(input.availableCash, "availableCash");
  const currentMarket = nonNegative(input.currentMarketNotional, "currentMarketNotional");
  const currentTotal = nonNegative(input.currentTotalNotional, "currentTotalNotional");
  const maximumOrder = positive(input.maximumOrderNotional, "maximumOrderNotional");
  const maximumMarket = positive(input.maximumMarketNotional, "maximumMarketNotional");
  const maximumTotal = positive(input.maximumTotalNotional, "maximumTotalNotional");

  const covered = current.plus(open);
  const requestedOrder = requestedTarget.comparedTo(covered) > 0 ? requestedTarget.minus(covered) : ZERO;
  const details = (status: TargetPositionReviewV1["status"], approved: Money, reasons: readonly string[]): TargetPositionReviewV1 => {
    const estimatedFee = feeRate.times(maximumFillPrice).times(ONE.minus(maximumFillPrice)).times(approved);
    return Object.freeze({
      schemaVersion: "target-position-review-v1",
      status,
      requestedTargetQuantity: requestedTarget.toCanonical(),
      coveredQuantity: covered.toCanonical(),
      requestedOrderQuantity: requestedOrder.toCanonical(),
      approvedOrderQuantity: approved.toCanonical(),
      // Current K/J input contains the executable best ask and visible size only.
      // It must not claim a multi-level VWAP that has not been observed.
      estimatedAveragePrice: executablePrice.toCanonical(),
      estimatedFee: estimatedFee.toCanonical(),
      reservedAmount: maximumFillPrice.times(approved).plus(estimatedFee).toCanonical(),
      reasonCodes: Object.freeze([...reasons]),
    });
  };
  if (!requestedOrder.isPositive()) return details("REJECTED", ZERO, ["TARGET_ALREADY_COVERED"]);

  const orderCap = maximumOrder.dividedBy(maximumFillPrice);
  const marketRoom = maximumMarket.minus(currentMarket);
  const totalRoom = maximumTotal.minus(currentTotal);
  if (!marketRoom.isPositive()) return details("REJECTED", ZERO, ["MARKET_EXPOSURE_LIMIT"]);
  if (!totalRoom.isPositive()) return details("REJECTED", ZERO, ["TOTAL_EXPOSURE_LIMIT"]);
  const marketCap = marketRoom.dividedBy(maximumFillPrice);
  const totalCap = totalRoom.dividedBy(maximumFillPrice);
  const bookCap = visible.times(participation);
  const feePerShare = feeRate.times(maximumFillPrice).times(ONE.minus(maximumFillPrice));
  const cashCap = availableCash.dividedBy(maximumFillPrice.plus(feePerShare));
  const approved = minimumMoney(
    minimumMoney(minimumMoney(minimumMoney(requestedOrder, orderCap), marketCap), totalCap),
    minimumMoney(bookCap, cashCap),
  );
  if (!approved.isPositive()) return details("REJECTED", ZERO, ["NO_EXECUTABLE_CAPACITY"]);
  const reasons: string[] = [];
  if (approved.comparedTo(requestedOrder) < 0) {
    if (orderCap.comparedTo(requestedOrder) < 0) reasons.push("ORDER_NOTIONAL_LIMIT");
    if (marketCap.comparedTo(requestedOrder) < 0) reasons.push("MARKET_EXPOSURE_LIMIT");
    if (totalCap.comparedTo(requestedOrder) < 0) reasons.push("TOTAL_EXPOSURE_LIMIT");
    if (bookCap.comparedTo(requestedOrder) < 0) reasons.push("VISIBLE_DEPTH_LIMIT");
    if (cashCap.comparedTo(requestedOrder) < 0) reasons.push("AVAILABLE_CASH_LIMIT");
  }
  return details(reasons.length === 0 ? "APPROVED" : "REDUCED", approved, reasons.length === 0 ? ["RISK_APPROVED"] : reasons);
}
