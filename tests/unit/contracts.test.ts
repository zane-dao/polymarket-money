import type { ExecutionEngine } from "../../execution/src/adapters/index.js";
import type {
  EventTimestamps,
  OrderBook,
  RiskDecision,
  SignalDecision,
} from "../../execution/src/domain/index.js";
import { DEFAULT_RISK_CONFIG } from "../../execution/src/risk/index.js";
import type { Strategy } from "../../execution/src/strategy/index.js";

const timestamps: EventTimestamps = {
  sourceTime: "2026-01-01T00:00:00.000Z",
  serverTime: null,
  receiveTime: "2026-01-01T00:00:00.010Z",
  processTime: "2026-01-01T00:00:00.020Z",
  persistTime: "2026-01-01T00:00:00.030Z",
};

const book: OrderBook = {
  marketId: "market-1",
  tokenId: "token-yes",
  bids: [{ price: "0.49", size: "10" }],
  asks: [{ price: "0.51", size: "10" }],
  sourceSequence: null,
  sourceHash: "fixture-hash",
  timestamps,
};

const holdStrategy: Strategy = (input): SignalDecision => ({
  decisionId: input.decisionId,
  strategyId: input.strategyId,
  marketId: input.orderBook.marketId,
  tokenId: input.orderBook.tokenId,
  action: "hold",
  confidence: "1",
  reasonCodes: ["SCAFFOLD_ONLY"],
  timestamps: { ...timestamps, processTime: input.processTime },
});

const riskDecision: RiskDecision = {
  decisionId: "risk-1",
  signalDecisionId: "signal-1",
  approved: false,
  reasonCodes: ["LIVE_TRADING_DISABLED"],
  timestamps,
};

const engineContract: ExecutionEngine | undefined = undefined;
void book;
void holdStrategy;
void riskDecision;
void engineContract;
void DEFAULT_RISK_CONFIG;
