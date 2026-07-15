import type {
  Balance,
  Order,
  OrderBook,
  Position,
  SignalDecision,
  Timestamp,
} from "../domain/index.js";

export interface StrategyInput {
  readonly strategyId: string;
  readonly decisionId: string;
  readonly processTimestamp: Timestamp;
  readonly orderBook: OrderBook;
  readonly positions: readonly Position[];
  readonly balances: readonly Balance[];
  readonly openOrders: readonly Order[];
  readonly parameters: Readonly<Record<string, number | string | boolean>>;
}

/**
 * A strategy is a pure function: identical inputs must produce identical output.
 * Implementations must not access network, database, environment variables,
 * system time, random global state, or mutable global state.
 */
export type Strategy = (input: Readonly<StrategyInput>) => Readonly<SignalDecision>;

