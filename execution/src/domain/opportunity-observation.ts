import { createHash } from "node:crypto";

import { requireUtcIso } from "./raw-event.js";

export const OPPORTUNITY_OBSERVATION_SCHEMA_VERSION = "opportunity-observation-v1" as const;
export const ROUTE_EVALUATION_SCHEMA_VERSION = "route-evaluation-v1" as const;

type CanonicalScalar = string | number | boolean | null;
export type CanonicalValue = CanonicalScalar | readonly CanonicalValue[] | CanonicalObject;
export interface CanonicalObject { readonly [key: string]: CanonicalValue }

export interface StoredReceiveStamp {
  readonly clock_domain: string;
  readonly local_monotonic_receive_ns: string;
  readonly local_receive_ordinal: string;
}

export interface OpportunityInputLineage {
  readonly source: string;
  readonly parent_input_reference: string;
  readonly input_hash: string;
  readonly receive_stamp: StoredReceiveStamp;
}

export interface OpportunityProvenance {
  readonly producer: string;
  readonly code_version: string;
  readonly config_hash: string;
}

export interface OpportunityQuality {
  readonly status: "PASS" | "DEGRADED" | "REJECTED";
  readonly rejection_reasons: readonly string[];
}

export interface OpportunityObservationV1 {
  readonly schema_version: typeof OPPORTUNITY_OBSERVATION_SCHEMA_VERSION;
  readonly observation_hash: string;
  readonly opportunity_family: string;
  readonly market_id: string;
  readonly observed_at_wall: string;
  readonly receive_stamp: StoredReceiveStamp;
  readonly input_lineage: readonly OpportunityInputLineage[];
  readonly provenance: OpportunityProvenance;
  readonly quality: OpportunityQuality;
  readonly facts: CanonicalObject;
}

export interface CreateOpportunityObservationInput {
  readonly opportunityFamily: string;
  readonly marketId: string;
  readonly observedAtWall: string;
  readonly receiveStamp: StoredReceiveStamp;
  readonly inputLineage: readonly {
    readonly source: string;
    readonly parent_input_reference: string;
    readonly input_hash: string;
    readonly receive_stamp: StoredReceiveStamp;
  }[];
  readonly provenance: {
    readonly producer: string;
    readonly codeVersion: string;
    readonly configHash: string;
  };
  readonly quality: {
    readonly status: "PASS" | "DEGRADED" | "REJECTED";
    readonly rejectionReasons: readonly string[];
  };
  readonly facts: Readonly<Record<string, unknown>>;
}

export interface RouteEvaluationV1 {
  readonly schema_version: typeof ROUTE_EVALUATION_SCHEMA_VERSION;
  readonly evaluation_hash: string;
  readonly route: string;
  readonly config_hash: string;
  readonly observation_hashes: readonly string[];
  readonly raw_trigger_count: number;
  readonly unique_episode_count: number;
  readonly unique_market_count: number;
  readonly decision: "DATA_INSUFFICIENT";
}

