/** UTC timestamp serialized as an ISO 8601 string. */
export type Timestamp = string;
/** Canonical base-10 value. Never construct it through an IEEE-754 calculation. */
export type DecimalString = string;
export type MarketId = string;
export type TokenId = string;
export type OrderId = string;
export type TradeId = string;

export type {
  CreateEnvelopeDraftInput,
  ParserStatus,
  RawEventEnvelopeDraftV1,
  RawEventEnvelopeV1,
} from "./raw-event.js";
export {
  RAW_EVENT_SCHEMA_VERSION,
  createEnvelopeDraft,
  parsePersistedEnvelope,
  persistEnvelope,
  rawSha256,
  requireUtcIso,
} from "./raw-event.js";

export interface EventTimestamps {
  readonly sourceTime: Timestamp | null;
  readonly serverTime: Timestamp | null;
  readonly receiveTime: Timestamp;
  readonly processTime: Timestamp;
  readonly persistTime?: Timestamp;
}

export interface Market {
  readonly marketId: MarketId;
  readonly question: string;
  readonly conditionId: string;
  readonly outcomeTokens: readonly OutcomeToken[];
  readonly status: "active" | "closed" | "resolved";
  readonly timestamps: EventTimestamps;
}

export interface OutcomeToken {
  readonly tokenId: TokenId;
  readonly marketId: MarketId;
  readonly outcome: string;
}

export interface PriceLevel {
  readonly price: DecimalString;
  readonly size: DecimalString;
}

export interface OrderBook {
  readonly marketId: MarketId;
  readonly tokenId: TokenId;
  readonly bids: readonly PriceLevel[];
  readonly asks: readonly PriceLevel[];
  readonly sourceSequence: string | null;
  readonly sourceHash: string | null;
  readonly timestamps: EventTimestamps;
}

export interface Trade {
  readonly tradeId: TradeId;
  readonly marketId: MarketId;
  readonly tokenId: TokenId;
  readonly side: "buy" | "sell";
  readonly price: DecimalString;
  readonly size: DecimalString;
  readonly timestamps: EventTimestamps;
}

export interface Order {
  readonly orderId: OrderId;
  readonly clientOrderId: string;
  readonly idempotencyKey: string;
  readonly marketId: MarketId;
  readonly tokenId: TokenId;
  readonly side: "buy" | "sell";
  readonly type: "limit" | "market";
  readonly price?: DecimalString;
  readonly size: DecimalString;
  readonly status: "pending" | "open" | "partiallyFilled" | "filled" | "cancelled" | "rejected";
  readonly timestamps: EventTimestamps;
}

export interface Fill {
  readonly fillId: string;
  readonly orderId: OrderId;
  readonly tradeId?: TradeId;
  readonly price: DecimalString;
  readonly size: DecimalString;
  readonly fee: DecimalString;
  readonly timestamps: EventTimestamps;
}

export interface Position {
  readonly marketId: MarketId;
  readonly tokenId: TokenId;
  readonly size: DecimalString;
  readonly averageEntryPrice: DecimalString;
  readonly realizedPnl: DecimalString;
  readonly unrealizedPnl: DecimalString;
  readonly timestamps: EventTimestamps;
}

export interface Balance {
  readonly asset: string;
  readonly available: DecimalString;
  readonly reserved: DecimalString;
  readonly total: DecimalString;
  readonly timestamps: EventTimestamps;
}

export interface SignalDecision {
  readonly decisionId: string;
  readonly strategyId: string;
  readonly marketId: MarketId;
  readonly tokenId: TokenId;
  readonly action: "buy" | "sell" | "hold";
  readonly confidence: DecimalString;
  readonly targetPrice?: DecimalString;
  readonly targetSize?: DecimalString;
  readonly reasonCodes: readonly string[];
  readonly timestamps: EventTimestamps;
}

export interface RiskDecision {
  readonly decisionId: string;
  readonly signalDecisionId: string;
  readonly approved: boolean;
  readonly adjustedSize?: DecimalString;
  readonly reasonCodes: readonly string[];
  readonly timestamps: EventTimestamps;
}

export interface Settlement {
  readonly settlementId: string;
  readonly marketId: MarketId;
  readonly winningTokenId: TokenId;
  readonly payoutPerToken: DecimalString;
  readonly status: "pending" | "final" | "disputed";
  readonly timestamps: EventTimestamps;
}
