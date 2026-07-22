import assert from "node:assert/strict";
import test from "node:test";
import {
  PaperSimulationService,
  assertAutomatedPaperOrderRequestV2,
  type PaperMarketSnapshotV1,
  type PaperOrderRequestV1,
  type PaperOrderRequestV2,
  type PaperRiskConfigV1,
} from "../paper-simulation/index.js";

const NOW = "2026-07-21T10:00:00.000Z";
const risk: PaperRiskConfigV1 = {
  schemaVersion: "paper-risk-config-v1", maximumQuoteAgeMs: 1_000, minimumNetEdge: "0.02",
  maximumOrderNotional: "100", maximumMarketExposure: "150", maximumTotalExposure: "200",
};
const snapshot: PaperMarketSnapshotV1 = {
  schemaVersion: "paper-market-snapshot-v1", marketId: "btc-5m-1", observedAtUtc: "2026-07-21T09:59:59.800Z",
  receivedAtUtc: "2026-07-21T09:59:59.900Z", eligible: true,
  yesAsks: [{ price: "0.5", quantity: "4" }, { price: "0.51", quantity: "10" }],
  noAsks: [{ price: "0.48", quantity: "10" }],
};
function request(overrides: Partial<PaperOrderRequestV1> = {}): PaperOrderRequestV1 {
  return {
    schemaVersion: "paper-order-request-v1", idempotencyKey: "idem-1", clientOrderId: "client-1", marketId: "btc-5m-1",
    token: "YES", limitPrice: "0.51", quantity: "10", timeInForce: "GTC", expiresAtUtc: null,
    modelProbabilityYes: "0.7", feeRate: "0.01", ...overrides,
  };
}
function requestV2(overrides: Partial<PaperOrderRequestV2> = {}): PaperOrderRequestV2 {
  return {
    schemaVersion: "paper-order-request-v2", idempotencyKey: "idem-v2", clientOrderId: "client-v2", marketId: "btc-5m-1",
    token: "YES", limitPrice: "0.5", quantity: "2", timeInForce: "FAK", expiresAtUtc: null,
    modelProbabilityYes: "0.8",
    feeEvidence: {
      schemaVersion: "paper-fee-evidence-v1", model: "POLYMARKET_TAKER_CURVE_V1", conditionId: "condition-1",
      rate: "0.02", effectiveFromUtc: "2026-07-21T09:00:00.000Z", effectiveToUtc: "2026-07-21T11:00:00.000Z",
      evidenceStatus: "VERIFIED", evidenceReference: "offline-fixture:fee-v1",
    },
    ...overrides,
  };
}

test("paper service performs partial fills, idempotency, cancellation and recovery", () => {
  const service = new PaperSimulationService("1000", risk);
  const order = service.submit(request({ limitPrice: "0.5" }), snapshot, NOW);
  assert.equal(order.status, "PARTIALLY_FILLED"); assert.equal(order.filledQuantity, "4"); assert.equal(order.remainingQuantity, "6");
  assert.equal(service.listFills().length, 1); assert.equal(service.listPositions()[0]?.quantity, "4");
  assert.deepEqual(service.submit(request({ limitPrice: "0.5" }), snapshot, NOW), order);
  assert.throws(() => service.submit(request({ limitPrice: "0.49" }), snapshot, NOW), /idempotency key/);
  assert.equal(service.cancel(order.orderId, NOW, "USER_REQUEST").status, "CANCELLED");
  const restored = new PaperSimulationService("0", risk, service.exportState());
  assert.equal(restored.cash, service.cash); assert.deepEqual(restored.listFills(), service.listFills());
  assert.equal(restored.submit(request({ limitPrice: "0.5" }), snapshot, NOW).orderId, order.orderId);
});

test("paper service enforces eligibility, freshness, book, edge, cash and exposure risk", () => {
  const cases: readonly [string, PaperOrderRequestV1, PaperMarketSnapshotV1][] = [
    ["MARKET_NOT_ELIGIBLE", request(), { ...snapshot, eligible: false }],
    ["STALE_OR_FUTURE_QUOTE", request(), { ...snapshot, receivedAtUtc: "2026-07-21T09:59:00.000Z" }],
    ["EMPTY_ORDER_BOOK", request(), { ...snapshot, yesAsks: [] }],
    ["INSUFFICIENT_EDGE_AFTER_FEES", request({ modelProbabilityYes: "0.52" }), snapshot],
    ["ORDER_NOTIONAL_LIMIT", request({ quantity: "200" }), snapshot],
  ];
  for (const [index, [reason, input, book]] of cases.entries()) {
    const service = new PaperSimulationService("1000", risk);
    const result = service.submit({ ...input, idempotencyKey: `case-${index}` }, book, NOW);
    assert.equal(result.status, "REJECTED"); assert.equal(result.rejectionReason, reason);
  }
  const lowCash = new PaperSimulationService("1", risk);
  assert.equal(lowCash.submit(request(), snapshot, NOW).rejectionReason, "INSUFFICIENT_AVAILABLE_CASH");
  const tight = new PaperSimulationService("1000", { ...risk, maximumMarketExposure: "2" });
  assert.equal(tight.submit(request(), snapshot, NOW).rejectionReason, "MARKET_EXPOSURE_LIMIT");
});