export interface CreateRouteEvaluationInput {
  readonly route: string;
  readonly configHash: string;
  readonly observationHashes: readonly string[];
  readonly rawTriggerCount: number;
  readonly uniqueEpisodeCount: number;
  readonly uniqueMarketCount: number;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const UNSIGNED_INTEGER = /^(?:0|[1-9]\d*)$/u;
const POSITIVE_INTEGER = /^[1-9]\d*$/u;

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, fields: readonly string[], field: string): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  const missing = fields.filter((key) => !(key in record));
  if (unknown.length > 0) throw new Error(`${field} contains unknown fields: ${unknown.join(",")}`);
  if (missing.length > 0) throw new Error(`${field} is missing fields: ${missing.join(",")}`);
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be non-empty`);
  return value;
}

function sha256(value: unknown, field: string): string {
  const text = nonEmpty(value, field);
  if (!SHA256.test(text)) throw new Error(`${field} must be a lowercase sha256`);
  return text;
}

function integerText(value: unknown, field: string, positive: boolean): string {
  const text = nonEmpty(value, field);
  if (!(positive ? POSITIVE_INTEGER : UNSIGNED_INTEGER).test(text)) {
    throw new Error(`${field} must be a canonical integer string`);
  }
  return text;
}

function stamp(value: unknown, field: string): StoredReceiveStamp {
  const record = object(value, field);
  exactKeys(record, ["clock_domain", "local_monotonic_receive_ns", "local_receive_ordinal"], field);
  return Object.freeze({
    clock_domain: nonEmpty(record.clock_domain, `${field}.clock_domain`),
    local_monotonic_receive_ns: integerText(record.local_monotonic_receive_ns, `${field}.local_monotonic_receive_ns`, false),
    local_receive_ordinal: integerText(record.local_receive_ordinal, `${field}.local_receive_ordinal`, true),
  });
}

function canonicalClone(value: unknown, field: string): CanonicalValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error(`${field} number must be a finite safe integer; exact decimals are strings`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item, index) => canonicalClone(item, `${field}[${index}]`)));
  }
  const record = object(value, field);
  const output: Record<string, CanonicalValue> = {};
  for (const key of Object.keys(record).sort()) {
    if (key.trim() === "") throw new Error(`${field} has an empty key`);
    output[key] = canonicalClone(record[key], `${field}.${key}`);
  }
  return Object.freeze(output);
}

function canonicalObject(value: unknown, field: string): CanonicalObject {
  const cloned = canonicalClone(value, field);
  if (cloned === null || typeof cloned !== "object" || Array.isArray(cloned)) {
    throw new Error(`${field} must be an object`);
  }
  return cloned as CanonicalObject;
}

function stableJson(value: CanonicalValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as CanonicalObject;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key] ?? null)}`).join(",")}}`;
}

function digest(value: CanonicalValue): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function quality(value: CreateOpportunityObservationInput["quality"]): OpportunityQuality {
  const status = value.status;
  if (!(["PASS", "DEGRADED", "REJECTED"] as const).includes(status)) {
    throw new Error("quality status is invalid");
  }
  const reasons = Object.freeze(value.rejectionReasons.map((reason, index) =>
    nonEmpty(reason, `quality.rejectionReasons[${index}]`)));
  if (status === "PASS" && reasons.length !== 0) throw new Error("PASS quality cannot have rejection reasons");
  if (status !== "PASS" && reasons.length === 0) throw new Error(`${status} quality requires a rejection reason`);
  return Object.freeze({ status, rejection_reasons: reasons });
}

const DRAFT_FIELDS = [
  "opportunityFamily", "marketId", "observedAtWall", "receiveStamp", "inputLineage",
  "provenance", "quality", "facts",
] as const;

export function createOpportunityObservationV1(input: CreateOpportunityObservationInput): OpportunityObservationV1 {
  const inputRecord = object(input, "OpportunityObservation draft");
  exactKeys(inputRecord, DRAFT_FIELDS, "OpportunityObservation draft");
  if (!Array.isArray(input.inputLineage) || input.inputLineage.length === 0) {
    throw new Error("inputLineage must contain at least one parent input");
  }
  const lineage = Object.freeze(input.inputLineage.map((item, index) => {
    const itemRecord = object(item, `inputLineage[${index}]`);
    exactKeys(itemRecord, ["source", "parent_input_reference", "input_hash", "receive_stamp"], `inputLineage[${index}]`);
    return Object.freeze({
      source: nonEmpty(item.source, `inputLineage[${index}].source`),
      parent_input_reference: nonEmpty(item.parent_input_reference, `inputLineage[${index}].parent_input_reference`),
      input_hash: sha256(item.input_hash, `inputLineage[${index}].input_hash`),
      receive_stamp: stamp(item.receive_stamp, `inputLineage[${index}].receive_stamp`),
    });
  }));
  const provenance = Object.freeze({
    producer: nonEmpty(input.provenance.producer, "provenance.producer"),
    code_version: nonEmpty(input.provenance.codeVersion, "provenance.codeVersion"),
    config_hash: sha256(input.provenance.configHash, "provenance.configHash"),
  });
  const payload = Object.freeze({
    schema_version: OPPORTUNITY_OBSERVATION_SCHEMA_VERSION,
    opportunity_family: nonEmpty(input.opportunityFamily, "opportunityFamily"),
    market_id: nonEmpty(input.marketId, "marketId"),
    observed_at_wall: requireUtcIso(input.observedAtWall, "observedAtWall"),
    receive_stamp: stamp(input.receiveStamp, "receiveStamp"),
    input_lineage: lineage,
    provenance,
    quality: quality(input.quality),
    facts: canonicalObject(input.facts, "facts"),
  });
  const observation_hash = digest(payload as unknown as CanonicalValue);
  return Object.freeze({ ...payload, observation_hash });
}

export function canonicalOpportunityObservationJson(observation: OpportunityObservationV1): string {
  return stableJson(observation as unknown as CanonicalValue);
}

export function parseOpportunityObservationV1(text: string): OpportunityObservationV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error("OpportunityObservationV1 is not valid JSON", { cause: error });
  }
  const record = object(parsed, "OpportunityObservationV1");
  exactKeys(record, [
    "schema_version", "observation_hash", "opportunity_family", "market_id", "observed_at_wall",
    "receive_stamp", "input_lineage", "provenance", "quality", "facts",
  ], "OpportunityObservationV1");
  if (record.schema_version !== OPPORTUNITY_OBSERVATION_SCHEMA_VERSION) throw new Error("unsupported observation schema");
  const provenance = object(record.provenance, "provenance");
  const parsedQuality = object(record.quality, "quality");
  if (!Array.isArray(record.input_lineage) || !Array.isArray(parsedQuality.rejection_reasons)) {
    throw new Error("observation arrays are invalid");
  }
  const rebuilt = createOpportunityObservationV1({
    opportunityFamily: nonEmpty(record.opportunity_family, "opportunity_family"),
    marketId: nonEmpty(record.market_id, "market_id"),
    observedAtWall: nonEmpty(record.observed_at_wall, "observed_at_wall"),
    receiveStamp: record.receive_stamp as StoredReceiveStamp,
    inputLineage: record.input_lineage as CreateOpportunityObservationInput["inputLineage"],
    provenance: {
      producer: nonEmpty(provenance.producer, "provenance.producer"),
      codeVersion: nonEmpty(provenance.code_version, "provenance.code_version"),
      configHash: nonEmpty(provenance.config_hash, "provenance.config_hash"),
    },
    quality: {
      status: parsedQuality.status as OpportunityQuality["status"],
      rejectionReasons: parsedQuality.rejection_reasons as string[],
    },
    facts: object(record.facts, "facts"),
  });
  if (sha256(record.observation_hash, "observation_hash") !== rebuilt.observation_hash) {
    throw new Error("observation_hash does not match canonical content");
  }
  return rebuilt;
}

function count(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return value;
}

export function createRouteEvaluationV1(input: CreateRouteEvaluationInput): RouteEvaluationV1 {
  exactKeys(object(input, "RouteEvaluation draft"), [
    "route", "configHash", "observationHashes", "rawTriggerCount", "uniqueEpisodeCount", "uniqueMarketCount",
  ], "RouteEvaluation draft");
  if (!Array.isArray(input.observationHashes) || input.observationHashes.length === 0) {
    throw new Error("observationHashes must not be empty");
  }
  const hashes = Object.freeze([...new Set(input.observationHashes.map((hash, index) =>
    sha256(hash, `observationHashes[${index}]`)))].sort());
  if (hashes.length !== input.observationHashes.length) throw new Error("observationHashes must be unique");
  const raw = count(input.rawTriggerCount, "rawTriggerCount");
  const episodes = count(input.uniqueEpisodeCount, "uniqueEpisodeCount");
  const markets = count(input.uniqueMarketCount, "uniqueMarketCount");
  if (episodes > raw || markets > raw) throw new Error("unique counts cannot exceed raw trigger count");
  const payload = Object.freeze({
    schema_version: ROUTE_EVALUATION_SCHEMA_VERSION,
    route: nonEmpty(input.route, "route"),
    config_hash: sha256(input.configHash, "configHash"),
    observation_hashes: hashes,
    raw_trigger_count: raw,
    unique_episode_count: episodes,
    unique_market_count: markets,
    decision: "DATA_INSUFFICIENT" as const,
  });
  return Object.freeze({ ...payload, evaluation_hash: digest(payload as unknown as CanonicalValue) });
}
