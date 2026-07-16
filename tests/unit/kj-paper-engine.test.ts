import assert from "node:assert/strict";
import test from "node:test";

import type { PublicBtcFiveMinuteMarket } from "../../execution/src/adapters/market-data/public-sources.js";
import type { ReceiveStamp } from "../../execution/src/domain/receive-time.js";
import {
  KJPaperEngine,
  type KJOfficialSettlement,
} from "../../execution/src/runtime/kj-paper-engine.js";
import { createKJStrategyContext, type KJStrategyContextV1 } from "../../execution/src/strategy/kj-context.js";

const START = Date.parse("2026-07-17T00:00:00.000Z");

function iso(offsetSeconds: number): string {
  return new Date(START + offsetSeconds * 1_000).toISOString();
}

function market(index = 1): PublicBtcFiveMinuteMarket {
  const start = START + (index - 1) * 300_000;
  return {
    marketId: `market-${index}`,
    conditionId: `0x${String(index).repeat(64)}`,
    slug: `btc-updown-5m-${Math.floor(start / 1_000)}`,
    intervalStart: new Date(start).toISOString(),
    intervalEnd: new Date(start + 300_000).toISOString(),
    upTokenId: `${index}11`,
    downTokenId: `${index}22`,
    active: true,
    closed: false,
    acceptingOrders: true,
    collectible: true,
    takerFeeRate: "0.07",
    rawPayload: "{}",
  };
}

function stamp(at: string, ordinal: number): ReceiveStamp {
  return {
    schemaVersion: "receive-stamp-v1",
    clockDomain: "paper-runtime-1",
    localWallReceiveTime: at,
    localMonotonicReceiveNs: String(ordinal * 1_000),
    localReceiveOrdinal: String(ordinal),
  };
}

function context(
  offsetSeconds: number,
  price: string,
  ordinal: number,
  selectedMarket = market(1),
  book: Readonly<{
    upAsk?: string;
    upAskSize?: string;
    downAsk?: string;
    downAskSize?: string;
  }> = {},
): KJStrategyContextV1 {
  const decisionTime = iso(offsetSeconds);
  const result = createKJStrategyContext({
    decisionTime,
    market: selectedMarket,
    book: {
      state: "ACTIVE_UNVERIFIED",
      continuity: "UNVERIFIED",
      up: {
        bid: "0.79",
        ask: book.upAsk ?? "0.8",
        bidSize: "1000",
        askSize: book.upAskSize ?? "1000",
      },
      down: {
        bid: "0.19",
        ask: book.downAsk ?? "0.2",
        bidSize: "1000",
        askSize: book.downAskSize ?? "1000",
      },
      receiveStamp: stamp(decisionTime, ordinal * 2 - 1),
    },
    signal: {
      provider: "BINANCE_SPOT",
      price,
      sourceTime: decisionTime,
      serverTime: null,
      receiveTime: decisionTime,
      receiveStamp: stamp(decisionTime, ordinal * 2),
      connectionId: "spot-1",
      inputHash: ordinal.toString(16).padStart(64, "0"),
    },
  });
  if (!result.ready) throw new Error(result.reason);
  return result.context;
}

function warmEngine(engine: KJPaperEngine): void {
  assert.equal(engine.ingest(context(0, "100", 1)), true);
  for (let offset = 5, ordinal = 2; offset < 180; offset += 5, ordinal += 1) {
    const price = offset % 10 === 0 ? "100.1" : "99.9";
    engine.ingest(context(offset, price, ordinal));
  }
}

test("paper engine freezes intents, reserves cash, fills once, and deduplicates contexts", () => {
  const engine = new KJPaperEngine();
  warmEngine(engine);
  const decision = context(185, "110", 40);
  assert.equal(engine.ingest(decision), true);
  assert.equal(engine.ingest(decision), false);

  const jReserved = engine.wallet("J_FEE_AWARE");
  const kReserved = engine.wallet("K_DUAL_VOL");
  assert.equal(jReserved.cash, "10000");
  assert.equal(kReserved.cash, "10000");
  assert.ok(Number(jReserved.available) < 10000);
  assert.ok(Number(kReserved.available) < 10000);

  engine.ingest(context(186, "110", 41, market(1), { upAsk: "0.81", upAskSize: "2" }));
  assert.ok(Number(engine.position("J_FEE_AWARE", "111")) > 0);
  assert.ok(Number(engine.position("K_DUAL_VOL", "111")) > 0);
  assert.ok(Number(engine.wallet("J_FEE_AWARE").cash) < 10000);
  assert.equal(
    engine.events().filter((event) => event.eventType === "FILL").length,
    2,
  );
  const fills = engine.events().filter((event) => event.eventType === "FILL");
  assert.ok(fills.every((fill) =>
    Number(fill.details.quantity) <= Number(fill.details.intendedQuantity)));
  assert.ok(fills.every((fill) => fill.details.partial === true));
});

