import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LEAD_LAG_CONFIG,
  EpisodeTracker,
  LeadLagEngine,
  createLeadLagConfig,
  externalConnectionId,
  polymarketConnectionId,
  type ExternalConnectionId,
  type ExternalPriceState,
  type LeadLagStamp,
  type PolymarketBookState,
} from "../../execution/src/runtime/lead-lag.js";

const domain = "process-1";
const stamp = (ns: number, ordinal: number, clockDomain = domain): LeadLagStamp => ({
  clock_domain: clockDomain,
  local_monotonic_receive_ns: String(ns),
  local_receive_ordinal: String(ordinal),
});

const external = (
  externalEventId: string,
  ns: number,
  ordinal: number,
  price: string,
  connection = "external-1",
): ExternalPriceState => ({
  external_event_id: externalEventId,
  source: "BINANCE_SPOT",
  price,
  receive_stamp: stamp(ns, ordinal),
  external_connection_id: externalConnectionId(connection),
  parent_input_reference: `raw-event-v2:${externalEventId}`,
  quality: { stale: false, disconnected: false, quarantined: false },
});

const book = (
  ns: number,
  ordinal: number,
  mid: string,
  connection = "poly-1",
  quality: Partial<PolymarketBookState["quality"]> = {},
): PolymarketBookState => ({
  market_id: "market-1",
  bid: mid,
  ask: mid,
  mid_price: mid,
  receive_stamp: stamp(ns, ordinal),
  polymarket_connection_id: polymarketConnectionId(connection),
  parent_input_reference: `raw-event-v2:poly-${ordinal}`,
  quality: {
    snapshot: true,
    stale: false,
    disconnected: false,
    crossed: false,
    empty_side: false,
    quarantined: false,
    ...quality,
  },
});

function engineWithTrigger(): { engine: LeadLagEngine; triggerId: string } {
  const engine = new LeadLagEngine(createLeadLagConfig({
    baselineMaxAgeMs: 100,
    horizonStateMaxAgeMs: 1000,
  }));
  engine.ingestExternal(external("baseline", 500_000_000, 1, "100"));
  engine.ingestExternal(external("same-ns-future", 500_000_000, 2, "90"));
  engine.ingestPolymarket(book(590_000_000, 3, "0.5"));
  engine.ingestExternal(external("event", 600_000_000, 4, "101"));
  const batch = engine.createTriggers({
    externalEventId: "event",
    marketId: "market-1",
    baselineWatermarks: {
      "100": stamp(500_000_000, 1),
      "250": stamp(350_000_000, 1),
      "500": stamp(100_000_000, 1),
    },
  });
  assert.equal(batch.triggers.length, 3);
  const triggerId = batch.triggers[0]?.trigger_id;
  assert.ok(triggerId);
  return { engine, triggerId };
}

test("pre-registered four-source grid is complete and episode rules are config-hashed", () => {
  assert.equal(DEFAULT_LEAD_LAG_CONFIG.sources.length, 4);
  assert.deepEqual(DEFAULT_LEAD_LAG_CONFIG.thresholds_bps, ["1", "2", "5"]);
  assert.deepEqual(DEFAULT_LEAD_LAG_CONFIG.trigger_windows_ms, [100, 250, 500]);
  assert.deepEqual(DEFAULT_LEAD_LAG_CONFIG.horizons_ms, [50, 100, 250, 500, 1000, 2000, 3000]);
  assert.equal(DEFAULT_LEAD_LAG_CONFIG.episode_rule_version, "lead-lag-episode-v1");
  assert.equal(DEFAULT_LEAD_LAG_CONFIG.episode_gap_ms, 500);
  assert.equal(DEFAULT_LEAD_LAG_CONFIG.connection_reset_behavior, "END_EPISODE_AND_CENSOR_PENDING");
  const engine = new LeadLagEngine(DEFAULT_LEAD_LAG_CONFIG);
  assert.equal(engine.grid().length, 252);
  assert.match(DEFAULT_LEAD_LAG_CONFIG.config_hash, /^[0-9a-f]{64}$/u);
});

