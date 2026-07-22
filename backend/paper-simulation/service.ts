import { Decimal } from "decimal.js";
import {
  FeeEdgeCalculator,
  type FeeScheduleEvidence,
} from "../core/src/runtime/fee-edge.js";

export type PaperToken = "YES" | "NO";
export type PaperTimeInForce = "GTC" | "GTD" | "FAK" | "FOK";
export type PaperOrderStatus = "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED" | "EXPIRED" | "REJECTED";

export type BookLevelV1 = Readonly<{ price: string; quantity: string }>;
export type PaperMarketSnapshotV1 = Readonly<{
  schemaVersion: "paper-market-snapshot-v1";
  marketId: string;
  observedAtUtc: string;
  receivedAtUtc: string;
  eligible: boolean;
  yesAsks: readonly BookLevelV1[];
  noAsks: readonly BookLevelV1[];
}>;

export type PaperOrderRequestV1 = Readonly<{
  schemaVersion: "paper-order-request-v1";
  idempotencyKey: string;
  clientOrderId: string;
  marketId: string;
  token: PaperToken;
  limitPrice: string;
  quantity: string;
  timeInForce: PaperTimeInForce;
  expiresAtUtc: string | null;
  modelProbabilityYes: string;
  feeRate: string;
}>;

export type PaperFeeEvidenceV1 = Readonly<{
  schemaVersion: "paper-fee-evidence-v1";
  model: "POLYMARKET_TAKER_CURVE_V1";
  conditionId: string;
  rate: string;
  effectiveFromUtc: string;
  effectiveToUtc: string;
  evidenceStatus: "VERIFIED" | "UNVERIFIED" | "MISSING";
  evidenceReference: string;
}>;

/**
 * Evidence-bound order contract for automated Paper strategies. V1 remains a
 * manual/backwards-compatible linear-fee contract and must not be used by an
 * automated strategy coordinator.
 */
export type PaperOrderRequestV2 = Readonly<{
  schemaVersion: "paper-order-request-v2";
  idempotencyKey: string;
  clientOrderId: string;
  marketId: string;
  token: PaperToken;
  limitPrice: string;
  quantity: string;
  timeInForce: PaperTimeInForce;
  expiresAtUtc: string | null;
  modelProbabilityYes: string;
  feeEvidence: PaperFeeEvidenceV1;
}>;

export type PaperOrderRequest = PaperOrderRequestV1 | PaperOrderRequestV2;

export function assertAutomatedPaperOrderRequestV2(
  request: PaperOrderRequest,
): asserts request is PaperOrderRequestV2 {
  if (request.schemaVersion !== "paper-order-request-v2") {
    throw new Error("automated Paper strategies require paper-order-request-v2 fee evidence");
  }
}

export type PaperRiskConfigV1 = Readonly<{
  schemaVersion: "paper-risk-config-v1";
  maximumQuoteAgeMs: number;
  minimumNetEdge: string;
  maximumOrderNotional: string;
  maximumMarketExposure: string;
  maximumTotalExposure: string;
}>;

export type PaperFillV1 = Readonly<{
  fillId: string;
  orderId: string;
  marketId: string;
  token: PaperToken;
  price: string;
  quantity: string;
  fee: string;
  filledAtUtc: string;
}>;

export type PaperOrderV1 = Readonly<{
  schemaVersion: "paper-order-v1";
  orderId: string;
  clientOrderId: string;
  idempotencyKey: string;
  marketId: string;
  token: PaperToken;
  limitPrice: string;
  quantity: string;
  filledQuantity: string;
  remainingQuantity: string;
  timeInForce: PaperTimeInForce;
  expiresAtUtc: string | null;
  status: PaperOrderStatus;
  rejectionReason: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
}>;

export type PaperEventKind = "RISK_REJECTED" | "ORDER_ACCEPTED" | "ORDER_CANCELLED" | "ORDER_EXPIRED" | "ORDER_REPRICED" | "FILL" | "SETTLEMENT" | "KILL_SWITCH";
export type PaperEventV1 = Readonly<{
  sequence: number;
  eventId: string;
  occurredAtUtc: string;
  kind: PaperEventKind;
  marketId: string | null;
  orderId: string | null;
  details: Readonly<Record<string, string | boolean | null>>;
}>;