test("supports NO direction, FOK/FAK, GTD expiry, repricing and kill switch", () => {
  const service = new PaperSimulationService("1000", risk);
  const fok = service.submit(request({ idempotencyKey: "fok", clientOrderId: "fok", timeInForce: "FOK", quantity: "50" }), snapshot, NOW);
  assert.equal(fok.status, "CANCELLED"); assert.equal(fok.filledQuantity, "0");
  const fak = service.submit(request({ idempotencyKey: "fak", clientOrderId: "fak", timeInForce: "FAK", limitPrice: "0.5", quantity: "8" }), snapshot, NOW);
  assert.equal(fak.status, "CANCELLED"); assert.equal(fak.filledQuantity, "4");
  const no = service.submit(request({ idempotencyKey: "no", clientOrderId: "no", token: "NO", modelProbabilityYes: "0.3", limitPrice: "0.47", quantity: "2" }), snapshot, NOW);
  assert.equal(no.status, "OPEN");
  const replacement = service.reprice(no.orderId, request({ idempotencyKey: "no-2", clientOrderId: "no-2", token: "NO", modelProbabilityYes: "0.3", limitPrice: "0.48", quantity: "2" }), snapshot, NOW);
  assert.equal(replacement.status, "FILLED"); assert.equal(service.listOrders().find((value) => value.orderId === no.orderId)?.status, "CANCELLED");
  const gtd = service.submit(request({ idempotencyKey: "gtd", clientOrderId: "gtd", limitPrice: "0.49", timeInForce: "GTD", expiresAtUtc: "2026-07-21T10:01:00.000Z" }), snapshot, NOW);
  assert.equal(gtd.status, "OPEN"); assert.equal(service.expire("2026-07-21T10:02:00.000Z")[0]?.status, "EXPIRED");
  service.setKillSwitch(true, NOW, "OPERATOR_STOP");
  assert.equal(service.submit(request({ idempotencyKey: "killed", clientOrderId: "killed" }), snapshot, NOW).rejectionReason, "KILL_SWITCH_ENABLED");
});

test("settlement is idempotent, pays winner, clears positions and records full audit events", () => {
  const service = new PaperSimulationService("100", risk);
  const filled = service.submit(request({ quantity: "2" }), snapshot, NOW); assert.equal(filled.status, "FILLED");
  const cashBeforeSettlement = Number(service.cash);
  const settlement = service.settle("btc-5m-1", "YES", "2026-07-21T10:05:00.000Z");
  assert.equal(settlement.payout, "2"); assert.equal(Number(service.cash), cashBeforeSettlement + 2); assert.equal(service.listPositions().length, 0);
  assert.deepEqual(service.settle("btc-5m-1", "YES", "2026-07-21T10:06:00.000Z"), settlement);
  assert.throws(() => service.settle("btc-5m-1", "NO", "2026-07-21T10:06:00.000Z"), /different outcome/);
  assert.deepEqual(service.listEvents().map((event) => event.sequence), service.listEvents().map((_, index) => index + 1));
  assert.ok(service.listEvents().some((event) => event.kind === "FILL")); assert.ok(service.listEvents().some((event) => event.kind === "SETTLEMENT"));
});

test("v2 uses the shared Polymarket fee curve for each executable price level and survives recovery", () => {
  const multiLevel: PaperMarketSnapshotV1 = {
    ...snapshot,
    yesAsks: [{ price: "0.4", quantity: "1" }, { price: "0.5", quantity: "1" }],
  };
  const service = new PaperSimulationService("100", risk);
  const input = requestV2();
  const result = service.submit(input, multiLevel, NOW);
  assert.equal(result.status, "FILLED");
  assert.deepEqual(service.listFills().map((fill) => [fill.price, fill.quantity, fill.fee]), [
    ["0.4", "1", "0.0048"],
    ["0.5", "1", "0.005"],
  ]);
  assert.equal(service.cash, "99.0902");
  const restored = new PaperSimulationService("0", risk, service.exportState());
  assert.deepEqual(restored.submit(input, multiLevel, NOW), result);
  assert.deepEqual(restored.listFills(), service.listFills());
  assert.equal(restored.cash, "99.0902");
});

