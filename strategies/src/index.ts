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
}

/** A deterministic strategy has no UI, Tauri, network, storage, or order-side effects. */
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
