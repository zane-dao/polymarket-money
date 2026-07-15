import type { ParserStatus } from "../../domain/raw-event.js";

export interface DecimalLevel {
  readonly price: string;
  readonly size: string;
}

export interface ParsedPriceChange {
  readonly assetId: string;
  readonly price: string;
  readonly size: string;
  readonly side: "BUY" | "SELL";
  readonly sourceHash: string;
  readonly bestBid: string;
  readonly bestAsk: string;
  readonly deleteLevel: boolean;
}

export interface ParsedClobMarketMessage {
  readonly eventType: string;
  readonly parserStatus: ParserStatus;
  readonly parserError: string | null;
  readonly rawPayload: string;
  readonly conditionId: string | null;
  readonly assetId: string | null;
  readonly providerTimestampRaw: string | null;
  readonly sourceHash: string | null;
  readonly bids: readonly DecimalLevel[] | null;
  readonly asks: readonly DecimalLevel[] | null;
  readonly priceChanges: readonly ParsedPriceChange[] | null;
  readonly isGoldenSettlement: false;
}

export interface ParsedClobMarketFrame {
  readonly rawPayload: string;
  readonly shape: "single" | "batch_unverified" | "error";
  readonly messages: readonly ParsedClobMarketMessage[];
  readonly parserError: string | null;
}

export interface ParsedRtdsPriceMessage {
  readonly eventType: "rtds_price_update" | "rtds_message_quarantined" | "parse_error";
  readonly parserStatus: ParserStatus;
  readonly parserError: string | null;
  readonly quarantineReason: string | null;
  readonly rawPayload: string;
  readonly topic: string | null;
  readonly symbol: string | null;
  readonly sourceTime: string | null;
  readonly serverTime: string | null;
  readonly valueDecimal: string | null;
}

