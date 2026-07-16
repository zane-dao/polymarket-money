import { createHash } from "node:crypto";

import { Money } from "../domain/money.js";

export const LEAD_LAG_CONFIG_VERSION = "lead-lag-config-v1" as const;
export const EPISODE_RULE_VERSION = "lead-lag-episode-v1" as const;
export const EPISODE_GAP_MS = 500 as const;

export const LEAD_LAG_SOURCES = Object.freeze([
  "POLYMARKET_RTDS_CHAINLINK",
  "POLYMARKET_RTDS_BINANCE",
  "BINANCE_SPOT",
  "BINANCE_PERPETUAL",
] as const);
export const LEAD_LAG_THRESHOLDS_BPS = Object.freeze(["1", "2", "5"] as const);
export const LEAD_LAG_TRIGGER_WINDOWS_MS = Object.freeze([100, 250, 500] as const);
export const LEAD_LAG_HORIZONS_MS = Object.freeze([50, 100, 250, 500, 1000, 2000, 3000] as const);

export type LeadLagSource = typeof LEAD_LAG_SOURCES[number];
export type LeadLagThresholdBps = typeof LEAD_LAG_THRESHOLDS_BPS[number];
export type LeadLagTriggerWindowMs = typeof LEAD_LAG_TRIGGER_WINDOWS_MS[number];
export type LeadLagHorizonMs = typeof LEAD_LAG_HORIZONS_MS[number];
export type LeadLagDirection = "UP" | "DOWN";

declare const EXTERNAL_CONNECTION_ID: unique symbol;
declare const POLYMARKET_CONNECTION_ID: unique symbol;
export type ExternalConnectionId = string & { readonly [EXTERNAL_CONNECTION_ID]: true };
export type PolymarketConnectionId = string & { readonly [POLYMARKET_CONNECTION_ID]: true };

export function externalConnectionId(value: string): ExternalConnectionId {
  return nonEmpty(value, "external_connection_id") as ExternalConnectionId;
}

export function polymarketConnectionId(value: string): PolymarketConnectionId {
  return nonEmpty(value, "polymarket_connection_id") as PolymarketConnectionId;
}

export interface LeadLagStamp {
  readonly clock_domain: string;
  readonly local_monotonic_receive_ns: string;
  readonly local_receive_ordinal: string;
}

export interface ExternalPriceState {
  readonly external_event_id: string;
  readonly source: LeadLagSource;
  readonly price: string;
  readonly receive_stamp: LeadLagStamp;
  readonly external_connection_id: ExternalConnectionId;
  readonly parent_input_reference: string;
  readonly input_hash: string;
  readonly quality: {
    readonly stale: boolean;
    readonly disconnected: boolean;
    readonly quarantined: boolean;
  };
}

export interface PolymarketBookState {
  readonly market_id: string;
  readonly bid: string;
  readonly ask: string;
  readonly mid_price: string;
  readonly receive_stamp: LeadLagStamp;
  readonly polymarket_connection_id: PolymarketConnectionId;
  readonly parent_input_reference: string;
  readonly input_hash: string;
  readonly quality: {
    readonly snapshot: boolean;
    readonly stale: boolean;
    readonly disconnected: boolean;
    readonly crossed: boolean;
    readonly empty_side: boolean;
    readonly quarantined: boolean;
  };
}

export interface LeadLagConfig {
  readonly schema_version: typeof LEAD_LAG_CONFIG_VERSION;
  readonly sources: readonly LeadLagSource[];
  readonly thresholds_bps: readonly LeadLagThresholdBps[];
  readonly trigger_windows_ms: readonly LeadLagTriggerWindowMs[];
  readonly horizons_ms: readonly LeadLagHorizonMs[];
  readonly baseline_max_age_ms: number;
  readonly horizon_state_max_age_ms: number;
  readonly episode_rule_version: typeof EPISODE_RULE_VERSION;
  readonly episode_gap_ms: typeof EPISODE_GAP_MS;
  readonly grouping_dimensions: readonly [
    "source", "direction", "market_id", "clock_domain",
    "external_connection_id", "polymarket_connection_id",
  ];
  readonly connection_reset_behavior: "END_EPISODE_AND_CENSOR_PENDING";
  readonly config_hash: string;
}

export interface LeadLagTrigger {
  readonly trigger_id: string;
  readonly external_event_id: string;
  readonly trigger_episode_id: string;
  readonly parent_input_reference: string;
  readonly external_parent_input_reference: string;
  readonly external_input_hash: string;
  readonly overlapping_trigger_group: string;
  readonly source: LeadLagSource;
  readonly threshold: LeadLagThresholdBps;
  readonly window: LeadLagTriggerWindowMs;
  readonly direction: LeadLagDirection;
  readonly market_id: string;
  readonly clock_domain: string;
  readonly external_connection_id: ExternalConnectionId;
  readonly polymarket_connection_id: PolymarketConnectionId;
  readonly trigger_receive_stamp: LeadLagStamp;
  readonly baseline_target_time: LeadLagStamp;
  readonly baseline_observation_time: LeadLagStamp;
  readonly baseline_age_ms: number;
  readonly effective_window_ms: number;
  readonly baseline_price: string;
  readonly external_price: string;
  readonly change_bps: string;
  readonly polymarket_snapshot_time: LeadLagStamp;
  readonly polymarket_snapshot_mid_price: string;
  readonly polymarket_parent_input_reference: string;
  readonly polymarket_input_hash: string;
  readonly config_hash: string;
}

