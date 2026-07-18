import assert from "node:assert/strict";
import test from "node:test";

import type { PublicBtcFiveMinuteMarket } from "../../execution/src/adapters/market-data/public-sources.js";
import { createKJStrategyContext } from "../../execution/src/strategy/kj-context.js";
import type { ReceiveStamp } from "../../execution/src/domain/receive-time.js";

function stamp(wall: string, ns: string, ordinal: string): ReceiveStamp {
  return {
    schemaVersion: "receive-stamp-v1",
    clockDomain: "runtime-1",
    localWallReceiveTime: wall,
    localMonotonicReceiveNs: ns,
    localReceiveOrdinal: ordinal,
  };
}

const market: PublicBtcFiveMinuteMarket = {
  marketId: "market-1",
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

function validInput() {
  return {
    decisionTime: "2026-07-17T00:04:30.000Z",
    market,
    book: {
      state: "ACTIVE_UNVERIFIED",
      continuity: "UNVERIFIED",
      up: { bid: "0.44", ask: "0.45", bidSize: "10", askSize: "11" },
      down: { bid: "0.54", ask: "0.55", bidSize: "12", askSize: "13" },
      receiveStamp: stamp("2026-07-17T00:04:29.500Z", "100", "1"),
    },
    signal: {
      provider: "BINANCE_SPOT" as const,
      price: "60000.12",
      sourceTime: "2026-07-17T00:04:29.000Z",
      serverTime: null,
      receiveTime: "2026-07-17T00:04:29.600Z",
      receiveStamp: stamp("2026-07-17T00:04:29.600Z", "101", "2"),
      connectionId: "spot-1",
      inputHash: "b".repeat(64),
    },
  };
}

test("K/J StrategyContext binds verified outcome tokens, clocks, fee, and paper-only safety", () => {
  const result = createKJStrategyContext(validInput());
  if (!result.ready) throw new Error(result.reason);
  assert.equal(result.ready, true);
  assert.equal(result.context.market.upTokenId, "111");
  assert.equal(result.context.book.down.tokenId, "222");
  assert.equal(result.context.feeEvidence.rate, "0.07");
  assert.equal(result.context.inputWatermark.localReceiveOrdinal, "2");
  assert.equal(result.context.safety.liveTradingEnabled, false);
  assert.equal(result.context.safety.orderSubmissionAvailable, false);
  assert.equal(Object.isFrozen(result.context), true);
});

test("K/J StrategyContext preserves a public Chainlink relay as a distinct signal source", () => {
  const result = createKJStrategyContext({
    ...validInput(),
    signal: {
      ...validInput().signal,
      provider: "POLYMARKET_RTDS_CHAINLINK",
      connectionId: "chainlink-1",
      inputHash: "c".repeat(64),
    },
  });
  if (!result.ready) throw new Error(result.reason);
  assert.equal(result.context.signal.provider, "POLYMARKET_RTDS_CHAINLINK");
  assert.equal(result.context.signal.connectionId, "chainlink-1");
});

test("K/J StrategyContext fails closed for missing fee, stale book, crossed book, and future signal", () => {
  const missingFee = createKJStrategyContext({
    ...validInput(),
    market: { ...market, takerFeeRate: null },
  });
  assert.equal(missingFee.ready, false);
  if (missingFee.ready) throw new Error("expected missing fee failure");
  assert.match(missingFee.reason, /fee evidence is missing/u);

  const stale = createKJStrategyContext({
    ...validInput(),
    book: {
      ...validInput().book,
      receiveStamp: stamp("2026-07-17T00:04:20.000Z", "100", "1"),
    },
  });
  assert.equal(stale.ready, false);
  if (stale.ready) throw new Error("expected stale failure");
  assert.match(stale.reason, /book is stale/u);

  const crossed = createKJStrategyContext({
    ...validInput(),
    book: { ...validInput().book, up: { ...validInput().book.up, bid: "0.46" } },
  });
  assert.equal(crossed.ready, false);
  if (crossed.ready) throw new Error("expected crossed failure");
  assert.match(crossed.reason, /crossed/u);

  const future = createKJStrategyContext({
    ...validInput(),
    signal: { ...validInput().signal, sourceTime: "2026-07-17T00:04:31.000Z" },
  });
  assert.equal(future.ready, false);
  if (future.ready) throw new Error("expected future failure");
  assert.match(future.reason, /sourceTime is from the future/u);
});

test("K/J StrategyContext refuses mixed receive clock domains and non-running markets", () => {
  const mixed = createKJStrategyContext({
    ...validInput(),
    signal: {
      ...validInput().signal,
      receiveStamp: {
        ...validInput().signal.receiveStamp,
        clockDomain: "other-runtime",
      },
    },
  });
  assert.equal(mixed.ready, false);
  if (mixed.ready) throw new Error("expected mixed clock failure");
  assert.match(mixed.reason, /different clock domains/u);

  const closed = createKJStrategyContext({
    ...validInput(),
    market: { ...market, closed: true, collectible: false },
  });
  assert.equal(closed.ready, false);
  if (closed.ready) throw new Error("expected closed market failure");
  assert.match(closed.reason, /not publicly collectible/u);
});
