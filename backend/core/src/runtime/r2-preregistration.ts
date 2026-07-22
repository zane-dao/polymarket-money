import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  DEFAULT_LEAD_LAG_CONFIG,
  EPISODE_GAP_MS,
  EPISODE_RULE_VERSION,
  LEAD_LAG_HORIZONS_MS,
  LEAD_LAG_THRESHOLDS_BPS,
  LEAD_LAG_TRIGGER_WINDOWS_MS,
} from "./lead-lag.js";

export const R2_PREREGISTRATION_VERSION = "batch-04b-r2-observation-preregistration-v1" as const;

export interface R2Preregistration {
  readonly experiment_id: "batch-04b-r2-24-market-observation";
  readonly schema_version: typeof R2_PREREGISTRATION_VERSION;
  readonly git_commit: string;
  readonly config_created_at_utc: string;
  readonly record_mode: "metrics";
  readonly raw_recording: false;
  readonly target_completed_markets: 24;
  readonly maximum_runtime_minutes: 150;
  readonly minimum_free_disk_gib: 10;
  readonly continuity_required: "UNVERIFIED";
  readonly fair_value_enabled: false;
  readonly output_path: string;
  readonly lead_lag: Readonly<Record<string, unknown>>;
  readonly safety: Readonly<Record<string, unknown>>;
  readonly config_sha256: string;
}

const SHA256 = /^[0-9a-f]{40}$/u;

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: unknown, expected: unknown, field: string): void {
  if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error(`${field} differs from the frozen R2 contract`);
}

export async function loadR2Preregistration(path: string): Promise<R2Preregistration> {
  const bytes = await readFile(path);
  const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  const config = record(parsed, "R2 preregistration");
  const required: Readonly<Record<string, unknown>> = {
    experiment_id: "batch-04b-r2-24-market-observation",
    schema_version: R2_PREREGISTRATION_VERSION,
    record_mode: "metrics",
    raw_recording: false,
    target_completed_markets: 24,
    maximum_runtime_minutes: 150,
    minimum_free_disk_gib: 10,
    continuity_required: "UNVERIFIED",
    fair_value_enabled: false,
  };
  for (const [field, expected] of Object.entries(required)) exact(config[field], expected, field);
  if (typeof config.git_commit !== "string" || !SHA256.test(config.git_commit)) throw new Error("git_commit must be a 40-character lowercase Git object ID");
  if (typeof config.config_created_at_utc !== "string" || Number.isNaN(Date.parse(config.config_created_at_utc))) throw new Error("config_created_at_utc must be an ISO timestamp");
  if (typeof config.output_path !== "string" || config.output_path !== "$POLY_DATA_ROOT/experiments/batch-04b-r2-24-market-observation/") throw new Error("output_path differs from the frozen R2 path");

  const leadLag = record(config.lead_lag, "lead_lag");
  exact(leadLag.sources, ["BINANCE_SPOT", "BINANCE_PERPETUAL", "CHAINLINK", "POLYMARKET_BINANCE_RELAY"], "lead_lag.sources");
  exact(leadLag.runtime_source_mapping, {
    CHAINLINK: "POLYMARKET_RTDS_CHAINLINK",
    POLYMARKET_BINANCE_RELAY: "POLYMARKET_RTDS_BINANCE",
  }, "lead_lag.runtime_source_mapping");
  exact(leadLag.thresholds_bps, LEAD_LAG_THRESHOLDS_BPS, "lead_lag.thresholds_bps");
  exact(leadLag.trigger_windows_ms, LEAD_LAG_TRIGGER_WINDOWS_MS, "lead_lag.trigger_windows_ms");
  exact(leadLag.horizons_ms, LEAD_LAG_HORIZONS_MS, "lead_lag.horizons_ms");
  exact(leadLag.max_baseline_age_ms_by_trigger_window, { "100": 100, "250": 100, "500": 100 }, "lead_lag.max_baseline_age_ms_by_trigger_window");
  exact(leadLag.max_horizon_state_age_ms_by_horizon, { "50": 1000, "100": 1000, "250": 1000, "500": 1000, "1000": 1000, "2000": 1000, "3000": 1000 }, "lead_lag.max_horizon_state_age_ms_by_horizon");
  exact(leadLag.episode_rule_version, EPISODE_RULE_VERSION, "lead_lag.episode_rule_version");
  exact(leadLag.episode_gap_ms, EPISODE_GAP_MS, "lead_lag.episode_gap_ms");
  exact(leadLag.grouping_dimensions, DEFAULT_LEAD_LAG_CONFIG.grouping_dimensions, "lead_lag.grouping_dimensions");
  exact(leadLag.connection_reset_behavior, DEFAULT_LEAD_LAG_CONFIG.connection_reset_behavior, "lead_lag.connection_reset_behavior");

  const safety = record(config.safety, "safety");
  for (const field of ["live_trading_enabled", "credentials_allowed", "user_channel_allowed", "signing_allowed", "orders_allowed", "order_intents_allowed", "fills_allowed", "server_deployment_allowed"]) {
    if (safety[field] !== false) throw new Error(`safety.${field} must remain false`);
  }
  return Object.freeze({
    ...config,
    lead_lag: Object.freeze(leadLag),
    safety: Object.freeze(safety),
    config_sha256: createHash("sha256").update(bytes).digest("hex"),
  }) as unknown as R2Preregistration;
}