test("slippage no-fill and market transition release every paper reservation", () => {
  const slippage = new KJPaperEngine();
  warmEngine(slippage);
  slippage.ingest(context(185, "110", 40));
  slippage.ingest(context(186, "110", 41, market(1), { upAsk: "0.82" }));
  assert.equal(slippage.wallet("J_FEE_AWARE").available, "10000");
  assert.equal(slippage.wallet("K_DUAL_VOL").available, "10000");
  assert.equal(
    slippage.events().filter((item) => item.details.reason === "SLIPPAGE_LIMIT").length,
    2,
  );

  const transition = new KJPaperEngine();
  warmEngine(transition);
  transition.ingest(context(185, "110", 40));
  assert.ok(Number(transition.wallet("J_FEE_AWARE").available) < 10000);
  transition.ingest(context(300, "110", 41, market(2)));
  assert.equal(transition.wallet("J_FEE_AWARE").available, "10000");
  assert.equal(transition.wallet("K_DUAL_VOL").available, "10000");
  assert.equal(
    transition.events().filter((item) => item.details.reason === "MARKET_STOPPING").length,
    2,
  );
});

test("new market stops risk expansion and only official settlement reaches DONE", () => {
  const engine = new KJPaperEngine();
  warmEngine(engine);
  engine.ingest(context(185, "110", 40));
  engine.ingest(context(186, "110", 41));

  const second = market(2);
  engine.ingest(context(300, "110", 42, second));
  assert.equal(engine.state("market-1"), "STOPPING");
  assert.equal(engine.state("market-2"), "RUNNING");

  const official = {
    settlementId: "settlement-1",
    marketId: "market-1",
    winner: "UP",
    settlementTime: iso(360),
    evidenceStatus: "OFFICIAL_RESOLUTION",
    evidenceReference: "gamma:market-1",
  } as const satisfies KJOfficialSettlement;
  assert.equal(engine.settle(official), true);
  assert.equal(engine.state("market-1"), "DONE");
  assert.equal(engine.position("J_FEE_AWARE", "111"), "0");
  assert.equal(engine.position("K_DUAL_VOL", "111"), "0");
  assert.equal(engine.settle(official), false);
  assert.throws(
    () => engine.settle({ ...official, winner: "DOWN" }),
    /conflicting content/u,
  );
  assert.throws(
    () => engine.settle({ ...official, settlementId: "settlement-2" }),
    /already has a different settlement/u,
  );
  assert.equal(
    engine.events().filter((event) => event.eventType === "SETTLEMENT").length,
    2,
  );
});

test("paper engine rejects unofficial settlement and conflicting dedup identities", () => {
  const settlementEngine = new KJPaperEngine();
  settlementEngine.ingest(context(0, "100", 1));
  assert.throws(
    () => settlementEngine.settle({
      settlementId: "settlement-unofficial",
      marketId: "market-1",
      winner: "UP",
      settlementTime: iso(360),
      evidenceStatus: "UNVERIFIED",
      evidenceReference: "guess",
    } as unknown as KJOfficialSettlement),
    /requires official resolution/u,
  );

  const contextEngine = new KJPaperEngine();
  const original = context(0, "100", 1);
  contextEngine.ingest(original);
  const conflictingContext = {
    ...original,
    book: {
      ...original.book,
      up: { ...original.book.up, ask: "0.81" },
    },
  };
  assert.throws(
    () => contextEngine.ingest(conflictingContext),
    /context identity has conflicting content/u,
  );

  const signalEngine = new KJPaperEngine();
  signalEngine.ingest(context(0, "100", 1));
  assert.throws(
    () => signalEngine.ingest(context(5, "101", 1)),
    /signal input hash has conflicting content/u,
  );
});

test("paper engine validates configuration before accepting contexts", () => {
  assert.throws(
    () => new KJPaperEngine({ maximumStakeFraction: "1.1" }),
    /must not exceed one/u,
  );
  assert.throws(
    () => new KJPaperEngine({ fillLatencyMilliseconds: 0 }),
    /positive safe integer/u,
  );
  assert.throws(
    () => new KJPaperEngine({ maxEdge: "0.05" }),
    /must exceed edgeThreshold/u,
  );
});

test("late first context fails closed instead of inventing a market open anchor", () => {
  const engine = new KJPaperEngine();
  engine.ingest(context(10, "100", 1));
  assert.equal(engine.state("market-1"), "STOPPING");
  assert.equal(
    engine.events().some((event) => event.details.reason === "MISSED_SIGNAL_OPEN_ANCHOR"),
    true,
  );
  assert.equal(engine.events().some((event) => event.eventType === "INTENT"), false);
});
