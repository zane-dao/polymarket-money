import assert from "node:assert/strict";
import test from "node:test";

import { runStrategyFrames } from "../backtest/index.js";
import { DEFAULT_RISK_CONFIG } from "../risk/index.js";
import { StrategyRegistry, type Strategy, type StrategyInput } from "../../strategies/src/index.js";

const timestamps = {
  sourceTime: "2026-01-01T00:00:00.000Z",
  serverTime: null,
  receiveTime: "2026-01-01T00:00:00.010Z",
  processTime: "2026-01-01T00:00:00.020Z",
  persistTime: "2026-01-01T00:00:00.030Z",
} as const;

const input: StrategyInput = {
  strategyId: "hold",
  decisionId: "decision-1",
  processTime: timestamps.processTime,
  orderBook: {
    marketId: "market-1",
    tokenId: "token-up",
    bids: [{ price: "0.49", size: "10" }],
    asks: [{ price: "0.51", size: "10" }],
    sourceSequence: null,
    sourceHash: "fixture",
    timestamps,
  },
  positions: [],
  balances: [],
  openOrders: [],
  parameters: {},
};

const hold: Strategy = (value) => ({
  decisionId: value.decisionId,
  strategyId: value.strategyId,
  marketId: value.orderBook.marketId,
  tokenId: value.orderBook.tokenId,
  action: "hold",
  confidence: "1",
  reasonCodes: ["BACKTEST_FIXTURE"],
  timestamps: { ...value.orderBook.timestamps, processTime: value.processTime },
});

test("backend backtest invokes a registered independent strategy", () => {
  const registry = new StrategyRegistry();
  registry.register("hold", hold);
  const decisions = runStrategyFrames(registry, [{ strategyId: "hold", input }]);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.action, "hold");
  assert.equal(DEFAULT_RISK_CONFIG.requireUniqueIdempotencyKey, true);
});

test("backend backtest rejects mismatched strategy routing", () => {
  const registry = new StrategyRegistry();
  registry.register("hold", hold);
  assert.throws(
    () => runStrategyFrames(registry, [{ strategyId: "other", input }]),
    /disagrees/,
  );
});
