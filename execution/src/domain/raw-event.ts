import { createHash } from "node:crypto";

export const RAW_EVENT_SCHEMA_VERSION = "raw-event-v1" as const;

export type ParserStatus = "parsed" | "unparsed" | "error" | "quarantined";

export interface RawEventEnvelopeDraftV1 {
  readonly schema_version: typeof RAW_EVENT_SCHEMA_VERSION;
  readonly event_id: string;
  readonly source: string;
  readonly stream: string;
  readonly event_type: string;
  readonly connection_id: string;
  readonly subscription_id: string;
  readonly market_id: string | null;
  readonly condition_id: string | null;
  readonly asset_id: string | null;
  readonly source_time: string | null;
  readonly server_time: string | null;
  readonly receive_time: string;
  readonly process_time: string;
  readonly source_sequence: string | null;
  readonly source_hash: string | null;
  readonly raw_payload: string;
  readonly raw_sha256: string;
  readonly parser_status: ParserStatus;
  readonly parser_error: string | null;
}

export interface RawEventEnvelopeV1 extends RawEventEnvelopeDraftV1 {
  readonly persist_time: string;
}

export interface CreateEnvelopeDraftInput {
  readonly eventId: string;
  readonly source: string;
  readonly stream: string;
  readonly eventType: string;
  readonly connectionId: string;
  readonly subscriptionId: string;
  readonly marketId?: string | null;
  readonly conditionId?: string | null;
  readonly assetId?: string | null;
  readonly sourceTime?: string | null;
  readonly serverTime?: string | null;
  readonly receiveTime: string;
  readonly processTime: string;
  readonly sourceSequence?: string | null;
  readonly sourceHash?: string | null;
  readonly rawPayload: string;
  readonly parserStatus: ParserStatus;
  readonly parserError?: string | null;
}

const REQUIRED_FIELDS = [
  "schema_version",
  "event_id",
  "source",
  "stream",
  "event_type",
  "connection_id",
  "subscription_id",
  "market_id",
  "condition_id",
  "asset_id",
  "source_time",
  "server_time",
  "receive_time",
  "process_time",
  "persist_time",
  "source_sequence",
  "source_hash",
  "raw_payload",
  "raw_sha256",
  "parser_status",
  "parser_error",
] as const;

// RawEventEnvelope v1 deliberately has one wire representation. Milliseconds
// are mandatory so TypeScript and Python compare exactly the same instants.
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256 = /^[0-9a-f]{64}$/;

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireNullableString(value: unknown, field: string): string | null {
  return value === null ? null : requireString(value, field);
}

export function requireUtcIso(value: unknown, field: string): string {
  const text = requireString(value, field);
  const epoch = Date.parse(text);
  if (!UTC_ISO.test(text) || !Number.isFinite(epoch) || new Date(epoch).toISOString() !== text) {
    throw new Error(`${field} must be canonical UTC YYYY-MM-DDTHH:mm:ss.SSSZ`);
  }
  return text;
}

function nullableUtcIso(value: unknown, field: string): string | null {
  return value === null ? null : requireUtcIso(value, field);
}

export function rawSha256(rawPayload: string): string {
  return createHash("sha256").update(rawPayload, "utf8").digest("hex");
}

function validateParserState(status: ParserStatus, parserError: string | null): void {
  if (status === "error" && parserError === null) {
    throw new Error("parser_error is required when parser_status=error");
  }
  if (status !== "error" && parserError !== null) {
    throw new Error("parser_error is only valid when parser_status=error");
  }
}

