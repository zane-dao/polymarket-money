import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_LEAD_LAG_CONFIG } from "../../execution/src/runtime/lead-lag.js";
import {
  OPPORTUNITY_RUNTIME_CONFIG_VERSION,
  createOpportunityRuntimeConfig,
} from "../../execution/src/runtime/opportunity-config.js";

const base = {
  mode: "paper" as const,
  recordMode: "metrics" as const,
  completeSetLatencyMs: 1_000,
  feeEvidencePolicy: "GAMMA_SCHEDULE_OR_INELIGIBLE" as const,
  clobContinuity: "UNVERIFIED" as const,
  leadLagConfigHash: DEFAULT_LEAD_LAG_CONFIG.config_hash,
  preregistrationConfigHash: null,
};

test("runtime opportunity config is versioned and hashes every result-affecting setting", () => {
  const config = createOpportunityRuntimeConfig(base);
  assert.equal(config.schema_version, OPPORTUNITY_RUNTIME_CONFIG_VERSION);
  assert.match(config.config_hash, /^[0-9a-f]{64}$/u);
  assert.notEqual(createOpportunityRuntimeConfig({ ...base, mode: "monitor" }).config_hash, config.config_hash);
  assert.notEqual(createOpportunityRuntimeConfig({ ...base, recordMode: "none" }).config_hash, config.config_hash);
  assert.notEqual(createOpportunityRuntimeConfig({ ...base, completeSetLatencyMs: 2_000 }).config_hash, config.config_hash);
  assert.notEqual(createOpportunityRuntimeConfig({ ...base, feeEvidencePolicy: "MISSING_FEE_INELIGIBLE" }).config_hash, config.config_hash);
  assert.notEqual(createOpportunityRuntimeConfig({ ...base, clobContinuity: "CONTINUOUS" }).config_hash, config.config_hash);
  assert.notEqual(createOpportunityRuntimeConfig({ ...base, leadLagConfigHash: "f".repeat(64) }).config_hash, config.config_hash);
  assert.notEqual(createOpportunityRuntimeConfig({ ...base, preregistrationConfigHash: "e".repeat(64) }).config_hash, config.config_hash);
});
