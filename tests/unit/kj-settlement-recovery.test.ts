import assert from "node:assert/strict";
import test from "node:test";

import type { PublicBtcFiveMinuteMarket } from "../../execution/src/adapters/market-data/public-sources.js";
import { selectKJSettlementRecoveryMarkets } from "../../execution/src/product/kj-settlement-recovery.js";

function market(start: string): PublicBtcFiveMinuteMarket {
  const epoch = Date.parse(start) / 1_000;
  return {
    marketId: String(epoch),
    conditionId: `0x${"a".repeat(64)}`,
    slug: `btc-updown-5m-${epoch}`,
    intervalStart: start,
    intervalEnd: new Date(Date.parse(start) + 300_000).toISOString(),
    upTokenId: "1",
    downTokenId: "2",
    active: false,
    closed: false,
    acceptingOrders: false,
    collectible: true,
    takerFeeRate: "0.07",
    rawPayload: "{}",
  };
}

test("settlement recovery selects only ended markets inside the frozen target window", () => {
  const markets = [
    market("2026-07-17T11:55:00.000Z"),
    market("2026-07-17T12:00:00.000Z"),
    market("2026-07-17T12:05:00.000Z"),
    market("2026-07-17T12:10:00.000Z"),
  ];
  const selected = selectKJSettlementRecoveryMarkets(
    markets,
    "2026-07-17T12:00:00.000Z",
    "2026-07-17T12:10:00.000Z",
    "2026-07-17T12:10:01.000Z",
  );
  assert.deepEqual(selected.map((item) => item.intervalStart), [
    "2026-07-17T12:00:00.000Z",
    "2026-07-17T12:05:00.000Z",
  ]);
  assert.throws(() => selectKJSettlementRecoveryMarkets(
    markets,
    "2026-07-17T12:10:00.000Z",
    "2026-07-17T12:10:00.000Z",
    "2026-07-17T12:15:01.000Z",
  ), /non-empty/u);
});
