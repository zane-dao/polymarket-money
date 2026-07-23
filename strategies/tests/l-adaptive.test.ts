import assert from "node:assert/strict";
import test from "node:test";

import { decideLAdaptiveV2 } from "../src/l-adaptive.js";

test("L V2 produces a deterministic target-position decision from explicit point-in-time inputs", () => {
  const result = decideLAdaptiveV2({
    currentPrice: "67030", openingPrice: "67000", remainingSeconds: "120", elapsedSeconds: "180",
    sigmaShort: "0.00008", sigmaMedium: "0.00006", sigmaLong: "0.00005",
    upBid: "0.54", upAsk: "0.55", upAskSize: "300", downBid: "0.44", downAsk: "0.45", downAskSize: "250",
    feeRate: "0.07", bankroll: "10000", maxSignalEdge: "0.25", maxStakeUsdc: "300", bookParticipation: "1",
  });
  assert.equal(result.action, "TARGET_POSITION");
  assert.equal(result.outcome, "UP");
  assert.ok(Number(result.probabilityUp) > 0.55);
  assert.ok(Number(result.targetPositionQuantity) > 0);
});

test("L V2 rejects an opening-anchor ambiguity and invalid books", () => {
  const base = {
    currentPrice: "67000", openingPrice: "67000", remainingSeconds: "120", elapsedSeconds: "180",
    sigmaShort: "0.00008", sigmaMedium: "0.00006", sigmaLong: "0.00005",
    upBid: "0.49", upAsk: "0.50", upAskSize: "100", downBid: "0.49", downAsk: "0.50", downAskSize: "100",
    feeRate: "0.07", bankroll: "10000", maxSignalEdge: "0.25", maxStakeUsdc: "300", bookParticipation: "1",
  };
  assert.equal(decideLAdaptiveV2(base).reason, "DYNAMIC_OPENING_ANCHOR_BAND");
  assert.equal(decideLAdaptiveV2({ ...base, currentPrice: "67120", upBid: "0.6", upAsk: "0.5" }).reason, "INVALID_DECISION_TOP_OF_BOOK");
});