export function createEnvelopeDraft(input: CreateEnvelopeDraftInput): RawEventEnvelopeDraftV1 {
  const receiveTime = requireUtcIso(input.receiveTime, "receive_time");
  const processTime = requireUtcIso(input.processTime, "process_time");
  if (Date.parse(processTime) < Date.parse(receiveTime)) {
    throw new Error("process_time must not precede receive_time");
  }
  const parserError = input.parserError ?? null;
  validateParserState(input.parserStatus, parserError);
  return Object.freeze({
    schema_version: RAW_EVENT_SCHEMA_VERSION,
    event_id: requireString(input.eventId, "event_id"),
    source: requireString(input.source, "source"),
    stream: requireString(input.stream, "stream"),
    event_type: requireString(input.eventType, "event_type"),
    connection_id: requireString(input.connectionId, "connection_id"),
    subscription_id: requireString(input.subscriptionId, "subscription_id"),
    market_id: input.marketId ?? null,
    condition_id: input.conditionId ?? null,
    asset_id: input.assetId ?? null,
    source_time: input.sourceTime === undefined ? null : nullableUtcIso(input.sourceTime, "source_time"),
    server_time: input.serverTime === undefined ? null : nullableUtcIso(input.serverTime, "server_time"),
    receive_time: receiveTime,
    process_time: processTime,
    source_sequence: input.sourceSequence ?? null,
    source_hash: input.sourceHash ?? null,
    raw_payload: input.rawPayload,
    raw_sha256: rawSha256(input.rawPayload),
    parser_status: input.parserStatus,
    parser_error: parserError,
  });
}

export function persistEnvelope(
  draft: RawEventEnvelopeDraftV1,
  persistTimeValue: string,
): RawEventEnvelopeV1 {
  const persistTime = requireUtcIso(persistTimeValue, "persist_time");
  if (Date.parse(persistTime) < Date.parse(draft.process_time)) {
    throw new Error("persist_time must not precede process_time");
  }
  return Object.freeze({ ...draft, persist_time: persistTime });
}

export function parsePersistedEnvelope(line: string): RawEventEnvelopeV1 {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error("RawEventEnvelope is not valid JSON", { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("RawEventEnvelope must be an object");
  }
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record);
  const required = new Set<string>(REQUIRED_FIELDS);
  const missing = REQUIRED_FIELDS.filter((field) => !(field in record));
  const unknown = fields.filter((field) => !required.has(field));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(`RawEventEnvelope field mismatch: missing=${missing.join(",")} unknown=${unknown.join(",")}`);
  }
  if (record.schema_version !== RAW_EVENT_SCHEMA_VERSION) {
    throw new Error("unsupported RawEventEnvelope schema_version");
  }
  const parserStatus = record.parser_status;
  if (
    parserStatus !== "parsed" &&
    parserStatus !== "unparsed" &&
    parserStatus !== "error" &&
    parserStatus !== "quarantined"
  ) {
    throw new Error("invalid parser_status");
  }
  const parserError = requireNullableString(record.parser_error, "parser_error");
  validateParserState(parserStatus, parserError);
  if (typeof record.raw_payload !== "string") {
    throw new Error("raw_payload must be a string");
  }
  const digest = requireString(record.raw_sha256, "raw_sha256");
  if (!SHA256.test(digest) || rawSha256(record.raw_payload) !== digest) {
    throw new Error("raw_sha256 does not match raw_payload");
  }
  const receiveTime = requireUtcIso(record.receive_time, "receive_time");
  const processTime = requireUtcIso(record.process_time, "process_time");
  const persistTime = requireUtcIso(record.persist_time, "persist_time");
  if (Date.parse(processTime) < Date.parse(receiveTime) || Date.parse(persistTime) < Date.parse(processTime)) {
    throw new Error("local event clocks are out of causal order");
  }
  return Object.freeze({
    schema_version: RAW_EVENT_SCHEMA_VERSION,
    event_id: requireString(record.event_id, "event_id"),
    source: requireString(record.source, "source"),
    stream: requireString(record.stream, "stream"),
    event_type: requireString(record.event_type, "event_type"),
    connection_id: requireString(record.connection_id, "connection_id"),
    subscription_id: requireString(record.subscription_id, "subscription_id"),
    market_id: requireNullableString(record.market_id, "market_id"),
    condition_id: requireNullableString(record.condition_id, "condition_id"),
    asset_id: requireNullableString(record.asset_id, "asset_id"),
    source_time: nullableUtcIso(record.source_time, "source_time"),
    server_time: nullableUtcIso(record.server_time, "server_time"),
    receive_time: receiveTime,
    process_time: processTime,
    persist_time: persistTime,
    source_sequence: requireNullableString(record.source_sequence, "source_sequence"),
    source_hash: requireNullableString(record.source_hash, "source_hash"),
    raw_payload: record.raw_payload,
    raw_sha256: digest,
    parser_status: parserStatus,
    parser_error: parserError,
  });
}