test("baseline is same-source same-connection as-of and same-ns future ordinal is excluded", () => {
  const { engine, triggerId } = engineWithTrigger();
  const trigger = engine.trigger(triggerId);
  assert.equal(trigger.baseline_target_time.local_monotonic_receive_ns, "500000000");
  assert.equal(trigger.baseline_observation_time.local_receive_ordinal, "1");
  assert.equal(trigger.baseline_age_ms, 0);
  assert.equal(trigger.effective_window_ms, 100);
  assert.equal(trigger.external_connection_id, "external-1");
  assert.equal(trigger.polymarket_connection_id, "poly-1");
  assert.equal("connection_id" in trigger, false);
  assert.equal(trigger.overlapping_trigger_group, "event");
  assert.equal(trigger.parent_input_reference, "raw-event-v2:event");
});

test("external reconnect cannot reuse an old baseline", () => {
  const engine = new LeadLagEngine(DEFAULT_LEAD_LAG_CONFIG);
  engine.ingestExternal(external("old", 500_000_000, 1, "100", "external-old"));
  engine.ingestPolymarket(book(590_000_000, 2, "0.5"));
  engine.ingestExternal(external("new", 600_000_000, 3, "101", "external-new"));
  const batch = engine.createTriggers({
    externalEventId: "new",
    marketId: "market-1",
    baselineWatermarks: {
      "100": stamp(500_000_000, 1),
      "250": stamp(350_000_000, 1),
      "500": stamp(100_000_000, 1),
    },
  });
  assert.equal(batch.triggers.length, 0);
  assert.ok(batch.rejections.some((item) => item.reason === "BASELINE_CONNECTION_MISMATCH"));
});

test("external and Polymarket connection ID types cannot be interchanged", () => {
  const externalId: ExternalConnectionId = externalConnectionId("external-1");
  const polymarketId = polymarketConnectionId("poly-1");
  assert.notEqual(externalId, polymarketId);
  // @ts-expect-error The two source-specific connection identities are intentionally branded.
  const invalid: ExternalConnectionId = polymarketId;
  assert.equal(invalid, "poly-1");
});

test("fixed horizon uses only point-in-time state; later update is a separate metric", () => {
  const { engine, triggerId } = engineWithTrigger();
  engine.ingestPolymarket(book(640_000_000, 5, "0.51"));
  engine.ingestPolymarket(book(651_000_000, 6, "0.9"));
  const result = engine.evaluateHorizon({
    triggerId,
    horizonMs: 50,
    targetWatermark: stamp(650_000_000, 5),
  });
  assert.equal(result.censored, false);
  assert.equal(result.markout_mid_price, "0.51");
  assert.equal(result.state_age_ms, 10);
  assert.deepEqual(result.next_update_after_horizon, {
    next_update_delay_ms: 1,
    update_direction: "UP",
    update_magnitude: "0.39",
    observation_time: stamp(651_000_000, 6),
  });
});

test("stale horizon and either connection reconnect censor instead of reusing state", () => {
  const stale = engineWithTrigger();
  const staleResult = stale.engine.evaluateHorizon({
    triggerId: stale.triggerId,
    horizonMs: 1000,
    targetWatermark: stamp(1_600_000_000, 10),
  });
  assert.equal(staleResult.censored, true);
  assert.equal(staleResult.censor_reason, "HORIZON_STATE_TOO_OLD");

  const externalReconnect = engineWithTrigger();
  externalReconnect.engine.ingestExternal(external("reconnect", 620_000_000, 5, "101", "external-2"));
  const externalResult = externalReconnect.engine.evaluateHorizon({
    triggerId: externalReconnect.triggerId,
    horizonMs: 50,
    targetWatermark: stamp(650_000_000, 6),
  });
  assert.equal(externalResult.censor_reason, "EXTERNAL_CONNECTION_CHANGED");

  const polyReconnect = engineWithTrigger();
  polyReconnect.engine.ingestPolymarket(book(620_000_000, 5, "0.51", "poly-2"));
  const polyResult = polyReconnect.engine.evaluateHorizon({
    triggerId: polyReconnect.triggerId,
    horizonMs: 50,
    targetWatermark: stamp(650_000_000, 6),
  });
  assert.equal(polyResult.censor_reason, "POLYMARKET_CONNECTION_CHANGED");
});