export type PaperPositionV1 = Readonly<{ marketId: string; token: PaperToken; quantity: string; cost: string }>;
export type PaperSettlementV1 = Readonly<{ marketId: string; winningToken: PaperToken; payout: string; settledAtUtc: string }>;

export type PaperSimulationStateV1 = Readonly<{
  schemaVersion: "paper-simulation-state-v1";
  cash: string;
  killSwitchEnabled: boolean;
  nextOrderOrdinal: number;
  nextFillOrdinal: number;
  nextEventOrdinal: number;
  orders: readonly PaperOrderV1[];
  fills: readonly PaperFillV1[];
  positions: readonly PaperPositionV1[];
  settlements: readonly PaperSettlementV1[];
  events: readonly PaperEventV1[];
  idempotency: readonly Readonly<{ key: string; fingerprint: string; orderId: string }>[];
  /** Present for newly persisted sessions. Older v1 files may omit it and fail closed on rematch. */
  openOrderRequests?: readonly Readonly<{ orderId: string; request: PaperOrderRequest }>[];
}>;

type MutableOrder = { -readonly [K in keyof PaperOrderV1]: PaperOrderV1[K] };
type MutablePosition = { marketId: string; token: PaperToken; quantity: string; cost: string };

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const ZERO = new Decimal(0);

function decimal(value: string, field: string, options: { positive?: boolean; maxOne?: boolean } = {}): Decimal {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) throw new Error(`${field} must be a canonical non-negative decimal`);
  const result = new Decimal(value);
  if (options.positive === true && !result.gt(0)) throw new Error(`${field} must be positive`);
  if (options.maxOne === true && result.gt(1)) throw new Error(`${field} must be at most 1`);
  return result;
}

function canonical(value: Decimal): string { return value.toFixed(); }
function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(`${field} must be a UTC ISO 8601 timestamp`);
  return parsed;
}
function frozen<T extends object>(value: T): Readonly<T> { return Object.freeze({ ...value }); }

export class PaperSimulationService {
  readonly #feeCalculator = new FeeEdgeCalculator();
  readonly #risk: PaperRiskConfigV1;
  #cash: Decimal;
  #killSwitchEnabled = false;
  #nextOrderOrdinal = 0;
  #nextFillOrdinal = 0;
  #nextEventOrdinal = 0;
  readonly #orders = new Map<string, MutableOrder>();
  readonly #fills: PaperFillV1[] = [];
  readonly #positions = new Map<string, MutablePosition>();
  readonly #settlements = new Map<string, PaperSettlementV1>();
  readonly #events: PaperEventV1[] = [];
  readonly #idempotency = new Map<string, { fingerprint: string; orderId: string }>();
  readonly #orderRequests = new Map<string, PaperOrderRequest>();

  constructor(initialCash: string, risk: PaperRiskConfigV1, restored?: PaperSimulationStateV1) {
    this.#cash = decimal(initialCash, "initialCash");
    this.#risk = this.#validateRisk(risk);
    if (restored !== undefined) this.#restore(restored);
  }

