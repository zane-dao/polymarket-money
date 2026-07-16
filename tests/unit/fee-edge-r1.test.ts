import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Decimal } from "decimal.js";
import {
  FeeEdgeCalculator,
  type FeeScheduleEvidence,
} from "../../execution/src/runtime/fee-edge.js";
import { canonicalMoney, MONEY_DECIMAL_CONTRACT_VERSION } from "../../execution/src/domain/money.js";

const root = new URL("../../../", import.meta.url);
const fixture = JSON.parse(await readFile(
  new URL("data/fixtures/batch-4b-r1/fee-edge-v1.json", root),
  "utf8",
)) as {
  schedule: FeeScheduleEvidence;
  fee_cases: Array<{ name: string; role: "TAKER" | "MAKER"; price: string; quantity: string; fee_rate?: string; amount: string | null; reason: string | null }>;
  complete_set: {
    up_ask: string;
    down_ask: string;
    up_size: string;
    down_size: string;
    visible_size: string;
    up_fee: string;
    down_fee: string;
    gross_edge_amount: string;
    scenario_net_edge_amount: string;
  };
};

test("MoneyDecimal rejects Number, exponent notation, non-finite values, and non-canonical strings", () => {
  assert.equal(MONEY_DECIMAL_CONTRACT_VERSION, "money-decimal-v1");
  assert.equal(canonicalMoney("0.5"), "0.5");
  for (const invalid of [0.5, "5e-1", "NaN", "Infinity", "-0", "0.50", ".5"]) {
    assert.throws(() => canonicalMoney(invalid as never), /canonical|number|finite/i, String(invalid));
  }
});

test("private Decimal clone is isolated from mutations to the global Decimal configuration", () => {
  const calculator = new FeeEdgeCalculator();
  const original = {
    precision: Decimal.precision,
    rounding: Decimal.rounding,
    toExpNeg: Decimal.toExpNeg,
    toExpPos: Decimal.toExpPos,
  };
  const before = calculator.quoteFee({
    marketId: fixture.schedule.market_id,
    conditionId: fixture.schedule.condition_id,
    executableTime: "2026-07-16T12:00:00.000Z",
    liquidityRole: "TAKER",
    price: "0.47",
    quantity: "1",
    evidence: fixture.schedule,
  });
  try {
    Decimal.set({ precision: 2, rounding: Decimal.ROUND_UP, toExpNeg: 0, toExpPos: 1 });
    const after = calculator.quoteFee({
      marketId: fixture.schedule.market_id,
      conditionId: fixture.schedule.condition_id,
      executableTime: "2026-07-16T12:00:00.000Z",
      liquidityRole: "TAKER",
      price: "0.47",
      quantity: "1",
      evidence: fixture.schedule,
    });
    assert.deepEqual(after, before);
  } finally {
    Decimal.set(original);
  }
});

test("official fee representatives, fractional size, minimum precision, and exact tie match fixture", () => {
  const calculator = new FeeEdgeCalculator();
  for (const item of fixture.fee_cases) {
    const evidence = item.fee_rate === undefined
      ? fixture.schedule
      : { ...fixture.schedule, fee_rate: item.fee_rate };
    const result = calculator.quoteFee({
      marketId: fixture.schedule.market_id,
      conditionId: fixture.schedule.condition_id,
      executableTime: "2026-07-16T12:00:00.000Z",
      liquidityRole: item.role,
      price: item.price,
      quantity: item.quantity,
      evidence,
    });
    assert.equal(result.amount, item.amount, item.name);
    assert.equal(result.reasonCode, item.reason, item.name);
  }
});

test("complete-set charges each leg through the same calculator", () => {
  const result = new FeeEdgeCalculator().completeSet({
    marketId: fixture.schedule.market_id,
    conditionId: fixture.schedule.condition_id,
    executableTime: "2026-07-16T12:00:00.000Z",
    upAsk: fixture.complete_set.up_ask,
    downAsk: fixture.complete_set.down_ask,
    upAskSize: fixture.complete_set.up_size,
    downAskSize: fixture.complete_set.down_size,
    evidence: fixture.schedule,
  });
  assert.equal(result.visibleSize, fixture.complete_set.visible_size);
  assert.equal(result.upFee.amount, fixture.complete_set.up_fee);
  assert.equal(result.downFee.amount, fixture.complete_set.down_fee);
  assert.equal(result.grossEdgeAmount, fixture.complete_set.gross_edge_amount);
  assert.equal(result.scenarioNetEdgeAmount, fixture.complete_set.scenario_net_edge_amount);
});