test("snapshot, stale, disconnect, crossed, empty-side, quarantine and clock-domain gates fail closed", () => {
  for (const [field, reason] of [
    ["snapshot", "HORIZON_QUALITY_REJECTED"],
    ["stale", "HORIZON_QUALITY_REJECTED"],
    ["disconnected", "HORIZON_QUALITY_REJECTED"],
    ["crossed", "HORIZON_QUALITY_REJECTED"],
    ["empty_side", "HORIZON_QUALITY_REJECTED"],
    ["quarantined", "HORIZON_QUALITY_REJECTED"],
  ] as const) {
    const { engine, triggerId } = engineWithTrigger();
    engine.ingestPolymarket(book(640_000_000, 5, "0.51", "poly-1", {
      [field]: field === "snapshot" ? false : true,
    }));
    assert.equal(engine.evaluateHorizon({
      triggerId,
      horizonMs: 50,
      targetWatermark: stamp(650_000_000, 5),
    }).censor_reason, reason, field);
  }
  const { engine, triggerId } = engineWithTrigger();
  assert.throws(() => engine.evaluateHorizon({
    triggerId,
    horizonMs: 50,
    targetWatermark: stamp(650_000_000, 5, "another-process"),
  }), /clock.domain/i);
});

test("replay and runtime insertion order produce identical as-of horizon semantics", () => {
  const runtime = engineWithTrigger();
  runtime.engine.ingestPolymarket(book(640_000_000, 5, "0.51"));
  runtime.engine.ingestPolymarket(book(651_000_000, 6, "0.9"));

  const replay = engineWithTrigger();
  replay.engine.ingestPolymarket(book(651_000_000, 6, "0.9"));
  replay.engine.ingestPolymarket(book(640_000_000, 5, "0.51"));
  const query = { horizonMs: 50 as const, targetWatermark: stamp(650_000_000, 5) };
  assert.deepEqual(
    runtime.engine.evaluateHorizon({ triggerId: runtime.triggerId, ...query }),
    replay.engine.evaluateHorizon({ triggerId: replay.triggerId, ...query }),
  );
});

test("episode v1 extends only within frozen gap and grouping dimensions", () => {
  const tracker = new EpisodeTracker();
  const identity = {
    source: "BINANCE_SPOT" as const,
    direction: "UP" as const,
    market_id: "market-1",
    clock_domain: domain,
    external_connection_id: externalConnectionId("external-1"),
    polymarket_connection_id: polymarketConnectionId("poly-1"),
  };
  const first = tracker.assign({ ...identity, external_event_id: "a", receive_stamp: stamp(0, 1) });
  const overlapping = tracker.assign({ ...identity, external_event_id: "a", receive_stamp: stamp(0, 1) });
  const extended = tracker.assign({ ...identity, external_event_id: "b", receive_stamp: stamp(400_000_000, 2) });
  const gap = tracker.assign({ ...identity, external_event_id: "c", receive_stamp: stamp(901_000_000, 3) });
  const reverse = tracker.assign({ ...identity, direction: "DOWN", external_event_id: "d", receive_stamp: stamp(902_000_000, 4) });
  const reconnect = tracker.assign({ ...identity, external_connection_id: externalConnectionId("external-2"), external_event_id: "e", receive_stamp: stamp(903_000_000, 5) });
  assert.equal(first, overlapping);
  assert.equal(first, extended);
  assert.notEqual(first, gap);
  assert.notEqual(gap, reverse);
  assert.notEqual(reverse, reconnect);
  const summary = tracker.summaries().find((item) => item.trigger_episode_id === first);
  assert.equal(summary?.trigger_count, 3);
  assert.equal(summary?.duration_ms, 400);

  const resetTracker = new EpisodeTracker();
  const beforeReset = resetTracker.assign({ ...identity, external_event_id: "f", receive_stamp: stamp(1_000_000_000, 6) });
  resetTracker.assign({ ...identity, external_connection_id: externalConnectionId("external-2"), external_event_id: "g", receive_stamp: stamp(1_100_000_000, 7) });
  const afterReturning = resetTracker.assign({ ...identity, external_event_id: "h", receive_stamp: stamp(1_200_000_000, 8) });
  assert.notEqual(beforeReset, afterReturning);
});
