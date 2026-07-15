import type {
  Balance,
  Order,
  Position,
  RiskDecision,
  SignalDecision,
  Timestamp,
} from "../domain/index.js";

export interface RiskConfig {
  readonly maxOrderAmount: number;
  readonly maxPositionPerMarket: number;
  readonly maxDailyLoss: number;
  readonly maxSlippageBps: number;
  readonly maxOpenOrders: number;
  readonly maxDataAgeMs: number;
  readonly maxWebSocketDisconnectMs: number;
  readonly requireUniqueIdempotencyKey: boolean;
}

export const DEFAULT_RISK_CONFIG: Readonly<RiskConfig> = Object.freeze({
  maxOrderAmount: 100,
  maxPositionPerMarket: 500,
  maxDailyLoss: 100,
  maxSlippageBps: 100,
  maxOpenOrders: 10,
  maxDataAgeMs: 5_000,
  maxWebSocketDisconnectMs: 10_000,
  requireUniqueIdempotencyKey: true,
});

export interface RiskContext {
  readonly processTimestamp: Timestamp;
  readonly dataTimestamp: Timestamp;
  readonly webSocketConnected: boolean;
  readonly webSocketLastSeenTimestamp: Timestamp;
  readonly dailyPnl: number;
  readonly positions: readonly Position[];
  readonly balances: readonly Balance[];
  readonly openOrders: readonly Order[];
  readonly observedIdempotencyKeys: ReadonlySet<string>;
}

export interface RiskEngine {
  evaluate(
    signal: Readonly<SignalDecision>,
    context: Readonly<RiskContext>,
    config: Readonly<RiskConfig>,
  ): Readonly<RiskDecision>;
}

