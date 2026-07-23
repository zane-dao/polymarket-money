import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { PublicBtcFiveMinuteMarket } from "../../backend/core/src/adapters/market-data/public-sources.js";
import type { ReceiveStamp } from "../../backend/core/src/domain/receive-time.js";
import {
  KJPaperEngine,
  kjPaperProbabilityFromZ,
  type KJOfficialSettlement,
} from "../../backend/core/src/runtime/kj-paper-engine.js";
import { reviewTargetPositionV1 } from "../../backend/core/src/risk/index.js";
import { createKJStrategyContext, type KJStrategyContextV1 } from "../../strategies/src/kj-context.js";

const START = Date.parse("2026-07-17T00:00:00.000Z");
const root = new URL("../../../", import.meta.url);

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
    upBid?: string;
    upAsk?: string;
    upAskSize?: string;
    downBid?: string;
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
        bid: book.upBid ?? "0.79",
        ask: book.upAsk ?? "0.8",
        bidSize: "1000",
        askSize: book.upAskSize ?? "1000",
      },
      down: {
        bid: book.downBid ?? "0.19",
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
  const intent = engine.events().find((event) => event.eventType === "INTENT" && event.strategy === "J_FEE_AWARE");
  assert.equal(intent?.details.riskStatus, "APPROVED");
  assert.ok(Number(intent?.details.targetPositionQuantity) >= Number(intent?.details.intendedQuantity));
  assert.ok(Number(intent?.details.estimatedFee) > 0);
  assert.ok(fills.every((fill) => fill.details.partial === true));
  const snapshot = engine.snapshot();
  assert.equal(snapshot.schemaVersion, "kj-paper-engine-snapshot-v1");
  assert.equal(snapshot.markets[0]?.state, "RUNNING");
  assert.ok(Number(snapshot.wallets.J_FEE_AWARE.positions["111"]) > 0);
  assert.equal(snapshot.pendingIntents.length, 0);
});

test("J and K decide on consecutive unique order-book contexts without a fixed time window", () => {
  const engine = new KJPaperEngine();
  warmEngine(engine);
  engine.ingest(context(185, "100.2", 40, market(1), { upAsk: "0.95", downAsk: "0.95" }));
  const before = engine.events().filter((event) => event.eventType === "DECISION").length;
  engine.ingest(context(185.001, "100.2", 41, market(1), { upAsk: "0.94", downAsk: "0.95" }));
  const after = engine.events().filter((event) => event.eventType === "DECISION").length;
  assert.equal(after - before, 2, "one changed context produces one immediate decision per strategy");
});

test("L V2 runs on every unique order-book context without activating J or K", () => {
  const engine = new KJPaperEngine({
    activeStrategies: ["L_ADAPTIVE_EXECUTION_V2"],
    maxEdge: "0.25",
    maximumStakeAmount: "300",
    bookParticipation: "1",
  });
  warmEngine(engine);
  engine.ingest(context(185, "100.2", 40, market(1), { upBid: "0.54", upAsk: "0.55", downBid: "0.45", downAsk: "0.46" }));
  const before = engine.events().filter((event) => event.eventType === "DECISION").length;
  engine.ingest(context(185.001, "100.2", 41, market(1), { upBid: "0.53", upAsk: "0.54", downBid: "0.46", downAsk: "0.47" }));
  const decisions = engine.events().filter((event) => event.eventType === "DECISION");
  assert.equal(decisions.length - before, 1);
  assert.ok(decisions.every((event) => event.strategy === "L_ADAPTIVE_EXECUTION_V2"));
  assert.equal(engine.wallet("J_FEE_AWARE").cash, "10000");
  assert.equal(engine.wallet("K_DUAL_VOL").cash, "10000");
});

test("target-position review nets existing and resting quantity before applying depth and risk caps", () => {
  const review = reviewTargetPositionV1({
    requestedTargetQuantity: "100", currentPositionQuantity: "30", openOrderQuantity: "20",
    executablePrice: "0.5", maximumFillPrice: "0.51", feeRate: "0.02",
    visibleAskQuantity: "40", bookParticipation: "0.5", availableCash: "1000",
    currentMarketNotional: "0", currentTotalNotional: "0", maximumOrderNotional: "100",
    maximumMarketNotional: "100", maximumTotalNotional: "100",
  });
  assert.equal(review.status, "REDUCED");
  assert.equal(review.coveredQuantity, "50");
  assert.equal(review.requestedOrderQuantity, "50");
  assert.equal(review.approvedOrderQuantity, "20");
  assert.deepEqual(review.reasonCodes, ["VISIBLE_DEPTH_LIMIT"]);
  assert.ok(Number(review.reservedAmount) > 10);
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
    /signal identity has conflicting content/u,
  );

  const nextSignal = context(5, "101", 2);
  const repeatedRawHash = {
    ...nextSignal,
    signal: { ...nextSignal.signal, inputHash: original.signal.inputHash },
  };
  assert.equal(signalEngine.ingest(repeatedRawHash), true);
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

test("TypeScript probability stays inside the shared Python erf golden tolerance", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("data/golden/batch-06/kj-probability-v1.json", root),
    "utf8",
  )) as {
    maximumAbsoluteError: string;
    cases: readonly { z: string; expectedProbability: string }[];
  };
  const tolerance = Number(fixture.maximumAbsoluteError);
  for (const item of fixture.cases) {
    const actual = kjPaperProbabilityFromZ(Number(item.z));
    assert.ok(
      Math.abs(Number(actual) - Number(item.expectedProbability)) <= tolerance,
      `z=${item.z}: ${actual} vs ${item.expectedProbability}`,
    );
  }
  assert.throws(() => kjPaperProbabilityFromZ(Number.NaN), /must be finite/u);
});

