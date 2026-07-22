import type { SignalDecision } from "../../backend/core/src/domain/index.js";
import type { StrategyInput, StrategyRegistry } from "../../strategies/src/index.js";

export * from "./jobs.js";

export interface BacktestFrame {
  readonly strategyId: string;
  readonly input: Readonly<StrategyInput>;
}

/** Deterministic in-memory strategy replay. Market/fill accounting remains in the existing core. */
export function runStrategyFrames(
  registry: StrategyRegistry,
  frames: readonly BacktestFrame[],
): readonly Readonly<SignalDecision>[] {
  return Object.freeze(
    frames.map((frame) => {
      if (frame.input.strategyId !== frame.strategyId) {
        throw new Error("backtest frame strategyId disagrees with its input");
      }
      return registry.resolve(frame.strategyId)(frame.input);
    }),
  );
}