// The public CLOB documentation contains both `0.48` and `.48` price lexemes.
// Keep the provider lexeme in parsed messages while normalizing only when a
// decimal is used as an order-book map key.
const DECIMAL = /^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/;

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function array(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array`);
  }
  return value;
}

function decimal(value: unknown, field: string): string {
  const text = string(value, field);
  if (!DECIMAL.test(text)) {
    throw new Error(`${field} must be a non-negative decimal string`);
  }
  return text;
}

function decimalParts(value: string): readonly [string, string] {
  const [rawWhole = "0", fraction = ""] = value.split(".");
  const whole = rawWhole === "" ? "0" : rawWhole;
  return [whole.replace(/^0+(?=[0-9])/, ""), fraction.replace(/0+$/, "")];
}

export function canonicalDecimalString(value: string): string {
  const [whole, fraction] = decimalParts(decimal(value, "value"));
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

export function compareDecimalStrings(left: string, right: string): number {
  const [leftWhole, leftFraction] = decimalParts(decimal(left, "left"));
  const [rightWhole, rightFraction] = decimalParts(decimal(right, "right"));
  if (leftWhole.length !== rightWhole.length) {
    return leftWhole.length < rightWhole.length ? -1 : 1;
  }
  if (leftWhole !== rightWhole) {
    return leftWhole < rightWhole ? -1 : 1;
  }
  const width = Math.max(leftFraction.length, rightFraction.length);
  const paddedLeft = leftFraction.padEnd(width, "0");
  const paddedRight = rightFraction.padEnd(width, "0");
  return paddedLeft === paddedRight ? 0 : paddedLeft < paddedRight ? -1 : 1;
}

function predictionPrice(value: unknown, field: string): string {
  const text = decimal(value, field);
  if (compareDecimalStrings(text, "1") > 0) {
    throw new Error(`${field} must not exceed 1`);
  }
  return text;
}

function level(value: unknown, field: string): DecimalLevel {
  const item = record(value, field);
  const size = decimal(item.size, `${field}.size`);
  if (compareDecimalStrings(size, "0") <= 0) {
    throw new Error(`${field}.size must be positive in a snapshot`);
  }
  return Object.freeze({
    price: predictionPrice(item.price, `${field}.price`),
    size,
  });
}

function positiveDecimal(value: unknown, field: string): string {
  const parsed = decimal(value, field);
  if (compareDecimalStrings(parsed, "0") <= 0) {
    throw new Error(`${field} must be positive`);
  }
  return parsed;
}

function stringItems(value: unknown, field: string): readonly string[] {
  return array(value, field).map((item, index) => string(item, `${field}[${index}]`));
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every((item) => right.includes(item));
}

function priceChange(value: unknown, index: number): ParsedPriceChange {
  const item = record(value, `price_changes[${index}]`);
  const side = string(item.side, `price_changes[${index}].side`);
  if (side !== "BUY" && side !== "SELL") {
    throw new Error(`price_changes[${index}].side must be BUY or SELL`);
  }
  const size = decimal(item.size, `price_changes[${index}].size`);
  return Object.freeze({
    assetId: string(item.asset_id, `price_changes[${index}].asset_id`),
    price: predictionPrice(item.price, `price_changes[${index}].price`),
    size,
    side,
    sourceHash: string(item.hash, `price_changes[${index}].hash`),
    bestBid: predictionPrice(item.best_bid, `price_changes[${index}].best_bid`),
    bestAsk: predictionPrice(item.best_ask, `price_changes[${index}].best_ask`),
    deleteLevel: compareDecimalStrings(size, "0") === 0,
  });
}

function baseClob(
  rawPayload: string,
  eventType: string,
  parserStatus: ParserStatus,
  parserError: string | null,
): ParsedClobMarketMessage {
  return {
    eventType,
    parserStatus,
    parserError,
    rawPayload,
    conditionId: null,
    assetId: null,
    providerTimestampRaw: null,
    sourceHash: null,
    bids: null,
    asks: null,
    priceChanges: null,
    isGoldenSettlement: false,
  };
}

const KNOWN_CLOB_EVENTS = new Set([
  "book",
  "price_change",
  "tick_size_change",
  "last_trade_price",
  "best_bid_ask",
  "new_market",
  "market_resolved",
]);

export function parseClobMarketMessage(rawPayload: string): ParsedClobMarketMessage {
  let eventType = "parse_error";
  try {
    const message = record(JSON.parse(rawPayload), "CLOB message");
    eventType = string(message.event_type, "event_type");
    if (!KNOWN_CLOB_EVENTS.has(eventType)) {
      return Object.freeze(baseClob(rawPayload, eventType, "unparsed", null));
    }
    const conditionId = string(message.market ?? message.condition_id, "market");
    const providerTimestampRaw = string(message.timestamp, "timestamp");
    const common = {
      ...baseClob(rawPayload, eventType, "parsed", null),
      conditionId,
      providerTimestampRaw,
    };
    if (eventType === "book") {
      const bids = array(message.bids, "bids").map((item, index) => level(item, `bids[${index}]`));
      const asks = array(message.asks, "asks").map((item, index) => level(item, `asks[${index}]`));
      return Object.freeze({
        ...common,
        assetId: string(message.asset_id, "asset_id"),
        sourceHash: string(message.hash, "hash"),
        bids,
        asks,
      });
    }
    if (eventType === "price_change") {
      const changes = array(message.price_changes, "price_changes");
      if (changes.length === 0) {
        throw new Error("price_changes must not be empty");
      }
      return Object.freeze({
        ...common,
        priceChanges: changes.map(priceChange),
      });
    }
    if (eventType === "tick_size_change") {
      const oldTickSize = positiveDecimal(message.old_tick_size, "old_tick_size");
      const newTickSize = positiveDecimal(message.new_tick_size, "new_tick_size");
      if (compareDecimalStrings(oldTickSize, newTickSize) === 0) {
        throw new Error("tick_size_change must actually change the tick size");
      }
    } else if (eventType === "last_trade_price") {
      predictionPrice(message.price, "price");
      positiveDecimal(message.size, "size");
      decimal(message.fee_rate_bps, "fee_rate_bps");
      const side = string(message.side, "side");
      if (side !== "BUY" && side !== "SELL") throw new Error("side must be BUY or SELL");
    } else if (eventType === "best_bid_ask") {
      const bestBid = predictionPrice(message.best_bid, "best_bid");
      const bestAsk = predictionPrice(message.best_ask, "best_ask");
      predictionPrice(message.spread, "spread");
      if (compareDecimalStrings(bestBid, bestAsk) > 0) {
        throw new Error("best_bid must not exceed best_ask");
      }
    } else if (eventType === "new_market") {
      string(message.id, "id");
      string(message.question, "question");
      string(message.slug, "slug");
      string(message.description, "description");
      const assets = stringItems(message.assets_ids, "assets_ids");
      const outcomes = stringItems(message.outcomes, "outcomes");
      const clobTokens = stringItems(message.clob_token_ids, "clob_token_ids");
      if (assets.length === 0 || outcomes.length !== assets.length || !sameMembers(assets, clobTokens)) {
        throw new Error("new_market assets, outcomes, and CLOB tokens must agree");
      }
      if (string(message.condition_id, "condition_id") !== conditionId) {
        throw new Error("new_market condition_id does not match market");
      }
      requireBoolean(message.active, "active");
      if (message.order_price_min_tick_size !== undefined) {
        positiveDecimal(message.order_price_min_tick_size, "order_price_min_tick_size");
      }
      if (message.fees_enabled !== undefined) requireBoolean(message.fees_enabled, "fees_enabled");
    } else if (eventType === "market_resolved") {
      string(message.id, "id");
      string(message.question, "question");
      string(message.slug, "slug");
      const assets = stringItems(message.assets_ids, "assets_ids");
      const outcomes = stringItems(message.outcomes, "outcomes");
      if (assets.length === 0 || outcomes.length !== assets.length || new Set(assets).size !== assets.length) {
        throw new Error("market_resolved assets and outcomes must be aligned and unique");
      }
      const winningAssetId = string(message.winning_asset_id, "winning_asset_id");
      const winningOutcome = string(message.winning_outcome, "winning_outcome");
      const winningIndex = assets.indexOf(winningAssetId);
      if (winningIndex < 0 || outcomes[winningIndex] !== winningOutcome) {
        throw new Error("market_resolved winner does not match its asset/outcome mapping");
      }
    }
    const assetId =
      typeof message.asset_id === "string" && message.asset_id.trim() !== ""
        ? message.asset_id
        : null;
    return Object.freeze({ ...common, assetId });
  } catch (error) {
    const parserError = error instanceof Error ? error.message : String(error);
    return Object.freeze(baseClob(rawPayload, eventType, "error", parserError));
  }
}

/**
 * Current official documentation specifies a single JSON object per market
 * frame. Some observed deployments have emitted an initial JSON array, so the
 * transport wrapper is handled defensively but remains explicitly unverified.
 * The exact outer frame must still be persisted from `rawPayload`.
 */
export function parseClobMarketFrame(rawPayload: string): ParsedClobMarketFrame {
  try {
    const decoded: unknown = JSON.parse(rawPayload);
    if (!Array.isArray(decoded)) {
      return Object.freeze({
        rawPayload,
        shape: "single",
        messages: Object.freeze([parseClobMarketMessage(rawPayload)]),
        parserError: null,
      });
    }
    if (decoded.length === 0) throw new Error("CLOB batch frame must not be empty");
    const messages = decoded.map((item) => parseClobMarketMessage(JSON.stringify(item)));
    return Object.freeze({
      rawPayload,
      shape: "batch_unverified",
      messages: Object.freeze(messages),
      parserError: null,
    });
  } catch (error) {
    return Object.freeze({
      rawPayload,
      shape: "error",
      messages: Object.freeze([]),
      parserError: error instanceof Error ? error.message : String(error),
    });
  }
}

export function parseRestOrderBook(rawPayload: string): ParsedClobMarketMessage {
  try {
    const message = record(JSON.parse(rawPayload), "REST order book");
    const bids = array(message.bids, "bids").map((item, index) => level(item, `bids[${index}]`));
    const asks = array(message.asks, "asks").map((item, index) => level(item, `asks[${index}]`));
    return Object.freeze({
      ...baseClob(rawPayload, "book", "parsed", null),
      conditionId: string(message.market, "market"),
      assetId: string(message.asset_id, "asset_id"),
      providerTimestampRaw: string(message.timestamp, "timestamp"),
      sourceHash: string(message.hash, "hash"),
      bids,
      asks,
    });
  } catch (error) {
    return Object.freeze(
      baseClob(
        rawPayload,
        "rest_book_parse_error",
        "error",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}

interface JsonReviverContext {
  readonly source?: string;
}

type JsonParseWithContext = (
  text: string,
  reviver: (this: unknown, key: string, value: unknown, context?: JsonReviverContext) => unknown,
) => unknown;

function millisecondsIso(value: unknown, field: string): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be safe integer Unix milliseconds`);
  }
  return new Date(value).toISOString();
}