export type TriggerRejectionReason =
  | "EXTERNAL_EVENT_NOT_FOUND"
  | "EXTERNAL_EVENT_QUALITY_REJECTED"
  | "BASELINE_NOT_FOUND"
  | "BASELINE_CONNECTION_MISMATCH"
  | "BASELINE_QUALITY_REJECTED"
  | "BASELINE_TOO_OLD"
  | "BASELINE_PRICE_ZERO"
  | "TRIGGER_SNAPSHOT_NOT_FOUND"
  | "TRIGGER_SNAPSHOT_CONNECTION_RESET"
  | "TRIGGER_SNAPSHOT_QUALITY_REJECTED";

export interface TriggerRejection {
  readonly external_event_id: string;
  readonly source: LeadLagSource;
  readonly window: LeadLagTriggerWindowMs;
  readonly reason: TriggerRejectionReason;
}

export interface TriggerBatch {
  readonly triggers: readonly LeadLagTrigger[];
  readonly rejections: readonly TriggerRejection[];
}

export type HorizonCensorReason =
  | "EXTERNAL_CONNECTION_CHANGED"
  | "EXTERNAL_QUALITY_REJECTED"
  | "POLYMARKET_CONNECTION_CHANGED"
  | "HORIZON_STATE_NOT_FOUND"
  | "HORIZON_QUALITY_REJECTED"
  | "HORIZON_STATE_TOO_OLD";

export interface NextUpdateAfterHorizon {
  readonly next_update_delay_ms: number;
  readonly update_direction: LeadLagDirection | "UNCHANGED";
  readonly update_magnitude: string;
  readonly observation_time: LeadLagStamp;
}

export interface HorizonObservation {
  readonly trigger_id: string;
  readonly external_event_id: string;
  readonly trigger_episode_id: string;
  readonly external_parent_input_reference: string;
  readonly external_input_hash: string;
  readonly trigger_polymarket_parent_input_reference: string;
  readonly trigger_polymarket_input_hash: string;
  readonly horizon_state_parent_input_reference: string | null;
  readonly horizon_state_input_hash: string | null;
  readonly source: LeadLagSource;
  readonly market_id: string;
  readonly threshold: LeadLagThresholdBps;
  readonly window: LeadLagTriggerWindowMs;
  readonly direction: LeadLagDirection;
  readonly clock_domain: string;
  readonly external_connection_id: ExternalConnectionId;
  readonly polymarket_connection_id: PolymarketConnectionId;
  readonly trigger_receive_stamp: LeadLagStamp;
  readonly config_hash: string;
  readonly horizon_ms: LeadLagHorizonMs;
  readonly target_time: LeadLagStamp;
  readonly censored: boolean;
  readonly censor_reason: HorizonCensorReason | null;
  readonly state_observation_time: LeadLagStamp | null;
  readonly state_age_ms: number | null;
  readonly markout_mid_price: string | null;
  readonly markout_direction: LeadLagDirection | "UNCHANGED" | null;
  readonly markout_magnitude: string | null;
  readonly next_update_after_horizon: NextUpdateAfterHorizon | null;
}

export interface EpisodeIdentity {
  readonly source: LeadLagSource;
  readonly direction: LeadLagDirection;
  readonly market_id: string;
  readonly clock_domain: string;
  readonly external_connection_id: ExternalConnectionId;
  readonly polymarket_connection_id: PolymarketConnectionId;
}

export interface EpisodeAssignment extends EpisodeIdentity {
  readonly external_event_id: string;
  readonly receive_stamp: LeadLagStamp;
}

export interface EpisodeSummary extends EpisodeIdentity {
  readonly episode_rule_version: typeof EPISODE_RULE_VERSION;
  readonly trigger_episode_id: string;
  readonly start_time: LeadLagStamp;
  readonly end_time: LeadLagStamp;
  readonly duration_ms: number;
  readonly trigger_count: number;
}

export interface LeadLagGridCell {
  readonly source: LeadLagSource;
  readonly threshold: LeadLagThresholdBps;
  readonly window: LeadLagTriggerWindowMs;
  readonly horizon: LeadLagHorizonMs;
  readonly raw_trigger_count: number;
  readonly completed_horizon_count: number;
  readonly censored_horizon_count: number;
}

interface ExternalConnectionReset {
  readonly source: LeadLagSource;
  readonly receive_stamp: LeadLagStamp;
}

interface PolymarketConnectionReset {
  readonly market_id: string;
  readonly receive_stamp: LeadLagStamp;
}

