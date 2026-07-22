import type { PublicBtcFiveMinuteMarket } from "../../backend/core/src/adapters/market-data/public-sources.js";
import { canonicalDecimalString, compareDecimalStrings } from "../../backend/core/src/adapters/market-data/parsers.js";
import { Money } from "../../backend/core/src/domain/money.js";
import {
  receiveStampAtOrBefore,
  validateReceiveStamp,
  type ReceiveStamp,
} from "../../backend/core/src/domain/receive-time.js";

export const KJ_STRATEGY_CONTEXT_VERSION = "kj-strategy-context-v1" as const;

export interface KJTopOfBookInput {
  readonly bid: string;
  readonly ask: string;
  readonly bidSize: string;
  readonly askSize: string;
}

export interface KJPriceEvidenceInput {
  readonly provider: "BINANCE_SPOT" | "POLYMARKET_RTDS_BINANCE" | "POLYMARKET_RTDS_CHAINLINK";
  readonly price: string;
  readonly sourceTime: string | null;
  readonly serverTime: string | null;
  readonly receiveTime: string;
  readonly receiveStamp: ReceiveStamp;
  readonly connectionId: string;
  readonly inputHash: string;
}

export interface KJStrategyContextInput {
  readonly decisionTime: string;
  readonly market: PublicBtcFiveMinuteMarket | null;
  readonly book: {
    readonly state: string;
    readonly continuity: string;
    readonly up: KJTopOfBookInput;
    readonly down: KJTopOfBookInput;
    readonly receiveStamp: ReceiveStamp;
  } | null;
  readonly signal: KJPriceEvidenceInput | null;
  readonly maximumBookAgeMilliseconds?: number;
  readonly maximumSignalAgeMilliseconds?: number;
}

export interface KJStrategyContextV1 {
  readonly schemaVersion: typeof KJ_STRATEGY_CONTEXT_VERSION;
  readonly mode: "PAPER_ONLY";
  readonly decisionTime: string;
  readonly inputWatermark: ReceiveStamp;
  readonly market: {
    readonly marketId: string;
    readonly conditionId: string;
    readonly slug: string;
    readonly intervalStart: string;
    readonly intervalEnd: string;
    readonly upTokenId: string;
    readonly downTokenId: string;
  };
  readonly book: {
    readonly state: "ACTIVE_UNVERIFIED";
    readonly continuity: "UNVERIFIED";
    readonly up: KJTopOfBookInput & { readonly tokenId: string };
    readonly down: KJTopOfBookInput & { readonly tokenId: string };
    readonly receiveStamp: ReceiveStamp;
  };
  readonly signal: KJPriceEvidenceInput;
  readonly feeEvidence: {
    readonly rate: string;
    readonly status: "PUBLIC_MARKET_STATIC_UNVERIFIED";
    readonly reference: string;
  };
  readonly safety: {
    readonly liveTradingEnabled: false;
    readonly orderSubmissionAvailable: false;
  };
}

export type KJStrategyContextResult =
  | { readonly ready: true; readonly context: KJStrategyContextV1 }
  | { readonly ready: false; readonly reason: string };

function nonEmpty(value: string, field: string): string {
  if (value.trim() === "") throw new Error(`${field} must be non-empty`);
  return value;
}