  get cash(): string { return canonical(this.#cash); }
  get killSwitchEnabled(): boolean { return this.#killSwitchEnabled; }
  listOrders(): readonly PaperOrderV1[] { return Object.freeze([...this.#orders.values()].map((order) => frozen(order))); }
  listOpenOrders(): readonly PaperOrderV1[] { return Object.freeze(this.listOrders().filter((order) => order.status === "OPEN" || order.status === "PARTIALLY_FILLED")); }
  listFills(): readonly PaperFillV1[] { return Object.freeze([...this.#fills]); }
  listPositions(): readonly PaperPositionV1[] { return Object.freeze([...this.#positions.values()].map((position) => frozen(position))); }
  listEvents(): readonly PaperEventV1[] { return Object.freeze([...this.#events]); }
  listSettlements(): readonly PaperSettlementV1[] { return Object.freeze([...this.#settlements.values()]); }

  idempotentReplay(request: PaperOrderRequest): PaperOrderV1 | null {
    const replay = this.#idempotency.get(request.idempotencyKey);
    if (replay === undefined) return null;
    if (replay.fingerprint !== JSON.stringify(request)) throw new Error("idempotency key was reused with a different request");
    return this.#view(this.#requiredOrder(replay.orderId));
  }

  setKillSwitch(enabled: boolean, nowUtc: string, reason: string): void {
    timestamp(nowUtc, "nowUtc");
    if (reason.trim() === "") throw new Error("kill switch reason is required");
    this.#killSwitchEnabled = enabled;
    this.#event("KILL_SWITCH", nowUtc, null, null, { enabled, reason });
    if (enabled) for (const order of this.listOpenOrders()) this.cancel(order.orderId, nowUtc, "KILL_SWITCH");
  }

  submit(request: PaperOrderRequest, snapshot: PaperMarketSnapshotV1, nowUtc: string): PaperOrderV1 {
    const fingerprint = JSON.stringify(request);
    const replay = this.idempotentReplay(request);
    if (replay !== null) return replay;
    this.#validateRequest(request);
    this.#validateSnapshot(snapshot, request.marketId);
    const nowMs = timestamp(nowUtc, "nowUtc");
    const orderId = `paper-order-${++this.#nextOrderOrdinal}`;
    const order: MutableOrder = {
      schemaVersion: "paper-order-v1", orderId, clientOrderId: request.clientOrderId, idempotencyKey: request.idempotencyKey,
      marketId: request.marketId, token: request.token, limitPrice: request.limitPrice, quantity: request.quantity,
      filledQuantity: "0", remainingQuantity: request.quantity, timeInForce: request.timeInForce, expiresAtUtc: request.expiresAtUtc,
      status: "OPEN", rejectionReason: null, createdAtUtc: nowUtc, updatedAtUtc: nowUtc,
    };
    const rejection = this.#riskRejection(request, snapshot, nowMs);
    this.#orders.set(orderId, order);
    this.#idempotency.set(request.idempotencyKey, { fingerprint, orderId });
    this.#orderRequests.set(orderId, structuredClone(request));
    if (rejection !== null) {
      order.status = "REJECTED"; order.rejectionReason = rejection;
      this.#event("RISK_REJECTED", nowUtc, request.marketId, orderId, {
        reason: rejection, token: request.token, modelProbabilityYes: request.modelProbabilityYes,
        limitPrice: request.limitPrice, quantity: request.quantity,
        feeRate: this.#feeRate(request), feeModel: request.schemaVersion === "paper-order-request-v2" ? request.feeEvidence.model : "LINEAR_NOTIONAL_V1",
      });
      return this.#view(order);
    }
    const tokenProbability = request.token === "YES" ? new Decimal(request.modelProbabilityYes) : new Decimal(1).minus(request.modelProbabilityYes);
    this.#event("ORDER_ACCEPTED", nowUtc, request.marketId, orderId, {
      token: request.token, timeInForce: request.timeInForce, modelProbabilityYes: request.modelProbabilityYes,
      netEdge: canonical(tokenProbability.minus(request.limitPrice).minus(this.#feePerShare(request, request.limitPrice, request.quantity, nowUtc) ?? ZERO)),
      feeRate: this.#feeRate(request), feeModel: request.schemaVersion === "paper-order-request-v2" ? request.feeEvidence.model : "LINEAR_NOTIONAL_V1",
    });
    this.#match(order, request, snapshot, nowUtc);
    return this.#view(order);
  }

  cancel(orderId: string, nowUtc: string, reason: string): PaperOrderV1 {
    timestamp(nowUtc, "nowUtc");
    if (reason.trim() === "") throw new Error("cancel reason is required");
    const order = this.#requiredOrder(orderId);
    if (order.status === "OPEN" || order.status === "PARTIALLY_FILLED") {
      order.status = "CANCELLED"; order.updatedAtUtc = nowUtc;
      this.#event("ORDER_CANCELLED", nowUtc, order.marketId, orderId, { reason });
    }
    return this.#view(order);
  }

  reprice(orderId: string, replacement: PaperOrderRequest, snapshot: PaperMarketSnapshotV1, nowUtc: string): PaperOrderV1 {
    const old = this.#requiredOrder(orderId);
    if (old.status !== "OPEN" && old.status !== "PARTIALLY_FILLED") throw new Error("only an open order can be repriced");
    if (replacement.marketId !== old.marketId || replacement.token !== old.token) throw new Error("replacement market and token must match");
    this.cancel(orderId, nowUtc, "REPRICE");
    const next = this.submit(replacement, snapshot, nowUtc);
    this.#event("ORDER_REPRICED", nowUtc, old.marketId, next.orderId, { replacedOrderId: orderId });
    return next;
  }

  expire(nowUtc: string): readonly PaperOrderV1[] {
    const nowMs = timestamp(nowUtc, "nowUtc"); const expired: PaperOrderV1[] = [];
    for (const order of this.#orders.values()) {
      if ((order.status === "OPEN" || order.status === "PARTIALLY_FILLED") && order.expiresAtUtc !== null && timestamp(order.expiresAtUtc, "expiresAtUtc") <= nowMs) {
        order.status = "EXPIRED"; order.updatedAtUtc = nowUtc; expired.push(this.#view(order));
        this.#event("ORDER_EXPIRED", nowUtc, order.marketId, order.orderId, {});
      }
    }
    return Object.freeze(expired);
  }

  /**
   * Re-runs resting GTC/GTD orders against one new public snapshot. Orders are
   * processed FIFO and share/deplete the snapshot depth, so liquidity cannot
   * be counted twice. Unsafe, stale, ineligible, or fee-unverifiable snapshots
   * never execute an order.
   */
  onSnapshot(snapshot: PaperMarketSnapshotV1, nowUtc: string): readonly PaperOrderV1[] {
    this.#validateSnapshot(snapshot, snapshot.marketId);
    const nowMs = timestamp(nowUtc, "nowUtc");
    this.expire(nowUtc);
    if (this.#killSwitchEnabled) return Object.freeze([]);
    const books = {
      YES: snapshot.yesAsks.map((level) => ({ ...level })),
      NO: snapshot.noAsks.map((level) => ({ ...level })),
    };
    const changed: PaperOrderV1[] = [];
    for (const order of this.#orders.values()) {
      if (order.marketId !== snapshot.marketId || (order.status !== "OPEN" && order.status !== "PARTIALLY_FILLED")) continue;
      const request = this.#orderRequests.get(order.orderId);
      if (request === undefined) {
        changed.push(this.cancel(order.orderId, nowUtc, "RECOVERY_REQUEST_MISSING"));
        continue;
      }
      if (!this.#snapshotExecutable(request, snapshot, books[request.token], nowMs, order.remainingQuantity)) continue;
      const beforeFillCount = this.#fills.length;
      const beforeStatus = order.status;
      const beforeRemaining = order.remainingQuantity;
      const executableSnapshot: PaperMarketSnapshotV1 = Object.freeze({
        ...snapshot,
        yesAsks: request.token === "YES" ? books.YES : Object.freeze([]),
        noAsks: request.token === "NO" ? books.NO : Object.freeze([]),
      });
      this.#match(order, request, executableSnapshot, nowUtc);
      for (const fill of this.#fills.slice(beforeFillCount)) {
        const level = books[fill.token].find((candidate) => candidate.price === fill.price && new Decimal(candidate.quantity).gt(0));
        if (level !== undefined) level.quantity = canonical(new Decimal(level.quantity).minus(fill.quantity));
      }
      if (order.status !== beforeStatus || order.remainingQuantity !== beforeRemaining) changed.push(this.#view(order));
    }
    return Object.freeze(changed);
  }

  settle(marketId: string, winningToken: PaperToken, nowUtc: string): PaperSettlementV1 {
    timestamp(nowUtc, "nowUtc");
    const existing = this.#settlements.get(marketId); if (existing !== undefined) {
      if (existing.winningToken !== winningToken) throw new Error("market was already settled with a different outcome"); return existing;
    }
    for (const order of this.listOpenOrders().filter((value) => value.marketId === marketId)) this.cancel(order.orderId, nowUtc, "MARKET_SETTLED");
    let payout = ZERO;
    for (const token of ["YES", "NO"] as const) {
      const key = this.#positionKey(marketId, token); const position = this.#positions.get(key);
      if (position !== undefined) { if (token === winningToken) payout = payout.plus(position.quantity); this.#positions.delete(key); }
    }
    this.#cash = this.#cash.plus(payout);
    const result = frozen({ marketId, winningToken, payout: canonical(payout), settledAtUtc: nowUtc });
    this.#settlements.set(marketId, result);
    this.#event("SETTLEMENT", nowUtc, marketId, null, { winningToken, payout: result.payout });
    return result;
  }

  exportState(): PaperSimulationStateV1 {
    return frozen({
      schemaVersion: "paper-simulation-state-v1" as const, cash: this.cash, killSwitchEnabled: this.#killSwitchEnabled,
      nextOrderOrdinal: this.#nextOrderOrdinal, nextFillOrdinal: this.#nextFillOrdinal, nextEventOrdinal: this.#nextEventOrdinal,
      orders: this.listOrders(), fills: this.listFills(), positions: this.listPositions(), settlements: this.listSettlements(), events: this.listEvents(),
      idempotency: Object.freeze([...this.#idempotency].map(([key, value]) => frozen({ key, ...value }))),
      openOrderRequests: Object.freeze([...this.#orderRequests].map(([orderId, request]) => frozen({ orderId, request: structuredClone(request) }))),
    });
  }

  #validateRisk(risk: PaperRiskConfigV1): PaperRiskConfigV1 {
    if (risk.schemaVersion !== "paper-risk-config-v1") throw new Error("unsupported paper risk config");
    if (!Number.isSafeInteger(risk.maximumQuoteAgeMs) || risk.maximumQuoteAgeMs < 0) throw new Error("maximumQuoteAgeMs is invalid");
    decimal(risk.minimumNetEdge, "minimumNetEdge", { maxOne: true });
    decimal(risk.maximumOrderNotional, "maximumOrderNotional", { positive: true });
    decimal(risk.maximumMarketExposure, "maximumMarketExposure", { positive: true });
    decimal(risk.maximumTotalExposure, "maximumTotalExposure", { positive: true }); return frozen(risk);
  }
  #validateRequest(request: PaperOrderRequest): void {
    if (request.schemaVersion !== "paper-order-request-v1" && request.schemaVersion !== "paper-order-request-v2") throw new Error("unsupported paper order request");
    if (request.schemaVersion === "paper-order-request-v2"
      && Object.keys(request).sort().join(",") !== "clientOrderId,expiresAtUtc,feeEvidence,idempotencyKey,limitPrice,marketId,modelProbabilityYes,quantity,schemaVersion,timeInForce,token") {
      throw new Error("paper order request v2 fields are invalid");
    }
    for (const [field, value] of [["idempotencyKey", request.idempotencyKey], ["clientOrderId", request.clientOrderId], ["marketId", request.marketId]] as const) if (!SAFE_ID.test(value)) throw new Error(`${field} is invalid`);
    decimal(request.limitPrice, "limitPrice", { positive: true, maxOne: true }); decimal(request.quantity, "quantity", { positive: true });
    decimal(request.modelProbabilityYes, "modelProbabilityYes", { maxOne: true });
    if (request.schemaVersion === "paper-order-request-v1") decimal(request.feeRate, "feeRate", { maxOne: true });
    else this.#validateFeeEvidence(request.feeEvidence, request.marketId);
    if (request.timeInForce === "GTD") { if (request.expiresAtUtc === null) throw new Error("GTD requires expiresAtUtc"); timestamp(request.expiresAtUtc, "expiresAtUtc"); }
    else if (request.expiresAtUtc !== null) throw new Error("expiresAtUtc is only valid for GTD");
  }
  #validateSnapshot(snapshot: PaperMarketSnapshotV1, marketId: string): void {
    if (snapshot.schemaVersion !== "paper-market-snapshot-v1" || snapshot.marketId !== marketId) throw new Error("snapshot does not match the request market");
    timestamp(snapshot.observedAtUtc, "observedAtUtc"); timestamp(snapshot.receivedAtUtc, "receivedAtUtc");
    for (const level of [...snapshot.yesAsks, ...snapshot.noAsks]) { decimal(level.price, "book price", { positive: true, maxOne: true }); decimal(level.quantity, "book quantity", { positive: true }); }
  }
  #riskRejection(request: PaperOrderRequest, snapshot: PaperMarketSnapshotV1, nowMs: number): string | null {
    if (this.#killSwitchEnabled) return "KILL_SWITCH_ENABLED";
    if (request.timeInForce === "GTD" && request.expiresAtUtc !== null && timestamp(request.expiresAtUtc, "expiresAtUtc") <= nowMs) return "GTD_ALREADY_EXPIRED";
    if (!snapshot.eligible) return "MARKET_NOT_ELIGIBLE";
    const observedMs = timestamp(snapshot.observedAtUtc, "observedAtUtc");
    const receivedMs = timestamp(snapshot.receivedAtUtc, "receivedAtUtc");
    if (observedMs > receivedMs || receivedMs > nowMs || nowMs - observedMs > this.#risk.maximumQuoteAgeMs) return "STALE_OR_FUTURE_QUOTE";
    const levels = request.token === "YES" ? snapshot.yesAsks : snapshot.noAsks; if (levels.length === 0) return "EMPTY_ORDER_BOOK";
    if (this.#executionFeeUnavailable(request, levels, nowMs)) return "FEE_CALCULATION_UNAVAILABLE";
    const probability = request.token === "YES" ? decimal(request.modelProbabilityYes, "modelProbabilityYes") : new Decimal(1).minus(request.modelProbabilityYes);
    const feePerShare = this.#feePerShare(request, request.limitPrice, request.quantity, new Date(nowMs).toISOString());
    if (feePerShare === null) return "FEE_CALCULATION_UNAVAILABLE";
    const edge = probability.minus(request.limitPrice).minus(feePerShare);
    if (edge.lt(this.#risk.minimumNetEdge)) return "INSUFFICIENT_EDGE_AFTER_FEES";
    const notional = decimal(request.limitPrice, "limitPrice").times(request.quantity);
    if (notional.gt(this.#risk.maximumOrderNotional)) return "ORDER_NOTIONAL_LIMIT";
    const fee = this.#feeAmount(request, request.limitPrice, request.quantity, new Date(nowMs).toISOString());
    if (fee === null) return "FEE_CALCULATION_UNAVAILABLE";
    const cashRequired = notional.plus(fee);
    const committed = this.#committedNotional(); if (cashRequired.gt(this.#cash.minus(committed))) return "INSUFFICIENT_AVAILABLE_CASH";
    const marketExposure = this.#marketExposure(request.marketId).plus(this.#openExposure(request.marketId)).plus(notional);
    if (marketExposure.gt(this.#risk.maximumMarketExposure)) return "MARKET_EXPOSURE_LIMIT";
    if (this.#totalExposure().plus(this.#committedNotional()).plus(notional).gt(this.#risk.maximumTotalExposure)) return "TOTAL_EXPOSURE_LIMIT";
    return null;
  }
  #match(order: MutableOrder, request: PaperOrderRequest, snapshot: PaperMarketSnapshotV1, nowUtc: string): void {
    const levels = [...(request.token === "YES" ? snapshot.yesAsks : snapshot.noAsks)]
      .filter((level) => new Decimal(level.price).lte(request.limitPrice))
      .sort((left, right) => new Decimal(left.price).comparedTo(right.price));
    const available = levels.reduce((sum, level) => sum.plus(level.quantity), ZERO);
    const requested = new Decimal(order.remainingQuantity);
    if (request.timeInForce === "FOK" && available.lt(requested)) { order.status = "CANCELLED"; order.updatedAtUtc = nowUtc; this.#event("ORDER_CANCELLED", nowUtc, order.marketId, order.orderId, { reason: "FOK_NOT_FULLY_FILLABLE" }); return; }
    let remaining = requested;
    for (const level of levels) {
      if (!remaining.gt(0)) break;
      const quantity = Decimal.min(remaining, new Decimal(level.quantity));
      const cost = quantity.times(level.price); const fee = this.#feeAmount(request, level.price, canonical(quantity), nowUtc);
      if (fee === null) throw new Error("fee calculation became unavailable after risk validation");
      if (cost.plus(fee).gt(this.#cash)) break;
      this.#cash = this.#cash.minus(cost).minus(fee); remaining = remaining.minus(quantity);
      const fill = frozen({ fillId: `paper-fill-${++this.#nextFillOrdinal}`, orderId: order.orderId, marketId: order.marketId, token: order.token, price: level.price, quantity: canonical(quantity), fee: canonical(fee), filledAtUtc: nowUtc });
      this.#fills.push(fill); this.#addPosition(order.marketId, order.token, quantity, cost.plus(fee));
      this.#event("FILL", nowUtc, order.marketId, order.orderId, { fillId: fill.fillId, price: fill.price, quantity: fill.quantity, fee: fill.fee });
    }
    order.filledQuantity = canonical(new Decimal(order.filledQuantity).plus(requested.minus(remaining))); order.remainingQuantity = canonical(remaining); order.updatedAtUtc = nowUtc;
    if (remaining.eq(0)) order.status = "FILLED";
    else if (request.timeInForce === "FAK" || request.timeInForce === "FOK") { order.status = "CANCELLED"; this.#event("ORDER_CANCELLED", nowUtc, order.marketId, order.orderId, { reason: "IMMEDIATE_REMAINDER_CANCELLED" }); }
    else order.status = remaining.eq(requested) ? "OPEN" : "PARTIALLY_FILLED";
  }
  #addPosition(marketId: string, token: PaperToken, quantity: Decimal, cost: Decimal): void {
    const key = this.#positionKey(marketId, token); const current = this.#positions.get(key);
    this.#positions.set(key, { marketId, token, quantity: canonical(quantity.plus(current?.quantity ?? 0)), cost: canonical(cost.plus(current?.cost ?? 0)) });
  }
  #positionKey(marketId: string, token: PaperToken): string { return `${marketId}:${token}`; }
  #marketExposure(marketId: string): Decimal { return [...this.#positions.values()].filter((p) => p.marketId === marketId).reduce((sum, p) => sum.plus(p.cost), ZERO); }
  #totalExposure(): Decimal { return [...this.#positions.values()].reduce((sum, p) => sum.plus(p.cost), ZERO); }
  #openExposure(marketId: string): Decimal { return this.listOpenOrders().filter((o) => o.marketId === marketId).reduce((sum, o) => sum.plus(new Decimal(o.limitPrice).times(o.remainingQuantity)), ZERO); }
  #committedNotional(): Decimal { return this.listOpenOrders().reduce((sum, o) => sum.plus(new Decimal(o.limitPrice).times(o.remainingQuantity)), ZERO); }

  #validateFeeEvidence(value: PaperFeeEvidenceV1, marketId: string): void {
    if (value === null || typeof value !== "object" || value.schemaVersion !== "paper-fee-evidence-v1"
      || value.model !== "POLYMARKET_TAKER_CURVE_V1" || !SAFE_ID.test(value.conditionId)
      || value.evidenceReference.trim() === "" || !["VERIFIED", "UNVERIFIED", "MISSING"].includes(value.evidenceStatus)) {
      throw new Error("paper fee evidence is invalid");
    }
    if (Object.keys(value).sort().join(",") !== "conditionId,effectiveFromUtc,effectiveToUtc,evidenceReference,evidenceStatus,model,rate,schemaVersion") {
      throw new Error("paper fee evidence fields are invalid");
    }
    decimal(value.rate, "feeEvidence.rate", { maxOne: true });
    const start = timestamp(value.effectiveFromUtc, "feeEvidence.effectiveFromUtc");
    const end = timestamp(value.effectiveToUtc, "feeEvidence.effectiveToUtc");
    if (start >= end) throw new Error("paper fee evidence effective interval is empty");
    if (!SAFE_ID.test(marketId)) throw new Error("fee evidence market is invalid");
  }

  #feeSchedule(request: PaperOrderRequestV2): FeeScheduleEvidence {
    return Object.freeze({
      market_id: request.marketId,
      condition_id: request.feeEvidence.conditionId,
      effective_from: request.feeEvidence.effectiveFromUtc,
      effective_to: request.feeEvidence.effectiveToUtc,
      fee_rate: request.feeEvidence.rate,
      evidence_reference: request.feeEvidence.evidenceReference,
      evidence_status: request.feeEvidence.evidenceStatus,
    });
  }

  #feeRate(request: PaperOrderRequest): string {
    return request.schemaVersion === "paper-order-request-v1" ? request.feeRate : request.feeEvidence.rate;
  }

  #feeAmount(request: PaperOrderRequest, price: string, quantity: string, executableTime: string): Decimal | null {
    if (request.schemaVersion === "paper-order-request-v1") return new Decimal(price).times(quantity).times(request.feeRate);
    try {
      const quote = this.#feeCalculator.quoteFee({
        marketId: request.marketId,
        conditionId: request.feeEvidence.conditionId,
        executableTime,
        liquidityRole: "TAKER",
        price,
        quantity,
        evidence: this.#feeSchedule(request),
      });
      return quote.amount === null ? null : new Decimal(quote.amount);
    } catch {
      return null;
    }
  }

  #feePerShare(request: PaperOrderRequest, price: string, quantity: string, executableTime: string): Decimal | null {
    const fee = this.#feeAmount(request, price, quantity, executableTime);
    return fee === null ? null : fee.dividedBy(quantity);
  }

  #executionFeeUnavailable(request: PaperOrderRequest, levels: readonly BookLevelV1[], nowMs: number): boolean {
    if (request.schemaVersion === "paper-order-request-v1") return false;
    let remaining = new Decimal(request.quantity);
    const executableTime = new Date(nowMs).toISOString();
    for (const level of levels.filter((value) => new Decimal(value.price).lte(request.limitPrice)).sort((a, b) => new Decimal(a.price).comparedTo(b.price))) {
      if (!remaining.gt(0)) break;
      const quantity = Decimal.min(remaining, level.quantity);
      if (this.#feeAmount(request, level.price, canonical(quantity), executableTime) === null) return true;
      remaining = remaining.minus(quantity);
    }
    return false;
  }
  #snapshotExecutable(request: PaperOrderRequest, snapshot: PaperMarketSnapshotV1, levels: readonly BookLevelV1[], nowMs: number, quantity: string): boolean {
    if (!snapshot.eligible || levels.length === 0) return false;
    const observedMs = timestamp(snapshot.observedAtUtc, "observedAtUtc");
    const receivedMs = timestamp(snapshot.receivedAtUtc, "receivedAtUtc");
    if (observedMs > receivedMs || receivedMs > nowMs || nowMs - observedMs > this.#risk.maximumQuoteAgeMs) return false;
    return !this.#executionFeeUnavailable({ ...request, quantity }, levels, nowMs);
  }
  #requiredOrder(orderId: string): MutableOrder { const order = this.#orders.get(orderId); if (order === undefined) throw new Error(`unknown paper order: ${orderId}`); return order; }
  #view(order: MutableOrder): PaperOrderV1 { return frozen(order); }
  #event(kind: PaperEventKind, occurredAtUtc: string, marketId: string | null, orderId: string | null, details: Record<string, string | boolean | null>): void {
    const sequence = ++this.#nextEventOrdinal; this.#events.push(frozen({ sequence, eventId: `paper-event-${sequence}`, occurredAtUtc, kind, marketId, orderId, details: frozen(details) }));
  }
  #restore(state: PaperSimulationStateV1): void {
    if (state.schemaVersion !== "paper-simulation-state-v1") throw new Error("unsupported paper simulation state");
    this.#cash = decimal(state.cash, "state.cash"); this.#killSwitchEnabled = state.killSwitchEnabled;
    this.#nextOrderOrdinal = state.nextOrderOrdinal; this.#nextFillOrdinal = state.nextFillOrdinal; this.#nextEventOrdinal = state.nextEventOrdinal;
    for (const order of state.orders) this.#orders.set(order.orderId, { ...order });
    this.#fills.push(...state.fills); for (const position of state.positions) this.#positions.set(this.#positionKey(position.marketId, position.token), { ...position });
    for (const settlement of state.settlements) this.#settlements.set(settlement.marketId, settlement); this.#events.push(...state.events);
    for (const value of state.idempotency) this.#idempotency.set(value.key, { fingerprint: value.fingerprint, orderId: value.orderId });
    for (const value of state.openOrderRequests ?? []) {
      if (this.#orders.has(value.orderId)) this.#orderRequests.set(value.orderId, structuredClone(value.request));
    }
  }
}
