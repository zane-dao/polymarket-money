import { createHash } from "node:crypto";

export const OPPORTUNITY_RUNTIME_CONFIG_VERSION = "opportunity-runtime-config-v1" as const;

export interface OpportunityRuntimeConfig {
  readonly schema_version: typeof OPPORTUNITY_RUNTIME_CONFIG_VERSION;
  readonly mode: "monitor" | "paper";
  readonly record_mode: "none" | "metrics" | "raw";
  readonly complete_set_latency_ms: number;
  readonly fee_evidence_policy: "GAMMA_SCHEDULE_OR_INELIGIBLE" | "MISSING_FEE_INELIGIBLE";
  readonly clob_continuity: "UNVERIFIED" | "CONTINUOUS";
  readonly lead_lag_config_hash: string;
  readonly preregistration_config_hash: string | null;
  readonly config_hash: string;
}

export interface CreateOpportunityRuntimeConfigInput {
  readonly mode: OpportunityRuntimeConfig["mode"];
  readonly recordMode: OpportunityRuntimeConfig["record_mode"];
  readonly completeSetLatencyMs: number;
  readonly feeEvidencePolicy: OpportunityRuntimeConfig["fee_evidence_policy"];
  readonly clobContinuity: OpportunityRuntimeConfig["clob_continuity"];
  readonly leadLagConfigHash: string;
  readonly preregistrationConfigHash?: string | null;
}

const SHA256 = /^[0-9a-f]{64}$/u;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function createOpportunityRuntimeConfig(
  input: CreateOpportunityRuntimeConfigInput,
): OpportunityRuntimeConfig {
  if (input.mode !== "monitor" && input.mode !== "paper") throw new Error("opportunity mode is invalid");
  if (!["none", "metrics", "raw"].includes(input.recordMode)) throw new Error("recordMode is invalid");
  if (!Number.isSafeInteger(input.completeSetLatencyMs) || input.completeSetLatencyMs < 0) {
    throw new Error("completeSetLatencyMs must be a non-negative safe integer");
  }
  if (!["GAMMA_SCHEDULE_OR_INELIGIBLE", "MISSING_FEE_INELIGIBLE"].includes(input.feeEvidencePolicy)) {
    throw new Error("feeEvidencePolicy is invalid");
  }
  if (input.clobContinuity !== "UNVERIFIED" && input.clobContinuity !== "CONTINUOUS") {
    throw new Error("clobContinuity is invalid");
  }
  if (!SHA256.test(input.leadLagConfigHash)) throw new Error("leadLagConfigHash must be a lowercase sha256");
  const preregistrationConfigHash = input.preregistrationConfigHash ?? null;
  if (preregistrationConfigHash !== null && !SHA256.test(preregistrationConfigHash)) {
    throw new Error("preregistrationConfigHash must be a lowercase sha256");
  }
  const payload = Object.freeze({
    schema_version: OPPORTUNITY_RUNTIME_CONFIG_VERSION,
    mode: input.mode,
    record_mode: input.recordMode,
    complete_set_latency_ms: input.completeSetLatencyMs,
    fee_evidence_policy: input.feeEvidencePolicy,
    clob_continuity: input.clobContinuity,
    lead_lag_config_hash: input.leadLagConfigHash,
    preregistration_config_hash: preregistrationConfigHash,
  });
  const config_hash = createHash("sha256").update(stableJson(payload), "utf8").digest("hex");
  return Object.freeze({ ...payload, config_hash });
}
