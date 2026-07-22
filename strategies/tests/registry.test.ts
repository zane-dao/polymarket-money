import assert from "node:assert/strict";
import test from "node:test";

import { StrategyRegistry, type Strategy } from "../src/index.js";

const hold: Strategy = (input) => ({
  decisionId: input.decisionId,
  strategyId: input.strategyId,
  marketId: input.orderBook.marketId,
  tokenId: input.orderBook.tokenId,
  action: "hold",
  confidence: "1",
  reasonCodes: ["DETERMINISTIC_HOLD"],
  timestamps: { ...input.orderBook.timestamps, processTime: input.processTime },
});

test("strategy registry adds one implementation without changing consumers", () => {
  const registry = new StrategyRegistry();
  registry.register("hold", hold);
  assert.deepEqual(registry.list(), ["hold"]);
  assert.equal(registry.resolve("hold"), hold);
});

test("strategy registry rejects duplicate and unknown identifiers", () => {
  const registry = new StrategyRegistry();
  registry.register("hold", hold);
  assert.throws(() => registry.register("hold", hold), /already registered/);
  assert.throws(() => registry.resolve("missing"), /unknown strategy/);
});
