/** UTC timestamp serialized as an ISO 8601 string. */
export type Timestamp = string;
export type MarketId = string;
export type TokenId = string;
export type OrderId = string;
export type TradeId = string;

export interface EventTimestamps {
  readonly exchangeTimestamp: Timestamp;
  readonly receiveTimestamp: Timestamp;
  readonly processTimestamp: Timestamp;
  readonly persistTimestamp?: Timestamp;
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
  readonly price: number;
  readonly size: number;
}

export interface OrderBook {
  readonly marketId: MarketId;
  readonly tokenId: TokenId;
  readonly bids: readonly PriceLevel[];
  readonly asks: readonly PriceLevel[];
  readonly sequence: string;
  readonly timestamps: EventTimestamps;
}

export interface Trade {
  readonly tradeId: TradeId;
  readonly marketId: MarketId;
  readonly tokenId: TokenId;
  readonly side: "buy" | "sell";
  readonly price: number;
  readonly size: number;
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
  readonly price?: number;
  readonly size: number;
  readonly status: "pending" | "open" | "partiallyFilled" | "filled" | "cancelled" | "rejected";
  readonly timestamps: EventTimestamps;
}

export interface Fill {
  readonly fillId: string;
  readonly orderId: OrderId;
  readonly tradeId?: TradeId;
  readonly price: number;
  readonly size: number;
  readonly fee: number;
  readonly timestamps: EventTimestamps;
}

export interface Position {
  readonly marketId: MarketId;
  readonly tokenId: TokenId;
  readonly size: number;
  readonly averageEntryPrice: number;
  readonly realizedPnl: number;
  readonly unrealizedPnl: number;
  readonly timestamps: EventTimestamps;
}

export interface Balance {
  readonly asset: string;
  readonly available: number;
  readonly reserved: number;
  readonly total: number;
  readonly timestamps: EventTimestamps;
}

export interface SignalDecision {
  readonly decisionId: string;
  readonly strategyId: string;
  readonly marketId: MarketId;
  readonly tokenId: TokenId;
  readonly action: "buy" | "sell" | "hold";
  readonly confidence: number;
  readonly targetPrice?: number;
  readonly targetSize?: number;
  readonly reasonCodes: readonly string[];
  readonly timestamps: EventTimestamps;
}

export interface RiskDecision {
  readonly decisionId: string;
  readonly signalDecisionId: string;
  readonly approved: boolean;
  readonly adjustedSize?: number;
  readonly reasonCodes: readonly string[];
  readonly timestamps: EventTimestamps;
}

export interface Settlement {
  readonly settlementId: string;
  readonly marketId: MarketId;
  readonly winningTokenId: TokenId;
  readonly payoutPerToken: number;
  readonly status: "pending" | "final" | "disputed";
  readonly timestamps: EventTimestamps;
}