export function parseRtdsPriceMessage(
  rawPayload: string,
  expectedSource: "chainlink" | "binance",
): ParsedRtdsPriceMessage {
  try {
    const parseWithContext = JSON.parse as unknown as JsonParseWithContext;
    const valueLexemesByHolder = new WeakMap<object, string>();
    const parsed = parseWithContext(rawPayload, function (key, value, context) {
      if (key === "value" && context?.source !== undefined && this !== null && typeof this === "object") {
        valueLexemesByHolder.set(this as object, context.source);
      }
      return value;
    });
    const message = record(parsed, "RTDS message");
    const payload = record(message.payload, "payload");
    const topic = typeof message.topic === "string" && message.topic !== "" ? message.topic : null;
    const type = typeof message.type === "string" && message.type !== "" ? message.type : null;
    const symbol = typeof payload.symbol === "string" && payload.symbol !== "" ? payload.symbol : null;
    const expectedTopic = expectedSource === "chainlink" ? "crypto_prices_chainlink" : "crypto_prices";
    const expectedSymbol = expectedSource === "chainlink" ? "btc/usd" : "btcusdt";
    const reasons: string[] = [];
    if (type !== "update") reasons.push(`unexpected type ${type}`);
    if (topic !== expectedTopic) reasons.push(`unexpected topic ${topic}`);
    if (symbol !== expectedSymbol) reasons.push(`unexpected symbol ${symbol}`);
    if (reasons.length > 0) {
      const sourceTime = (() => {
        try {
          return millisecondsIso(payload.timestamp, "payload.timestamp");
        } catch {
          return null;
        }
      })();
      const serverTime = (() => {
        try {
          return millisecondsIso(message.timestamp, "timestamp");
        } catch {
          return null;
        }
      })();
      const valueDecimal =
        typeof payload.value === "number" && Number.isFinite(payload.value)
          ? (valueLexemesByHolder.get(payload) ?? null)
          : null;
      return Object.freeze({
        eventType: "rtds_message_quarantined",
        parserStatus: "quarantined",
        parserError: null,
        quarantineReason: reasons.join("; "),
        rawPayload,
        topic,
        symbol,
        sourceTime,
        serverTime,
        valueDecimal,
      });
    }
    if (typeof payload.value !== "number" || !Number.isFinite(payload.value)) {
      throw new Error("payload.value must be a finite JSON number");
    }
    const valueDecimal = valueLexemesByHolder.get(payload) ?? null;
    if (valueDecimal === null) {
      throw new Error("Node runtime did not expose the RTDS numeric source lexeme");
    }
    decimal(valueDecimal, "payload.value");
    return Object.freeze({
      eventType: "rtds_price_update",
      parserStatus: "parsed",
      parserError: null,
      quarantineReason: null,
      rawPayload,
      topic,
      symbol,
      sourceTime: millisecondsIso(payload.timestamp, "payload.timestamp"),
      serverTime: millisecondsIso(message.timestamp, "timestamp"),
      valueDecimal,
    });
  } catch (error) {
    return Object.freeze({
      eventType: "parse_error",
      parserStatus: "error",
      parserError: error instanceof Error ? error.message : String(error),
      quarantineReason: null,
      rawPayload,
      topic: null,
      symbol: null,
      sourceTime: null,
      serverTime: null,
      valueDecimal: null,
    });
  }
}