function utc(value: string, field: string): number {
  if (!value.endsWith("Z")) throw new Error(`${field} must be explicit UTC`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be a valid timestamp`);
  return parsed;
}

function canonicalPositive(value: string, field: string): string {
  const canonical = canonicalDecimalString(value);
  if (!Money.from(canonical).isPositive()) throw new Error(`${field} must be positive`);
  return canonical;
}

function outcomeBook(value: KJTopOfBookInput, field: string): KJTopOfBookInput {
  const bid = canonicalPositive(value.bid, `${field}.bid`);
  const ask = canonicalPositive(value.ask, `${field}.ask`);
  if (Money.from(bid).comparedTo(Money.from("1")) >= 0
    || Money.from(ask).comparedTo(Money.from("1")) >= 0) {
    throw new Error(`${field} prices must be below one`);
  }
  if (compareDecimalStrings(bid, ask) > 0) throw new Error(`${field} book is crossed`);
  return Object.freeze({
    bid,
    ask,
    bidSize: canonicalPositive(value.bidSize, `${field}.bidSize`),
    askSize: canonicalPositive(value.askSize, `${field}.askSize`),
  });
}

function boundedAge(
  decisionMilliseconds: number,
  receiveTime: string,
  maximumAge: number,
  field: string,
): void {
  if (!Number.isSafeInteger(maximumAge) || maximumAge <= 0) {
    throw new Error(`${field} maximum age must be a positive safe integer`);
  }
  const received = utc(receiveTime, `${field}.receiveTime`);
  if (received > decisionMilliseconds) throw new Error(`${field} is from the future`);
  if (decisionMilliseconds - received > maximumAge) throw new Error(`${field} is stale`);
}

function deeplyFreezeContext(value: KJStrategyContextV1): KJStrategyContextV1 {
  Object.freeze(value.market);
  Object.freeze(value.book.up);
  Object.freeze(value.book.down);
  Object.freeze(value.book);
  Object.freeze(value.signal);
  Object.freeze(value.feeEvidence);
  Object.freeze(value.safety);
  return Object.freeze(value);
}

export function createKJStrategyContext(
  input: KJStrategyContextInput,
): KJStrategyContextResult {
  if (input.market === null) return Object.freeze({ ready: false, reason: "MISSING_MARKET" });
  if (input.book === null) return Object.freeze({ ready: false, reason: "MISSING_BOOK" });
  if (input.signal === null) return Object.freeze({ ready: false, reason: "MISSING_SIGNAL" });
  try {
    const decisionMilliseconds = utc(input.decisionTime, "decisionTime");
    const start = utc(input.market.intervalStart, "market.intervalStart");
    const end = utc(input.market.intervalEnd, "market.intervalEnd");
    if (end - start !== 300_000) throw new Error("market interval must be exactly five minutes");
    if (decisionMilliseconds < start || decisionMilliseconds >= end) {
      throw new Error("decisionTime is outside the market interval");
    }
    if (!input.market.collectible
      || input.market.active !== true
      || input.market.closed !== false
      || input.market.acceptingOrders !== true) {
      throw new Error("market is not publicly collectible");
    }
    if (input.market.upTokenId === input.market.downTokenId) {
      throw new Error("Up and Down token IDs must differ");
    }
    if (input.book.state !== "ACTIVE_UNVERIFIED" || input.book.continuity !== "UNVERIFIED") {
      throw new Error("book is not active continuity-unverified public state");
    }
    const bookStamp = validateReceiveStamp(input.book.receiveStamp);
    const signalStamp = validateReceiveStamp(input.signal.receiveStamp);
    if (bookStamp.clockDomain !== signalStamp.clockDomain) {
      throw new Error("book and signal receive stamps belong to different clock domains");
    }
    const inputWatermark = receiveStampAtOrBefore(bookStamp, signalStamp)
      ? signalStamp
      : bookStamp;
    boundedAge(
      decisionMilliseconds,
      bookStamp.localWallReceiveTime,
      input.maximumBookAgeMilliseconds ?? 5_000,
      "book",
    );
    boundedAge(
      decisionMilliseconds,
      input.signal.receiveTime,
      input.maximumSignalAgeMilliseconds ?? 10_000,
      "signal",
    );
    if (input.signal.receiveTime !== signalStamp.localWallReceiveTime) {
      throw new Error("signal receiveTime disagrees with its ReceiveStamp");
    }
    if (input.signal.sourceTime !== null
      && utc(input.signal.sourceTime, "signal.sourceTime") > decisionMilliseconds) {
      throw new Error("signal sourceTime is from the future");
    }
    if (input.signal.serverTime !== null
      && utc(input.signal.serverTime, "signal.serverTime") > decisionMilliseconds) {
      throw new Error("signal serverTime is from the future");
    }
    const fee = input.market.takerFeeRate;
    if (fee === null) throw new Error("market fee evidence is missing");
    const canonicalFee = canonicalDecimalString(fee);
    if (Money.from(canonicalFee).comparedTo(Money.from("1")) > 0) {
      throw new Error("market fee rate exceeds one");
    }
    const up = outcomeBook(input.book.up, "book.up");
    const down = outcomeBook(input.book.down, "book.down");
    const signal = Object.freeze({
      provider: input.signal.provider,
      price: canonicalPositive(input.signal.price, "signal.price"),
      sourceTime: input.signal.sourceTime,
      serverTime: input.signal.serverTime,
      receiveTime: input.signal.receiveTime,
      receiveStamp: signalStamp,
      connectionId: nonEmpty(input.signal.connectionId, "signal.connectionId"),
      inputHash: nonEmpty(input.signal.inputHash, "signal.inputHash"),
    });
    return Object.freeze({
      ready: true,
      context: deeplyFreezeContext({
        schemaVersion: KJ_STRATEGY_CONTEXT_VERSION,
        mode: "PAPER_ONLY",
        decisionTime: input.decisionTime,
        inputWatermark,
        market: {
          marketId: nonEmpty(input.market.marketId, "market.marketId"),
          conditionId: nonEmpty(input.market.conditionId, "market.conditionId"),
          slug: nonEmpty(input.market.slug, "market.slug"),
          intervalStart: input.market.intervalStart,
          intervalEnd: input.market.intervalEnd,
          upTokenId: nonEmpty(input.market.upTokenId, "market.upTokenId"),
          downTokenId: nonEmpty(input.market.downTokenId, "market.downTokenId"),
        },
        book: {
          state: "ACTIVE_UNVERIFIED",
          continuity: "UNVERIFIED",
          up: { ...up, tokenId: input.market.upTokenId },
          down: { ...down, tokenId: input.market.downTokenId },
          receiveStamp: bookStamp,
        },
        signal,
        feeEvidence: {
          rate: canonicalFee,
          status: "PUBLIC_MARKET_STATIC_UNVERIFIED",
          reference: `gamma:${input.market.slug}`,
        },
        safety: {
          liveTradingEnabled: false,
          orderSubmissionAvailable: false,
        },
      }),
    });
  } catch (error) {
    return Object.freeze({
      ready: false,
      reason: `INVALID_CONTEXT:${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
