import assert from "node:assert/strict";
import test from "node:test";
import { observeCompleteSet, observeMakerEnvelope, type OpportunityBook } from "../../execution/src/runtime/opportunities.js";

const book: OpportunityBook = {
  marketId: "m1", observedAt: "2026-07-16T00:00:00.000Z",
  upBid: "0.45", upAsk: "0.47", upBidSize: "2", upAskSize: "2",
  downBid: "0.48", downAsk: "0.49", downBidSize: "3", downAskSize: "1",
  continuity: "UNVERIFIED", stale: false,
};

test("complete-set record uses common visible size and never claims atomic risk-free execution", () => {
  const result = observeCompleteSet(book, "0");
  assert.equal(result.family, "COMPLETE_SET_ARBITRAGE");
  assert.equal(result.executableVisibleSize, "1");
  assert.equal(result.evidenceLevel, "OBSERVED_NOT_EXECUTABLE");
  assert.notEqual(result.evidenceLevel, "RESEARCH_CANDIDATE");
  assert.equal(result.feeRebateEvidence, "SCENARIO_ONLY");
});

test("unknown fees and stale books fail closed", () => {
  const unknownFee = observeCompleteSet({ ...book, downAskSize: "2" }, null);
  assert.equal(unknownFee.executableVisibleSize, "0");
  assert.equal(unknownFee.grossEdge, "0.08");
  assert.equal(unknownFee.scenarioNetEdge, null);
  assert.equal(unknownFee.rejectionReason, "UNKNOWN_FEE");
  assert.equal(observeCompleteSet({ ...book, stale: true }, "0").rejectionReason, "STALE_OR_DISCONNECTED_BOOK");
});

test("maker envelope has no fill or queue claim", () => {
  const result = observeMakerEnvelope(book);
  assert.equal(result.executableVisibleSize, "0");
  assert.equal(result.evidenceLevel, "OBSERVED_NOT_EXECUTABLE");
  assert.equal(result.rejectionReason, "QUEUE_POSITION_UNKNOWN");
});
