import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { PublicBtcFiveMinuteMarket } from "../../backend/core/src/adapters/market-data/public-sources.js";
import {
  createKJOfficialSettlementFromGamma,
  GAMMA_RESOLUTION_ADAPTER_VERSION,
} from "../../backend/core/src/adapters/settlement/gamma-resolution.js";

const root = new URL("../../../", import.meta.url);

function expectedMarket(): PublicBtcFiveMinuteMarket {
  return {
    marketId: "golden-market-1",
    conditionId: `0x${"a".repeat(64)}`,
    slug: "btc-updown-5m-1784246400",
    intervalStart: "2026-07-17T00:00:00.000Z",
    intervalEnd: "2026-07-17T00:05:00.000Z",
    upTokenId: "111",
    downTokenId: "222",
    active: true,
    closed: false,
    acceptingOrders: true,
    collectible: true,
    takerFeeRate: "0.07",
    rawPayload: "{}",
  };
}

async function rawFixture(): Promise<string> {
  return readFile(new URL("data/fixtures/batch-06/gamma-resolved-market.json", root), "utf8");
}

test("frozen official Gamma response creates identity-bound K/J settlement evidence", async () => {
  const rawPayload = await rawFixture();
  const settlement = createKJOfficialSettlementFromGamma({
    expectedMarket: expectedMarket(),
    responseStatus: 200,
    rawPayload,
    receiveTime: "2026-07-17T00:05:53.000Z",
  });
  assert.equal(GAMMA_RESOLUTION_ADAPTER_VERSION, "gamma-resolution-adapter-v1");
  assert.equal(settlement.marketId, "golden-market-1");
  assert.equal(settlement.winner, "UP");
  assert.equal(settlement.evidenceStatus, "OFFICIAL_RESOLUTION");
  assert.match(settlement.evidenceReference, /^gamma-market-by-slug:.*:sha256:[0-9a-f]{64}$/u);
  assert.match(settlement.settlementId, /^[0-9a-f]{64}$/u);

  const downPayload = JSON.stringify({
    ...JSON.parse(rawPayload),
    outcomePrices: '["0", "1"]',
  });
  const down = createKJOfficialSettlementFromGamma({
    expectedMarket: expectedMarket(),
    responseStatus: 200,
    rawPayload: downPayload,
    receiveTime: "2026-07-17T00:05:53.000Z",
  });
  assert.equal(down.winner, "DOWN");
  assert.notEqual(down.settlementId, settlement.settlementId);
});

test("Gamma settlement fails closed on premature, unresolved, ambiguous, and mismatched evidence", async () => {
  const rawPayload = await rawFixture();
  const base = JSON.parse(rawPayload) as Record<string, unknown>;
  const input = (payload: Record<string, unknown>, receiveTime = "2026-07-17T00:05:53.000Z") => ({
    expectedMarket: expectedMarket(),
    responseStatus: 200,
    rawPayload: JSON.stringify(payload),
    receiveTime,
  });
  assert.throws(
    () => createKJOfficialSettlementFromGamma(input(base, "2026-07-17T00:05:00.000Z")),
    /must arrive after market end/u,
  );
  assert.throws(
    () => createKJOfficialSettlementFromGamma(input({ ...base, umaResolutionStatus: "proposed" })),
    /status is not resolved yet/u,
  );
  assert.throws(
    () => createKJOfficialSettlementFromGamma(input({ ...base, outcomePrices: '["0.99", "0.01"]' })),
    /exact zero or one/u,
  );
  assert.throws(
    () => createKJOfficialSettlementFromGamma(input({ ...base, clobTokenIds: '["222", "111"]' })),
    /expected market upTokenId|outcome\/token mapping conflicts/u,
  );
  assert.throws(
    () => createKJOfficialSettlementFromGamma(input({ ...base, closed: false })),
    /not closed yet/u,
  );
  assert.throws(
    () => createKJOfficialSettlementFromGamma({ ...input(base), responseStatus: 503 }),
    /not HTTP 200 yet/u,
  );
});
