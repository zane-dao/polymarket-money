import assert from "node:assert/strict";
import test from "node:test";

import { classifyClobBookObservation } from "../../backend/core/src/runtime/clob-book-observation.js";

test("only a successfully applied book mutation may refresh the lead-lag book age", () => {
  assert.equal(classifyClobBookObservation({
    eventTypes: ["book"], parserStatus: "parsed", bookMutationApplied: true,
  }), "REFRESH");
  assert.equal(classifyClobBookObservation({
    eventTypes: ["price_change"], parserStatus: "parsed", bookMutationApplied: true,
  }), "REFRESH");
  for (const eventType of ["last_trade_price", "tick_size_change", "new_market", "market_resolved", "best_bid_ask"]) {
    assert.equal(classifyClobBookObservation({
      eventTypes: [eventType], parserStatus: "parsed", bookMutationApplied: false,
    }), "IGNORE", eventType);
  }
  assert.equal(classifyClobBookObservation({
    eventTypes: ["book"], parserStatus: "quarantined", bookMutationApplied: false,
  }), "INVALIDATE");
  assert.equal(classifyClobBookObservation({
    eventTypes: ["unknown"], parserStatus: "unparsed", bookMutationApplied: false,
  }), "IGNORE");
});
