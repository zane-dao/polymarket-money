import type {
  Balance,
  Order,
  OrderBook,
  Position,
  SignalDecision,
  Timestamp,
} from "../../backend/core/src/domain/index.js";

export interface StrategyInput {
  readonly strategyId: string;
  readonly decisionId: string;
  readonly processTime: Timestamp;
  readonly orderBook: OrderBook;
  readonly positions: readonly Position[];
  readonly balances: readonly Balance[];
  readonly openOrders: readonly Order[];
  readonly parameters: Readonly<Record<string, number | string | boolean>>;
  readonly market?: Readonly<{ marketId: string; intervalStart: Timestamp; intervalEnd: Timestamp; remainingSeconds: number }>;
  readonly btcFeatures?: Readonly<{ currentPrice: string; openingPrice: string; logReturn: string; volatilityFast: string | null; volatilitySlow: string | null; trend: string | null; volume: string | null }>;
  readonly account?: Readonly<{ cash: string; totalExposure: string; currentMarketExposure: string }>;
}

export type TargetPositionDecision = Readonly<{
  action: "NO_TRADE" | "TARGET_POSITION";
  token: "YES" | "NO" | null;
  probabilityYes: string;
  netEdge: string | null;
  targetPositionQuantity: string;
  maximumAcceptablePrice: string | null;
  reason: string;
}>;

/** New historical and Paper runners use target-position decisions. */
export type TargetPositionStrategy = (input: Readonly<StrategyInput>) => Readonly<TargetPositionDecision>;

/** @deprecated Compatibility for legacy callers pending their next reviewed strategy migration. */
export type Strategy = (input: Readonly<StrategyInput>) => Readonly<SignalDecision>;

export class StrategyRegistry {
  readonly #strategies = new Map<string, Strategy>();

  register(strategyId: string, strategy: Strategy): void {
    const normalizedId = strategyId.trim();
    if (normalizedId === "") throw new Error("strategyId must be non-empty");
    if (this.#strategies.has(normalizedId)) {
      throw new Error(`strategy already registered: ${normalizedId}`);
    }
    this.#strategies.set(normalizedId, strategy);
  }

  resolve(strategyId: string): Strategy {
    const strategy = this.#strategies.get(strategyId);
    if (strategy === undefined) throw new Error(`unknown strategy: ${strategyId}`);
    return strategy;
  }

  list(): readonly string[] {
    return Object.freeze([...this.#strategies.keys()].sort());
  }
}