interface PolymarketQualityFailure {
  readonly market_id: string;
  readonly receive_stamp: LeadLagStamp;
  readonly polymarket_connection_id: PolymarketConnectionId;
  readonly parent_input_reference: string;
  readonly input_hash: string;
}

const UNSIGNED_INTEGER = /^(?:0|[1-9]\d*)$/u;
const POSITIVE_INTEGER = /^[1-9]\d*$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be non-empty`);
  return value;
}

function inputHash(value: unknown, field: string): string {
  const result = nonEmpty(value, field);
  if (!SHA256.test(result)) throw new Error(`${field} must be a lowercase sha256`);
  return result;
}

function stamp(value: LeadLagStamp, field: string): LeadLagStamp {
  const clock = nonEmpty(value.clock_domain, `${field}.clock_domain`);
  if (!UNSIGNED_INTEGER.test(value.local_monotonic_receive_ns)) {
    throw new Error(`${field}.local_monotonic_receive_ns must be a canonical non-negative integer`);
  }
  if (!POSITIVE_INTEGER.test(value.local_receive_ordinal)) {
    throw new Error(`${field}.local_receive_ordinal must be a canonical positive integer`);
  }
  return Object.freeze({
    clock_domain: clock,
    local_monotonic_receive_ns: value.local_monotonic_receive_ns,
    local_receive_ordinal: value.local_receive_ordinal,
  });
}

function compare(left: LeadLagStamp, right: LeadLagStamp): -1 | 0 | 1 {
  if (left.clock_domain !== right.clock_domain) throw new Error("ReceiveStamp clock domains are not comparable");
  const leftNs = BigInt(left.local_monotonic_receive_ns);
  const rightNs = BigInt(right.local_monotonic_receive_ns);
  if (leftNs !== rightNs) return leftNs < rightNs ? -1 : 1;
  const leftOrdinal = BigInt(left.local_receive_ordinal);
  const rightOrdinal = BigInt(right.local_receive_ordinal);
  return leftOrdinal === rightOrdinal ? 0 : leftOrdinal < rightOrdinal ? -1 : 1;
}

function millisecondsBetween(later: LeadLagStamp, earlier: LeadLagStamp): number {
  if (later.clock_domain !== earlier.clock_domain) throw new Error("ReceiveStamp clock domains are not comparable");
  const delta = BigInt(later.local_monotonic_receive_ns) - BigInt(earlier.local_monotonic_receive_ns);
  if (delta < 0n) throw new Error("time delta must not be negative");
  const value = Number(delta) / 1_000_000;
  if (!Number.isFinite(value) || !Number.isSafeInteger(Number(delta))) {
    throw new Error("time delta exceeds exact supported range");
  }
  return value;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function maxAge(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return value;
}

export function createLeadLagConfig(options: {
  readonly baselineMaxAgeMs?: number;
  readonly horizonStateMaxAgeMs?: number;
} = {}): LeadLagConfig {
  const payload = Object.freeze({
    schema_version: LEAD_LAG_CONFIG_VERSION,
    sources: LEAD_LAG_SOURCES,
    thresholds_bps: LEAD_LAG_THRESHOLDS_BPS,
    trigger_windows_ms: LEAD_LAG_TRIGGER_WINDOWS_MS,
    horizons_ms: LEAD_LAG_HORIZONS_MS,
    baseline_max_age_ms: maxAge(options.baselineMaxAgeMs ?? 100, "baselineMaxAgeMs"),
    horizon_state_max_age_ms: maxAge(options.horizonStateMaxAgeMs ?? 1000, "horizonStateMaxAgeMs"),
    episode_rule_version: EPISODE_RULE_VERSION,
    episode_gap_ms: EPISODE_GAP_MS,
    grouping_dimensions: Object.freeze([
      "source", "direction", "market_id", "clock_domain",
      "external_connection_id", "polymarket_connection_id",
    ] as const),
    connection_reset_behavior: "END_EPISODE_AND_CENSOR_PENDING" as const,
  });
  return Object.freeze({ ...payload, config_hash: digest(payload) });
}

export const DEFAULT_LEAD_LAG_CONFIG = createLeadLagConfig();

function externalQualityPass(value: ExternalPriceState): boolean {
  return !value.quality.stale && !value.quality.disconnected && !value.quality.quarantined;
}

function bookQualityPass(value: PolymarketBookState): boolean {
  return value.quality.snapshot
    && !value.quality.stale
    && !value.quality.disconnected
    && !value.quality.crossed
    && !value.quality.empty_side
    && !value.quality.quarantined;
}

function signedDirection(value: Money): LeadLagDirection | "UNCHANGED" {
  const comparison = value.comparedTo(Money.from("0"));
  return comparison === 0 ? "UNCHANGED" : comparison > 0 ? "UP" : "DOWN";
}

interface MutableEpisode {
  readonly identity: EpisodeIdentity;
  readonly id: string;
  readonly start: LeadLagStamp;
  end: LeadLagStamp;
  triggerCount: number;
}

function episodeKey(value: EpisodeIdentity): string {
  return stableJson(value);
}

export class EpisodeTracker {
  readonly #active = new Map<string, MutableEpisode>();
  readonly #episodes: MutableEpisode[] = [];

  assign(input: EpisodeAssignment): string {
    const receive = stamp(input.receive_stamp, "episode.receive_stamp");
    const identity: EpisodeIdentity = Object.freeze({
      source: input.source,
      direction: input.direction,
      market_id: nonEmpty(input.market_id, "episode.market_id"),
      clock_domain: nonEmpty(input.clock_domain, "episode.clock_domain"),
      external_connection_id: externalConnectionId(input.external_connection_id),
      polymarket_connection_id: polymarketConnectionId(input.polymarket_connection_id),
    });
    if (receive.clock_domain !== identity.clock_domain) throw new Error("episode ReceiveStamp clock domain mismatch");
    nonEmpty(input.external_event_id, "episode.external_event_id");
    const key = episodeKey(identity);
    for (const [activeKey, active] of this.#active) {
      const sameSource = active.identity.source === identity.source;
      const marketChanged = active.identity.market_id !== identity.market_id;
      const groupingReset = active.identity.direction !== identity.direction
        || active.identity.clock_domain !== identity.clock_domain
        || active.identity.external_connection_id !== identity.external_connection_id
        || active.identity.polymarket_connection_id !== identity.polymarket_connection_id;
      if (sameSource && (marketChanged || groupingReset)) this.#active.delete(activeKey);
    }
    let episode = this.#active.get(key);
    if (episode !== undefined && millisecondsBetween(receive, episode.end) > EPISODE_GAP_MS) {
      this.#active.delete(key);
      episode = undefined;
    }
    if (episode === undefined) {
      const id = digest({ episode_rule_version: EPISODE_RULE_VERSION, identity, start: receive });
      episode = { identity, id, start: receive, end: receive, triggerCount: 0 };
      this.#active.set(key, episode);
      this.#episodes.push(episode);
    }
    if (compare(receive, episode.end) < 0) throw new Error("episode triggers must be assigned in ReceiveStamp order");
    episode.end = receive;
    episode.triggerCount += 1;
    return episode.id;
  }

  endSource(source: LeadLagSource): void {
    for (const [key, active] of this.#active) {
      if (active.identity.source === source) this.#active.delete(key);
    }
  }

  endMarket(marketId: string): void {
    const target = nonEmpty(marketId, "market_id");
    for (const [key, active] of this.#active) {
      if (active.identity.market_id === target) this.#active.delete(key);
    }
  }

  summaries(): readonly EpisodeSummary[] {
    return Object.freeze(this.#episodes.map((episode) => Object.freeze({
      episode_rule_version: EPISODE_RULE_VERSION,
      trigger_episode_id: episode.id,
      ...episode.identity,
      start_time: episode.start,
      end_time: episode.end,
      duration_ms: millisecondsBetween(episode.end, episode.start),
      trigger_count: episode.triggerCount,
    })));
  }
}

function latestAtOrBefore<T extends { readonly receive_stamp: LeadLagStamp }>(
  values: readonly T[],
  watermark: LeadLagStamp,
): T | null {
  let latest: T | null = null;
  for (const value of values) {
    if (value.receive_stamp.clock_domain !== watermark.clock_domain) continue;
    if (compare(value.receive_stamp, watermark) <= 0
      && (latest === null || compare(value.receive_stamp, latest.receive_stamp) > 0)) {
      latest = value;
    }
  }
  return latest;
}

function firstAfter<T extends { readonly receive_stamp: LeadLagStamp }>(
  values: readonly T[],
  watermark: LeadLagStamp,
): T | null {
  let first: T | null = null;
  for (const value of values) {
    if (value.receive_stamp.clock_domain !== watermark.clock_domain) continue;
    if (compare(value.receive_stamp, watermark) > 0
      && (first === null || compare(value.receive_stamp, first.receive_stamp) < 0)) {
      first = value;
    }
  }
  return first;
}

function targetStamp(event: LeadLagStamp, milliseconds: number, watermark: LeadLagStamp): LeadLagStamp {
  if (event.clock_domain !== watermark.clock_domain) throw new Error("target watermark clock domain mismatch");
  const expected = BigInt(event.local_monotonic_receive_ns) + BigInt(milliseconds) * 1_000_000n;
  if (BigInt(watermark.local_monotonic_receive_ns) !== expected) {
    throw new Error("target watermark monotonic time does not match the pre-registered horizon");
  }
  return stamp(watermark, "targetWatermark");
}

export class LeadLagEngine {
  readonly #config: LeadLagConfig;
  readonly #external: ExternalPriceState[] = [];
  readonly #books: PolymarketBookState[] = [];
  readonly #externalById = new Map<string, ExternalPriceState>();
  readonly #triggers = new Map<string, LeadLagTrigger>();
  readonly #externalResets: ExternalConnectionReset[] = [];
  readonly #polymarketResets: PolymarketConnectionReset[] = [];
  readonly #polymarketQualityFailures: PolymarketQualityFailure[] = [];
  readonly #episodes = new EpisodeTracker();
  readonly #seenOrdinals = new Map<string, string>();
  readonly #horizons: HorizonObservation[] = [];

  constructor(config: LeadLagConfig) {
    this.#config = config;
    if (stableJson(config.sources) !== stableJson(LEAD_LAG_SOURCES)
      || stableJson(config.thresholds_bps) !== stableJson(LEAD_LAG_THRESHOLDS_BPS)
      || stableJson(config.trigger_windows_ms) !== stableJson(LEAD_LAG_TRIGGER_WINDOWS_MS)
      || stableJson(config.horizons_ms) !== stableJson(LEAD_LAG_HORIZONS_MS)
      || config.episode_rule_version !== EPISODE_RULE_VERSION
      || config.episode_gap_ms !== EPISODE_GAP_MS
      || config.connection_reset_behavior !== "END_EPISODE_AND_CENSOR_PENDING") {
      throw new Error("lead-lag pre-registration is frozen");
    }
    if (digest({
      schema_version: config.schema_version,
      sources: config.sources,
      thresholds_bps: config.thresholds_bps,
      trigger_windows_ms: config.trigger_windows_ms,
      horizons_ms: config.horizons_ms,
      baseline_max_age_ms: config.baseline_max_age_ms,
      horizon_state_max_age_ms: config.horizon_state_max_age_ms,
      episode_rule_version: config.episode_rule_version,
      episode_gap_ms: config.episode_gap_ms,
      grouping_dimensions: config.grouping_dimensions,
      connection_reset_behavior: config.connection_reset_behavior,
    }) !== config.config_hash) throw new Error("lead-lag config hash mismatch");
  }

  #registerReceiveStamp(value: LeadLagStamp): LeadLagStamp {
    const received = stamp(value, "receive_stamp");
    const key = `${received.clock_domain}:${received.local_receive_ordinal}`;
    const priorNs = this.#seenOrdinals.get(key);
    if (priorNs !== undefined) throw new Error("local_receive_ordinal must be unique inside a clock domain");
    this.#seenOrdinals.set(key, received.local_monotonic_receive_ns);
    return received;
  }

  ingestExternal(value: ExternalPriceState): void {
    if (this.#externalById.has(value.external_event_id)) throw new Error("external_event_id must be unique");
    const received = this.#registerReceiveStamp(value.receive_stamp);
    const normalized: ExternalPriceState = Object.freeze({
      external_event_id: nonEmpty(value.external_event_id, "external_event_id"),
      source: value.source,
      price: Money.from(value.price).toCanonical(),
      receive_stamp: received,
      external_connection_id: externalConnectionId(value.external_connection_id),
      parent_input_reference: nonEmpty(value.parent_input_reference, "parent_input_reference"),
      input_hash: inputHash(value.input_hash, "input_hash"),
      quality: Object.freeze({ ...value.quality }),
    });
    if (!this.#config.sources.includes(normalized.source)) throw new Error("source is not pre-registered");
    this.#external.push(normalized);
    this.#externalById.set(normalized.external_event_id, normalized);
  }

  ingestPolymarket(value: PolymarketBookState): void {
    const received = this.#registerReceiveStamp(value.receive_stamp);
    const bid = Money.from(value.bid);
    const ask = Money.from(value.ask);
    const normalized: PolymarketBookState = Object.freeze({
      market_id: nonEmpty(value.market_id, "market_id"),
      bid: bid.toCanonical(),
      ask: ask.toCanonical(),
      mid_price: Money.from(value.mid_price).toCanonical(),
      receive_stamp: received,
      polymarket_connection_id: polymarketConnectionId(value.polymarket_connection_id),
      parent_input_reference: nonEmpty(value.parent_input_reference, "parent_input_reference"),
      input_hash: inputHash(value.input_hash, "input_hash"),
      quality: Object.freeze({ ...value.quality }),
    });
    if (!normalized.quality.crossed && bid.comparedTo(ask) > 0) throw new Error("uncrossed book has bid above ask");
    this.#books.push(normalized);
  }

  noteExternalConnectionReset(input: {
    readonly source: LeadLagSource;
    readonly receive_stamp: LeadLagStamp;
  }): void {
    if (!this.#config.sources.includes(input.source)) throw new Error("source is not pre-registered");
    this.#externalResets.push(Object.freeze({
      source: input.source,
      receive_stamp: this.#registerReceiveStamp(input.receive_stamp),
    }));
    this.#episodes.endSource(input.source);
  }

  notePolymarketConnectionReset(input: {
    readonly market_id: string;
    readonly receive_stamp: LeadLagStamp;
  }): void {
    this.#polymarketResets.push(Object.freeze({
      market_id: nonEmpty(input.market_id, "market_id"),
      receive_stamp: this.#registerReceiveStamp(input.receive_stamp),
    }));
    this.#episodes.endMarket(input.market_id);
  }

  notePolymarketQualityFailure(input: {
    readonly market_id: string;
    readonly receive_stamp: LeadLagStamp;
    readonly polymarket_connection_id: PolymarketConnectionId;
    readonly parent_input_reference: string;
    readonly input_hash: string;
  }): void {
    this.#polymarketQualityFailures.push(Object.freeze({
      market_id: nonEmpty(input.market_id, "market_id"),
      receive_stamp: this.#registerReceiveStamp(input.receive_stamp),
      polymarket_connection_id: polymarketConnectionId(input.polymarket_connection_id),
      parent_input_reference: nonEmpty(input.parent_input_reference, "parent_input_reference"),
      input_hash: inputHash(input.input_hash, "input_hash"),
    }));
  }

  createTriggers(input: {
    readonly externalEventId: string;
    readonly marketId: string;
    readonly baselineWatermarks: Readonly<Record<`${LeadLagTriggerWindowMs}`, LeadLagStamp>>;
  }): TriggerBatch {
    const event = this.#externalById.get(input.externalEventId);
    if (event === undefined) throw new Error("EXTERNAL_EVENT_NOT_FOUND");
    if (!externalQualityPass(event)) {
      return Object.freeze({ triggers: Object.freeze([]), rejections: Object.freeze([{
        external_event_id: event.external_event_id, source: event.source, window: 100 as const,
        reason: "EXTERNAL_EVENT_QUALITY_REJECTED" as const,
      }]) });
    }
    const marketId = nonEmpty(input.marketId, "marketId");
    const snapshot = latestAtOrBefore(
      this.#books.filter((item) => item.market_id === marketId),
      event.receive_stamp,
    );
    const latestPolymarketReset = latestAtOrBefore(
      this.#polymarketResets.filter((item) => item.market_id === marketId),
      event.receive_stamp,
    );
    const latestPolymarketQualityFailure = latestAtOrBefore(
      this.#polymarketQualityFailures.filter((item) => item.market_id === marketId),
      event.receive_stamp,
    );
    const triggers: LeadLagTrigger[] = [];
    const rejections: TriggerRejection[] = [];
    for (const window of this.#config.trigger_windows_ms) {
      const target = targetStamp(event.receive_stamp, -window, input.baselineWatermarks[String(window) as `${LeadLagTriggerWindowMs}`]);
      const sourceHistory = this.#external.filter((item) => item.source === event.source);
      const baseline = latestAtOrBefore(sourceHistory, target);
      let rejection: TriggerRejectionReason | null = null;
      if (baseline === null) rejection = "BASELINE_NOT_FOUND";
      else if (baseline.external_connection_id !== event.external_connection_id) rejection = "BASELINE_CONNECTION_MISMATCH";
      else if (!externalQualityPass(baseline)) rejection = "BASELINE_QUALITY_REJECTED";
      else if (millisecondsBetween(target, baseline.receive_stamp) > this.#config.baseline_max_age_ms) rejection = "BASELINE_TOO_OLD";
      else if (Money.from(baseline.price).isZero()) rejection = "BASELINE_PRICE_ZERO";
      else if (snapshot === null) rejection = "TRIGGER_SNAPSHOT_NOT_FOUND";
      else if (latestPolymarketReset !== null
        && compare(latestPolymarketReset.receive_stamp, snapshot.receive_stamp) > 0) {
        rejection = "TRIGGER_SNAPSHOT_CONNECTION_RESET";
      }
      else if (latestPolymarketQualityFailure !== null
        && compare(latestPolymarketQualityFailure.receive_stamp, snapshot.receive_stamp) > 0) {
        rejection = "TRIGGER_SNAPSHOT_QUALITY_REJECTED";
      }
      else if (!bookQualityPass(snapshot)) rejection = "TRIGGER_SNAPSHOT_QUALITY_REJECTED";
      if (rejection !== null || baseline === null || snapshot === null) {
        rejections.push(Object.freeze({
          external_event_id: event.external_event_id,
          source: event.source,
          window,
          reason: rejection ?? "BASELINE_NOT_FOUND",
        }));
        continue;
      }
      const baselinePrice = Money.from(baseline.price);
      const change = Money.from(event.price).minus(baselinePrice).dividedBy(baselinePrice).times(Money.from("10000"));
      const direction = signedDirection(change);
      if (direction === "UNCHANGED") continue;
      for (const threshold of this.#config.thresholds_bps) {
        if (change.abs().comparedTo(Money.from(threshold)) < 0) continue;
        const identity = {
          source: event.source,
          direction,
          market_id: marketId,
          clock_domain: event.receive_stamp.clock_domain,
          external_connection_id: event.external_connection_id,
          polymarket_connection_id: snapshot.polymarket_connection_id,
        } as const;
        const triggerPayload = {
          external_event_id: event.external_event_id,
          parent_input_reference: event.parent_input_reference,
          external_parent_input_reference: event.parent_input_reference,
          external_input_hash: event.input_hash,
          overlapping_trigger_group: event.external_event_id,
          ...identity,
          threshold,
          window,
          trigger_receive_stamp: event.receive_stamp,
          baseline_target_time: target,
          baseline_observation_time: baseline.receive_stamp,
          baseline_age_ms: millisecondsBetween(target, baseline.receive_stamp),
          effective_window_ms: millisecondsBetween(event.receive_stamp, baseline.receive_stamp),
          baseline_price: baseline.price,
          external_price: event.price,
          change_bps: change.toCanonical(),
          polymarket_snapshot_time: snapshot.receive_stamp,
          polymarket_snapshot_mid_price: snapshot.mid_price,
          polymarket_parent_input_reference: snapshot.parent_input_reference,
          polymarket_input_hash: snapshot.input_hash,
          config_hash: this.#config.config_hash,
        };
        const trigger_id = digest(triggerPayload);
        const trigger_episode_id = this.#episodes.assign({
          ...identity,
          external_event_id: event.external_event_id,
          receive_stamp: event.receive_stamp,
        });
        const trigger = Object.freeze({ ...triggerPayload, trigger_id, trigger_episode_id });
        this.#triggers.set(trigger_id, trigger);
        triggers.push(trigger);
      }
    }
    return Object.freeze({ triggers: Object.freeze(triggers), rejections: Object.freeze(rejections) });
  }

  trigger(triggerId: string): LeadLagTrigger {
    const result = this.#triggers.get(triggerId);
    if (result === undefined) throw new Error("trigger_id is unknown");
    return result;
  }

  #censored(
    trigger: LeadLagTrigger,
    horizon: LeadLagHorizonMs,
    target: LeadLagStamp,
    reason: HorizonCensorReason,
    state: Pick<PolymarketBookState, "receive_stamp" | "parent_input_reference" | "input_hash"> | null = null,
  ): HorizonObservation {
    const result = Object.freeze({
      trigger_id: trigger.trigger_id,
      external_event_id: trigger.external_event_id,
      trigger_episode_id: trigger.trigger_episode_id,
      external_parent_input_reference: trigger.external_parent_input_reference,
      external_input_hash: trigger.external_input_hash,
      trigger_polymarket_parent_input_reference: trigger.polymarket_parent_input_reference,
      trigger_polymarket_input_hash: trigger.polymarket_input_hash,
      horizon_state_parent_input_reference: state?.parent_input_reference ?? null,
      horizon_state_input_hash: state?.input_hash ?? null,
      source: trigger.source,
      market_id: trigger.market_id,
      threshold: trigger.threshold,
      window: trigger.window,
      direction: trigger.direction,
      clock_domain: trigger.clock_domain,
      external_connection_id: trigger.external_connection_id,
      polymarket_connection_id: trigger.polymarket_connection_id,
      trigger_receive_stamp: trigger.trigger_receive_stamp,
      config_hash: trigger.config_hash,
      horizon_ms: horizon,
      target_time: target,
      censored: true,
      censor_reason: reason,
      state_observation_time: state?.receive_stamp ?? null,
      state_age_ms: state === null ? null : millisecondsBetween(target, state.receive_stamp),
      markout_mid_price: null,
      markout_direction: null,
      markout_magnitude: null,
      next_update_after_horizon: null,
    });
    this.#horizons.push(result);
    return result;
  }

  evaluateHorizon(input: {
    readonly triggerId: string;
    readonly horizonMs: LeadLagHorizonMs;
    readonly targetWatermark: LeadLagStamp;
  }): HorizonObservation {
    const trigger = this.trigger(input.triggerId);
    if (!this.#config.horizons_ms.includes(input.horizonMs)) throw new Error("horizon is not pre-registered");
    const target = targetStamp(trigger.trigger_receive_stamp, input.horizonMs, input.targetWatermark);
    const externalReset = latestAtOrBefore(
      this.#externalResets.filter((item) => item.source === trigger.source),
      target,
    );
    if (externalReset !== null && compare(externalReset.receive_stamp, trigger.trigger_receive_stamp) > 0) {
      return this.#censored(trigger, input.horizonMs, target, "EXTERNAL_CONNECTION_CHANGED");
    }
    const polymarketReset = latestAtOrBefore(
      this.#polymarketResets.filter((item) => item.market_id === trigger.market_id),
      target,
    );
    if (polymarketReset !== null && compare(polymarketReset.receive_stamp, trigger.trigger_receive_stamp) > 0) {
      return this.#censored(trigger, input.horizonMs, target, "POLYMARKET_CONNECTION_CHANGED");
    }
    const externalLatest = latestAtOrBefore(
      this.#external.filter((item) => item.source === trigger.source),
      target,
    );
    if (externalLatest !== null && externalLatest.external_connection_id !== trigger.external_connection_id) {
      return this.#censored(trigger, input.horizonMs, target, "EXTERNAL_CONNECTION_CHANGED");
    }
    if (externalLatest !== null && !externalQualityPass(externalLatest)) {
      return this.#censored(trigger, input.horizonMs, target, "EXTERNAL_QUALITY_REJECTED");
    }
    const marketBooks = this.#books.filter((item) => item.market_id === trigger.market_id);
    const state = latestAtOrBefore(marketBooks, target);
    const qualityFailure = latestAtOrBefore(
      this.#polymarketQualityFailures.filter((item) => item.market_id === trigger.market_id),
      target,
    );
    if (qualityFailure !== null
      && compare(qualityFailure.receive_stamp, trigger.trigger_receive_stamp) > 0
      && (state === null || compare(qualityFailure.receive_stamp, state.receive_stamp) > 0)) {
      if (qualityFailure.polymarket_connection_id !== trigger.polymarket_connection_id) {
        return this.#censored(trigger, input.horizonMs, target, "POLYMARKET_CONNECTION_CHANGED", qualityFailure);
      }
      return this.#censored(trigger, input.horizonMs, target, "HORIZON_QUALITY_REJECTED", qualityFailure);
    }
    if (state === null) return this.#censored(trigger, input.horizonMs, target, "HORIZON_STATE_NOT_FOUND");
    if (state.polymarket_connection_id !== trigger.polymarket_connection_id) {
      return this.#censored(trigger, input.horizonMs, target, "POLYMARKET_CONNECTION_CHANGED", state);
    }
    if (!bookQualityPass(state)) {
      return this.#censored(trigger, input.horizonMs, target, "HORIZON_QUALITY_REJECTED", state);
    }
    const stateAge = millisecondsBetween(target, state.receive_stamp);
    if (stateAge > this.#config.horizon_state_max_age_ms) {
      return this.#censored(trigger, input.horizonMs, target, "HORIZON_STATE_TOO_OLD", state);
    }
    const magnitude = Money.from(state.mid_price).minus(Money.from(trigger.polymarket_snapshot_mid_price));
    const next = firstAfter(
      marketBooks.filter((item) =>
        item.polymarket_connection_id === trigger.polymarket_connection_id && bookQualityPass(item)),
      target,
    );
    const nextMetric = next === null ? null : Object.freeze({
      next_update_delay_ms: millisecondsBetween(next.receive_stamp, target),
      update_direction: signedDirection(Money.from(next.mid_price).minus(Money.from(state.mid_price))),
      update_magnitude: Money.from(next.mid_price).minus(Money.from(state.mid_price)).abs().toCanonical(),
      observation_time: next.receive_stamp,
    });
    const result = Object.freeze({
      trigger_id: trigger.trigger_id,
      external_event_id: trigger.external_event_id,
      trigger_episode_id: trigger.trigger_episode_id,
      external_parent_input_reference: trigger.external_parent_input_reference,
      external_input_hash: trigger.external_input_hash,
      trigger_polymarket_parent_input_reference: trigger.polymarket_parent_input_reference,
      trigger_polymarket_input_hash: trigger.polymarket_input_hash,
      horizon_state_parent_input_reference: state.parent_input_reference,
      horizon_state_input_hash: state.input_hash,
      source: trigger.source,
      market_id: trigger.market_id,
      threshold: trigger.threshold,
      window: trigger.window,
      direction: trigger.direction,
      clock_domain: trigger.clock_domain,
      external_connection_id: trigger.external_connection_id,
      polymarket_connection_id: trigger.polymarket_connection_id,
      trigger_receive_stamp: trigger.trigger_receive_stamp,
      config_hash: trigger.config_hash,
      horizon_ms: input.horizonMs,
      target_time: target,
      censored: false,
      censor_reason: null,
      state_observation_time: state.receive_stamp,
      state_age_ms: stateAge,
      markout_mid_price: state.mid_price,
      markout_direction: signedDirection(magnitude),
      markout_magnitude: magnitude.abs().toCanonical(),
      next_update_after_horizon: nextMetric,
    });
    this.#horizons.push(result);
    return result;
  }

  episodes(): readonly EpisodeSummary[] {
    return this.#episodes.summaries();
  }

  triggers(): readonly LeadLagTrigger[] {
    return Object.freeze([...this.#triggers.values()]);
  }

  grid(): readonly LeadLagGridCell[] {
    const triggers = [...this.#triggers.values()];
    return Object.freeze(this.#config.sources.flatMap((source) =>
      this.#config.thresholds_bps.flatMap((threshold) =>
        this.#config.trigger_windows_ms.flatMap((window) =>
          this.#config.horizons_ms.map((horizon) => {
            const cellTriggers = triggers.filter((item) =>
              item.source === source && item.threshold === threshold && item.window === window);
            const triggerIds = new Set(cellTriggers.map((item) => item.trigger_id));
            const observations = this.#horizons.filter((item) =>
              item.horizon_ms === horizon && triggerIds.has(item.trigger_id));
            return Object.freeze({
              source, threshold, window, horizon,
              raw_trigger_count: cellTriggers.length,
              completed_horizon_count: observations.filter((item) => !item.censored).length,
              censored_horizon_count: observations.filter((item) => item.censored).length,
            });
          }),
        ),
      ),
    ));
  }
}