test("v2 fails closed for rounding ties, missing evidence and evidence outside its effective interval", () => {
  const tie = requestV2({
    idempotencyKey: "tie", clientOrderId: "tie", quantity: "1",
    feeEvidence: { ...requestV2().feeEvidence, rate: "0.00002" },
  });
  const oneLevel = { ...snapshot, yesAsks: [{ price: "0.5", quantity: "1" }] };
  const tieResult = new PaperSimulationService("100", risk).submit(tie, oneLevel, NOW);
  assert.equal(tieResult.status, "REJECTED");
  assert.equal(tieResult.rejectionReason, "FEE_CALCULATION_UNAVAILABLE");

  const missing = requestV2({
    idempotencyKey: "missing", clientOrderId: "missing",
    feeEvidence: { ...requestV2().feeEvidence, evidenceStatus: "MISSING" },
  });
  assert.equal(new PaperSimulationService("100", risk).submit(missing, oneLevel, NOW).rejectionReason, "FEE_CALCULATION_UNAVAILABLE");

  const expired = requestV2({
    idempotencyKey: "expired-fee", clientOrderId: "expired-fee",
    feeEvidence: { ...requestV2().feeEvidence, effectiveToUtc: "2026-07-21T09:30:00.000Z" },
  });
  assert.equal(new PaperSimulationService("100", risk).submit(expired, oneLevel, NOW).rejectionReason, "FEE_CALCULATION_UNAVAILABLE");
});

test("v2 fee evidence and request reject unknown fields and invalid intervals", () => {
  const service = new PaperSimulationService("100", risk);
  assert.throws(() => service.submit({ ...requestV2(), unexpected: true } as PaperOrderRequestV2, snapshot, NOW), /fields are invalid/);
  assert.throws(() => service.submit({
    ...requestV2(), idempotencyKey: "bad-window", clientOrderId: "bad-window",
    feeEvidence: { ...requestV2().feeEvidence, effectiveFromUtc: "2026-07-21T11:00:00.000Z" },
  }, snapshot, NOW), /effective interval is empty/);
});

test("automated strategy boundary refuses the legacy linear-fee request", () => {
  assert.throws(() => assertAutomatedPaperOrderRequestV2(request()), /require paper-order-request-v2/);
  assert.doesNotThrow(() => assertAutomatedPaperOrderRequestV2(requestV2()));
});

test("resting v2 GTC rematches FIFO on later snapshots, shares depth and survives recovery", () => {
  const service = new PaperSimulationService("100", { ...risk, maximumQuoteAgeMs: 10_000 });
  const empty = { ...snapshot, yesAsks: [{ price: "0.6", quantity: "10" }] };
  const first = service.submit(requestV2({ idempotencyKey: "rest-1", clientOrderId: "rest-1", timeInForce: "GTC", quantity: "2" }), empty, NOW);
  const second = service.submit(requestV2({ idempotencyKey: "rest-2", clientOrderId: "rest-2", timeInForce: "GTC", quantity: "2" }), empty, NOW);
  assert.equal(first.status, "OPEN"); assert.equal(second.status, "OPEN");
  const restored = new PaperSimulationService("0", { ...risk, maximumQuoteAgeMs: 10_000 }, service.exportState());
  const later = {
    ...snapshot,
    observedAtUtc: "2026-07-21T10:00:00.900Z", receivedAtUtc: "2026-07-21T10:00:00.950Z",
    yesAsks: [{ price: "0.5", quantity: "3" }],
  };
  restored.onSnapshot(later, "2026-07-21T10:00:01.000Z");
  const orders = restored.listOrders();
  assert.equal(orders[0]?.status, "FILLED"); assert.equal(orders[0]?.filledQuantity, "2");
  assert.equal(orders[1]?.status, "PARTIALLY_FILLED"); assert.equal(orders[1]?.filledQuantity, "1");
  assert.deepEqual(restored.listFills().map((fill) => fill.quantity), ["2", "1"]);
  assert.equal(restored.idempotentReplay(requestV2({ idempotencyKey: "rest-2", clientOrderId: "rest-2", timeInForce: "GTC", quantity: "2" }))?.orderId, second.orderId);
});

test("snapshot rematch fails closed on stale fee evidence and GTD cannot execute at or after expiry", () => {
  const service = new PaperSimulationService("100", { ...risk, maximumQuoteAgeMs: 10_000 });
  const open = service.submit(requestV2({ idempotencyKey: "fee-window", clientOrderId: "fee-window", timeInForce: "GTC", quantity: "2" }), { ...snapshot, yesAsks: [{ price: "0.6", quantity: "10" }] }, NOW);
  assert.equal(open.status, "OPEN");
  service.onSnapshot({ ...snapshot, observedAtUtc: "2026-07-21T11:00:00.000Z", receivedAtUtc: "2026-07-21T11:00:00.000Z", yesAsks: [{ price: "0.5", quantity: "10" }] }, "2026-07-21T11:00:00.000Z");
  assert.equal(service.listOrders()[0]?.status, "OPEN"); assert.equal(service.listFills().length, 0);
  const expired = service.submit(requestV2({ idempotencyKey: "past-gtd", clientOrderId: "past-gtd", timeInForce: "GTD", expiresAtUtc: NOW }), snapshot, NOW);
  assert.equal(expired.status, "REJECTED"); assert.equal(expired.rejectionReason, "GTD_ALREADY_EXPIRED");
});
