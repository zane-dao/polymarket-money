import assert from "node:assert/strict";
import test from "node:test";

import {
  completeSetArbitrageObserver,
  leadLagObserver,
  makerEnvelopeObserver,
  noTradeObserver,
  type PaperSnapshot,
} from "../../execution/src/runtime/paper.js";

const snapshot: PaperSnapshot = Object.freeze({
  observedAt: "2026-07-16T00:00:00.000Z",
  marketId: "market-1",
  up: { bid: "0.47", ask: "0.48", bidSize: "3", askSize: "2" },
  down: { bid: "0.49", ask: "0.50", bidSize: "4", askSize: "1.5" },
  chainlink: "60000",
  binanceSpot: "60001",
  binancePerpetual: "60002",
  continuity: "UNVERIFIED",
});

test("complete-set observer reports executable edge and theoretical fills only", () => {
  const audit = completeSetArbitrageObserver(snapshot, {
    feeRate: "0",
    latencyMilliseconds: 1_000,
    latencySatisfied: true,
  });
  assert.equal(audit.grossEdge, "0.03");
  assert.equal(audit.observer, "COMPLETE_SET_ARBITRAGE_OBSERVER");
  assert.equal(audit.executableQuantity, "1.5");
  assert.equal(audit.fills.length, 2);
  assert.ok(audit.fills.every((fill) => fill.classification === "THEORETICAL_FILL"));
  assert.equal(audit.claimsRealProfit, false);
});

test("complete-set observer fails closed when the public market fee is unknown", () => {
  const audit = completeSetArbitrageObserver(snapshot, {
    feeRate: null,
    latencyMilliseconds: 1_000,
    latencySatisfied: true,
  });
  assert.equal(audit.edgeAfterFees, null);
  assert.equal(audit.grossEdge, "0.03");
  assert.equal(audit.executableQuantity, "0");
  assert.deepEqual(audit.fills, []);
  assert.equal(audit.details.warning, "UNKNOWN_FEE_RATE_NO_EXECUTABLE_EDGE");
});

test("taker observer cannot create a theoretical fill before observed latency elapses", () => {
  const audit = completeSetArbitrageObserver(snapshot, {
    feeRate: "0",
    latencyMilliseconds: 1_000,
    latencySatisfied: false,
  });
  assert.deepEqual(audit.fills, []);
  assert.equal(audit.executableQuantity, "0");
  assert.equal(audit.details.warning, "WAITING_FOR_ACTUAL_POST_LATENCY_QUOTE");
});

test("maker observer never fabricates a fill or queue position", () => {
  const audit = makerEnvelopeObserver(snapshot, { markoutPrice: "0.46" });
  assert.equal(audit.observer, "MAKER_ENVELOPE_OBSERVER");
  assert.deepEqual(audit.fills, []);
  assert.equal(audit.queuePosition, null);
  assert.equal(audit.fillLowerBound, "0");
  assert.equal(audit.fillUpperBound, "2");
});

test("no-trade and lead-lag are observers without live orders", () => {
  assert.deepEqual(noTradeObserver(snapshot).fills, []);
  const leadLag = leadLagObserver(snapshot, { referenceChangeBps: "8", thresholdBps: "5" });
  assert.equal(leadLag.observer, "LEAD_LAG_OBSERVER");
  assert.deepEqual(leadLag.fills, []);
  assert.equal(leadLag.orderSubmitted, false);
});
