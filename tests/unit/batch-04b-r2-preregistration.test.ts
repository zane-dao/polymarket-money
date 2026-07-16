import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const path = "experiments/batch-04b-r2-24-market-observation.yaml";

test("R2 preregistration freezes the metrics-only 24-market observation grid", async () => {
  const config = JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
  assert.equal(config.record_mode, "metrics");
  assert.equal(config.raw_recording, false);
  assert.equal(config.target_completed_markets, 24);
  assert.equal(config.maximum_runtime_minutes, 150);
  assert.equal(config.minimum_free_disk_gib, 10);
  assert.equal(config.continuity_required, "UNVERIFIED");
  assert.equal(config.fair_value_enabled, false);
  assert.deepEqual(config.lead_lag.sources, [
    "BINANCE_SPOT", "BINANCE_PERPETUAL", "CHAINLINK", "POLYMARKET_BINANCE_RELAY",
  ]);
  assert.deepEqual(config.lead_lag.thresholds_bps, ["1", "2", "5"]);
  assert.deepEqual(config.lead_lag.trigger_windows_ms, [100, 250, 500]);
  assert.deepEqual(config.lead_lag.horizons_ms, [50, 100, 250, 500, 1000, 2000, 3000]);
  assert.equal(
    config.lead_lag.sources.length
      * config.lead_lag.thresholds_bps.length
      * config.lead_lag.trigger_windows_ms.length
      * config.lead_lag.horizons_ms.length,
    252,
  );
  assert.deepEqual(Object.keys(config.lead_lag.max_baseline_age_ms_by_trigger_window), ["100", "250", "500"]);
  assert.deepEqual(Object.keys(config.lead_lag.max_horizon_state_age_ms_by_horizon), [
    "50", "100", "250", "500", "1000", "2000", "3000",
  ]);
  assert.equal(config.lead_lag.episode_rule_version, "lead-lag-episode-v1");
  assert.equal(config.lead_lag.episode_gap_ms, 500);
  assert.equal(config.lead_lag.connection_reset_behavior, "END_EPISODE_AND_CENSOR_PENDING");
  assert.equal(config.safety.live_trading_enabled, false);
  for (const key of ["credentials_allowed", "user_channel_allowed", "signing_allowed", "orders_allowed", "order_intents_allowed", "fills_allowed"]) {
    assert.equal(config.safety[key], false, key);
  }
});
