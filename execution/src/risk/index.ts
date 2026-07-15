import type {
  Balance,
  Order,
  Position,
  RiskDecision,
  SignalDecision,
  Timestamp,
  DecimalString,
} from "../domain/index.js";

export interface RiskConfig {
  readonly maxOrderAmountUsd: DecimalString;
  readonly maxPositionPerMarketTokens: DecimalString;
  readonly maxDailyLossUsd: DecimalString;
  readonly maxSlippageBps: DecimalString;
  readonly maxOpenOrders: number;
  readonly maxDataAgeMs: number;
  readonly maxWebSocketDisconnectMs: number;
  readonly requireUniqueIdempotencyKey: boolean;
}

export const DEFAULT_RISK_CONFIG: Readonly<RiskConfig> = Object.freeze({
  maxOrderAmountUsd: "100",
  maxPositionPerMarketTokens: "500",
  maxDailyLossUsd: "100",
  maxSlippageBps: "100",
  maxOpenOrders: 10,
  maxDataAgeMs: 5_000,
  maxWebSocketDisconnectMs: 10_000,
  requireUniqueIdempotencyKey: true,
});

export interface RiskContext {
  readonly processTime: Timestamp;
  readonly dataReceiveTime: Timestamp;
  readonly webSocketConnected: boolean;
  readonly webSocketLastReceiveTime: Timestamp;
  readonly dailyPnlUsd: DecimalString;
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