test("TypeScript EWMA-to-intent matches the shared Python decision golden", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("data/golden/batch-06/kj-ewma-intent-parity-v1.json", root),
    "utf8",
  )) as {
    warmBook: {
      upBid: string; upAsk: string; downBid: string; downAsk: string; askSize: string;
    };
    decisionBook: {
      upBid: string; upAsk: string; downBid: string; downAsk: string; askSize: string;
    };
    prices: readonly { offsetSeconds: number; price: string }[];
    tolerances: { probabilityAbsolute: string; numericAbsolute: string };
    expected: Record<"J_FEE_AWARE" | "K_DUAL_VOL", {
      sigma: string;
      probabilityUp: string;
      outcome: string;
      edge: string;
      requiredEdge: string;
      action: string;
      reason: string;
      intendedQuantity: string | null;
      fill: null | {
        price: string; quantity: string; cost: string; fee: string;
        cashAfterFill: string; positionAfter: string; payout: string;
        grossPnl: string; netPnl: string; finalCash: string;
      };
    }>;
  };
  const engine = new KJPaperEngine();
  for (const [index, sample] of fixture.prices.entries()) {
    const source = index === fixture.prices.length - 1 ? fixture.decisionBook : fixture.warmBook;
    engine.ingest(context(sample.offsetSeconds, sample.price, index + 1, market(1), {
      upBid: source.upBid,
      upAsk: source.upAsk,
      upAskSize: source.askSize,
      downBid: source.downBid,
      downAsk: source.downAsk,
      downAskSize: source.askSize,
    }));
  }
  const at = iso(185);
  const close = (actual: unknown, expected: string, tolerance: string, field: string): void => {
    assert.ok(
      Math.abs(Number(actual) - Number(expected)) <= Number(tolerance),
      `${field}: ${String(actual)} vs ${expected}`,
    );
  };
  for (const strategy of ["J_FEE_AWARE", "K_DUAL_VOL"] as const) {
    const expected = fixture.expected[strategy];
    const decision = engine.events().find((item) =>
      item.eventType === "DECISION" && item.strategy === strategy && item.eventTime === at);
    assert.ok(decision, strategy);
    assert.equal(decision.details.action, expected.action);
    assert.equal(decision.details.reason, expected.reason);
    assert.equal(decision.details.outcome, expected.outcome);
    close(decision.details.sigma, expected.sigma, fixture.tolerances.numericAbsolute, `${strategy}.sigma`);
    close(
      decision.details.probabilityUp,
      expected.probabilityUp,
      fixture.tolerances.probabilityAbsolute,
      `${strategy}.probabilityUp`,
    );
    close(decision.details.edge, expected.edge, fixture.tolerances.probabilityAbsolute, `${strategy}.edge`);
    close(
      decision.details.requiredEdge,
      expected.requiredEdge,
      fixture.tolerances.numericAbsolute,
      `${strategy}.requiredEdge`,
    );
    const intent = engine.events().find((item) =>
      item.eventType === "INTENT" && item.strategy === strategy && item.eventTime === at);
    if (expected.intendedQuantity === null) {
      assert.equal(intent, undefined);
    } else {
      assert.ok(intent);
      close(
        intent.details.intendedQuantity,
        expected.intendedQuantity,
        fixture.tolerances.numericAbsolute,
        `${strategy}.intendedQuantity`,
      );
    }
  }
  engine.ingest(context(186, "60240", fixture.prices.length + 1, market(1), {
    upBid: fixture.decisionBook.upBid,
    upAsk: fixture.decisionBook.upAsk,
    upAskSize: fixture.decisionBook.askSize,
    downBid: fixture.decisionBook.downBid,
    downAsk: fixture.decisionBook.downAsk,
    downAskSize: fixture.decisionBook.askSize,
  }));
  engine.settle({
    settlementId: "golden-official-settlement",
    marketId: "market-1",
    winner: "UP",
    settlementTime: iso(360),
    evidenceStatus: "OFFICIAL_RESOLUTION",
    evidenceReference: "golden:official-resolution",
  });
  for (const strategy of ["J_FEE_AWARE", "K_DUAL_VOL"] as const) {
    const expected = fixture.expected[strategy];
    const fill = engine.events().find((item) => item.eventType === "FILL" && item.strategy === strategy);
    const settled = engine.events().find((item) =>
      item.eventType === "SETTLEMENT" && item.strategy === strategy);
    assert.ok(settled);
    if (expected.fill === null) {
      assert.equal(fill, undefined);
      assert.equal(settled.details.netPnl, "0");
      continue;
    }
    assert.ok(fill);
    for (const [actual, expectedValue, field] of [
      [fill.details.price, expected.fill.price, "price"],
      [fill.details.quantity, expected.fill.quantity, "quantity"],
      [fill.details.cost, expected.fill.cost, "cost"],
      [fill.details.fee, expected.fill.fee, "fee"],
      [fill.details.cashAfter, expected.fill.cashAfterFill, "cashAfterFill"],
      [fill.details.positionAfter, expected.fill.positionAfter, "positionAfter"],
      [settled.details.payout, expected.fill.payout, "payout"],
      [settled.details.grossPnl, expected.fill.grossPnl, "grossPnl"],
      [settled.details.netPnl, expected.fill.netPnl, "netPnl"],
      [settled.details.cashAfter, expected.fill.finalCash, "finalCash"],
    ] as const) close(actual, expectedValue, fixture.tolerances.numericAbsolute, `${strategy}.${field}`);
  }
  assert.equal(engine.snapshot().markets[0]?.state, "DONE");
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
