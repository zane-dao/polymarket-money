import { createHash } from "node:crypto";

import { Money, minimumMoney } from "../domain/money.js";
import type { KJStrategyContextV1 } from "../strategy/kj-context.js";

export const KJ_PAPER_ENGINE_VERSION = "kj-paper-engine-v2" as const;

export type KJPaperStrategy = "J_FEE_AWARE" | "K_DUAL_VOL";
export type KJMarketLifecycleState = "INIT" | "RUNNING" | "STOPPING" | "DONE";

export interface KJPaperEngineConfig {
  readonly initialCash: string;
  readonly edgeThreshold: string;
  readonly maxEdge: string;
  readonly criticalBandUsd: string;
  readonly criticalBandMaximumRemainingSeconds: number;
  readonly kellyMultiplier: string;
  readonly maximumStakeFraction: string;
  readonly maximumStakeAmount: string;
  readonly maximumMarketFraction: string;
  readonly bookParticipation: string;
  readonly minimumStake: string;
  readonly decisionIntervalMilliseconds: number;
  readonly fillLatencyMilliseconds: number;
  readonly maximumSlippage: string;
  readonly anchorToleranceMilliseconds: number;
}

export const DEFAULT_KJ_PAPER_ENGINE_CONFIG: KJPaperEngineConfig = Object.freeze({
  initialCash: "10000",
  edgeThreshold: "0.05",
  maxEdge: "0.25",
  criticalBandUsd: "10",
  criticalBandMaximumRemainingSeconds: 180,
  kellyMultiplier: "0.25",
  maximumStakeFraction: "0.02",
  maximumStakeAmount: "400",
  maximumMarketFraction: "0.04",
  bookParticipation: "0.5",
  minimumStake: "1",
  decisionIntervalMilliseconds: 15_000,
  fillLatencyMilliseconds: 1_000,
  maximumSlippage: "0.01",
  anchorToleranceMilliseconds: 5_000,
});

export interface KJOfficialSettlement {
  readonly settlementId: string;
  readonly marketId: string;
  readonly winner: "UP" | "DOWN";
  readonly settlementTime: string;
  readonly evidenceStatus: "OFFICIAL_RESOLUTION";
  readonly evidenceReference: string;
}

export interface KJPaperEvent {
  readonly schemaVersion: typeof KJ_PAPER_ENGINE_VERSION;
  readonly eventId: string;
  readonly eventType:
    | "MARKET_STATE"
    | "DECISION"
    | "INTENT"
    | "FILL"
    | "NO_FILL"
    | "SETTLEMENT";
  readonly strategy: KJPaperStrategy | null;
  readonly marketId: string;
  readonly eventTime: string;
  readonly details: Readonly<Record<string, string | boolean | null>>;
}

export interface KJPaperEngineSnapshot {
  readonly schemaVersion: "kj-paper-engine-snapshot-v1";
  readonly engineVersion: typeof KJ_PAPER_ENGINE_VERSION;
  readonly wallets: Readonly<Record<KJPaperStrategy, Readonly<{
    cash: string;
    available: string;
    reserved: string;
    positions: Readonly<Record<string, string>>;
  }>>>;
  readonly markets: readonly Readonly<{
    marketId: string;
    conditionId: string;
    slug: string;
    intervalStart: string;
    intervalEnd: string;
    upTokenId: string;
    downTokenId: string;
    anchorPrice: string;
    state: KJMarketLifecycleState;
    ledgers: Readonly<Record<KJPaperStrategy, Readonly<{
      spent: string;
      fees: string;
      tradeCount: string;
    }>>>;
  }>[];
  readonly pendingIntents: readonly Readonly<{
    intentId: string;
    strategy: KJPaperStrategy;
    marketId: string;
    tokenId: string;
    outcome: "UP" | "DOWN";
    decisionTime: string;
    executableAfter: string;
    probability: string;
    decisionAsk: string;
    maximumFillPrice: string;
    intendedQuantity: string;
    reservedAmount: string;
  }>[];
  readonly eventCount: string;
}

interface PaperIntent {
  readonly intentId: string;
  readonly strategy: KJPaperStrategy;
  readonly marketId: string;
  readonly tokenId: string;
  readonly outcome: "UP" | "DOWN";
  readonly decisionTime: string;
  readonly executableAfter: number;
  readonly probability: Money;
  readonly decisionAsk: Money;
  readonly maximumFillPrice: Money;
  readonly intendedQuantity: Money;
  readonly reservedAmount: Money;
}

interface StrategyMarketLedger {
  spent: Money;
  fees: Money;
  tradeCount: number;
}

interface MarketSession {
  readonly marketId: string;
  readonly conditionId: string;
  readonly slug: string;
  readonly intervalStart: string;
  readonly intervalEnd: string;
  readonly upTokenId: string;
  readonly downTokenId: string;
  readonly anchorPrice: Money;
  state: KJMarketLifecycleState;
  lastDecisionByStrategy: Map<KJPaperStrategy, number>;
  ledgers: Map<KJPaperStrategy, StrategyMarketLedger>;
}

class EwmaVolatility {
  readonly #halflifeSeconds: number;
  readonly #minimumSigma: number;
  readonly #sampleIntervalSeconds: number;
  #variancePerSecond: number | null = null;
  #samplePrice: number | null = null;
  #sampleTimeSeconds: number | null = null;
  #firstTimeSeconds: number | null = null;

  constructor(halflifeSeconds: number, minimumSigma: number, sampleIntervalSeconds = 5) {
    this.#halflifeSeconds = halflifeSeconds;
    this.#minimumSigma = minimumSigma;
    this.#sampleIntervalSeconds = sampleIntervalSeconds;
  }

  update(priceText: string, timeText: string): void {
    const price = Number(priceText);
    const timeSeconds = Date.parse(timeText) / 1_000;
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(timeSeconds)) {
      throw new Error("EWMA input must contain positive price and valid time");
    }
    if (this.#samplePrice === null || this.#sampleTimeSeconds === null) {
      this.#samplePrice = price;
      this.#sampleTimeSeconds = timeSeconds;
      this.#firstTimeSeconds = timeSeconds;
      return;
    }
    const elapsed = timeSeconds - this.#sampleTimeSeconds;
    if (elapsed < 0) throw new Error("EWMA input time reversed");
    if (elapsed < this.#sampleIntervalSeconds) return;
    const logReturn = Math.log(price / this.#samplePrice);
    const observation = logReturn * logReturn / elapsed;
    const alpha = 1 - 0.5 ** (elapsed / this.#halflifeSeconds);
    this.#variancePerSecond = this.#variancePerSecond === null
      ? observation
      : this.#variancePerSecond + alpha * (observation - this.#variancePerSecond);
    this.#samplePrice = price;
    this.#sampleTimeSeconds = timeSeconds;
  }

  get sigma(): number | null {
    return this.#variancePerSecond === null
      ? null
      : Math.max(Math.sqrt(this.#variancePerSecond), this.#minimumSigma);
  }

  get elapsedSeconds(): number | null {
    return this.#firstTimeSeconds === null || this.#sampleTimeSeconds === null
      ? null
      : this.#sampleTimeSeconds - this.#firstTimeSeconds;
  }
}

class StrategyVolatility {
  readonly single = new EwmaVolatility(100, 0.00002);
  readonly fast = new EwmaVolatility(180, 0);
  readonly slow = new EwmaVolatility(2700, 0);

  update(price: string, time: string): void {
    this.single.update(price, time);
    this.fast.update(price, time);
    this.slow.update(price, time);
  }

  sigma(strategy: KJPaperStrategy): number | null {
    if (strategy === "J_FEE_AWARE") return this.single.sigma;
    if ((this.fast.elapsedSeconds ?? -1) < 180 || this.fast.sigma === null) return null;
    return Math.max(this.fast.sigma, 0.4 * (this.slow.sigma ?? 0), 0.000012);
  }
}

class PaperWallet {
  #cash: Money;
  readonly #reservations = new Map<string, Money>();
  readonly #positions = new Map<string, Money>();

  constructor(initialCash: string) {
    this.#cash = positiveMoney(initialCash, "initialCash");
  }

  get cash(): Money { return this.#cash; }

  available(): Money {
    let reserved = Money.from("0");
    for (const amount of this.#reservations.values()) reserved = reserved.plus(amount);
    return this.#cash.minus(reserved);
  }

  reserve(intentId: string, amount: Money): void {
    if (this.#reservations.has(intentId)) throw new Error("intent reservation already exists");
    if (amount.comparedTo(this.available()) > 0) throw new Error("insufficient available paper cash");
    this.#reservations.set(intentId, amount);
  }

  release(intentId: string): void {
    this.#reservations.delete(intentId);
  }

  fill(intentId: string, tokenId: string, quantity: Money, cost: Money, fee: Money): void {
    const reservation = this.#reservations.get(intentId);
    if (reservation === undefined) throw new Error("fill has no wallet reservation");
    const debit = cost.plus(fee);
    if (debit.comparedTo(reservation) > 0) throw new Error("paper fill exceeds reservation");
    if (debit.comparedTo(this.#cash) > 0) throw new Error("paper fill exceeds cash");
    this.#reservations.delete(intentId);
    this.#cash = this.#cash.minus(debit);
    this.#positions.set(tokenId, (this.#positions.get(tokenId) ?? Money.from("0")).plus(quantity));
  }

  position(tokenId: string): Money {
    return this.#positions.get(tokenId) ?? Money.from("0");
  }

  settle(upTokenId: string, downTokenId: string, winningTokenId: string): Money {
    const payout = this.position(winningTokenId);
    this.#positions.delete(upTokenId);
    this.#positions.delete(downTokenId);
    this.#cash = this.#cash.plus(payout);
    return payout;
  }

  snapshot(): Readonly<{
    cash: string;
    available: string;
    reserved: string;
    positions: Readonly<Record<string, string>>;
  }> {
    let reserved = Money.from("0");
    for (const amount of this.#reservations.values()) reserved = reserved.plus(amount);
    const positions = Object.fromEntries([...this.#positions.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([tokenId, quantity]) => [tokenId, quantity.toCanonical()]));
    return Object.freeze({
      cash: this.#cash.toCanonical(),
      available: this.available().toCanonical(),
      reserved: reserved.toCanonical(),
      positions: Object.freeze(positions),
    });
  }
}

function positiveMoney(value: string, field: string): Money {
  const parsed = Money.from(value);
  if (!parsed.isPositive()) throw new Error(`${field} must be positive`);
  return parsed;
}

function nonNegativeMoney(value: string, field: string): Money {
  const parsed = Money.from(value);
  if (parsed.comparedTo(Money.from("0")) < 0) throw new Error(`${field} must not be negative`);
  return parsed;
}

function positiveFraction(value: string, field: string): Money {
  const parsed = positiveMoney(value, field);
  if (parsed.comparedTo(Money.from("1")) > 0) throw new Error(`${field} must not exceed one`);
  return parsed;
}

function safeInteger(value: number, field: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`${field} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
  }
}

function validateConfig(config: KJPaperEngineConfig): void {
  positiveMoney(config.initialCash, "initialCash");
  const edgeThreshold = nonNegativeMoney(config.edgeThreshold, "edgeThreshold");
  const maxEdge = positiveMoney(config.maxEdge, "maxEdge");
  if (maxEdge.comparedTo(edgeThreshold) <= 0) throw new Error("maxEdge must exceed edgeThreshold");
  nonNegativeMoney(config.criticalBandUsd, "criticalBandUsd");
  positiveMoney(config.kellyMultiplier, "kellyMultiplier");
  positiveFraction(config.maximumStakeFraction, "maximumStakeFraction");
  positiveMoney(config.maximumStakeAmount, "maximumStakeAmount");
  positiveFraction(config.maximumMarketFraction, "maximumMarketFraction");
  positiveFraction(config.bookParticipation, "bookParticipation");
  positiveMoney(config.minimumStake, "minimumStake");
  nonNegativeMoney(config.maximumSlippage, "maximumSlippage");
  safeInteger(config.criticalBandMaximumRemainingSeconds,
    "criticalBandMaximumRemainingSeconds", true);
  safeInteger(config.decisionIntervalMilliseconds, "decisionIntervalMilliseconds");
  safeInteger(config.fillLatencyMilliseconds, "fillLatencyMilliseconds");
  safeInteger(config.anchorToleranceMilliseconds, "anchorToleranceMilliseconds", true);
}

function milliseconds(value: string, field: string): number {
  if (!value.endsWith("Z")) throw new Error(`${field} must be explicit UTC`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be a valid timestamp`);
  return parsed;
}

function hash(...parts: readonly string[]): string {
  const digest = createHash("sha256");
  for (const part of parts) {
    digest.update(part);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("K/J canonical JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  throw new Error("K/J canonical JSON accepts only JSON values");
}

export function kjPaperContextIdentity(context: KJStrategyContextV1): string {
  return hash(
    context.market.marketId,
    context.decisionTime,
    context.inputWatermark.clockDomain,
    context.inputWatermark.localMonotonicReceiveNs,
    context.inputWatermark.localReceiveOrdinal,
    context.signal.inputHash,
  );
}

export function kjPaperContextFingerprint(context: KJStrategyContextV1): string {
  return hash(stableJson(context));
}

export function kjPaperSignalIdentity(context: KJStrategyContextV1): string {
  return hash(
    context.signal.provider,
    context.signal.connectionId,
    context.signal.receiveStamp.clockDomain,
    context.signal.receiveStamp.localMonotonicReceiveNs,
    context.signal.receiveStamp.localReceiveOrdinal,
    context.signal.inputHash,
  );
}

export function kjPaperSignalFingerprint(context: KJStrategyContextV1): string {
  return hash(stableJson(context.signal));
}

function sameSettlement(left: KJOfficialSettlement, right: KJOfficialSettlement): boolean {
  return left.settlementId === right.settlementId
    && left.marketId === right.marketId
    && left.winner === right.winner
    && left.settlementTime === right.settlementTime
    && left.evidenceStatus === right.evidenceStatus
    && left.evidenceReference === right.evidenceReference;
}

function canonicalProbability(value: number): Money {
  const bounded = Math.min(Math.max(value, 0.005), 0.995);
  return Money.from(bounded.toFixed(17).replace(/0+$/u, "").replace(/\.$/u, ""));
}

function normalCdf(value: number): number {
  // Abramowitz-Stegun 7.1.26; deterministic and sufficient for the paper signal.
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = sign * (1 - (((((1.061405429 * t - 1.453152027) * t)
    + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
  return 0.5 * (1 + erf);
}

export function kjPaperProbabilityFromZ(value: number): string {
  if (!Number.isFinite(value)) throw new Error("K/J probability z-score must be finite");
  return canonicalProbability(normalCdf(value)).toCanonical();
}

function event(
  eventType: KJPaperEvent["eventType"],
  strategy: KJPaperStrategy | null,
  marketId: string,
  eventTime: string,
  details: Readonly<Record<string, string | boolean | null>>,
): KJPaperEvent {
  return Object.freeze({
    schemaVersion: KJ_PAPER_ENGINE_VERSION,
    eventId: hash(
      KJ_PAPER_ENGINE_VERSION,
      eventType,
      strategy ?? "",
      marketId,
      eventTime,
      JSON.stringify(details),
    ),
    eventType,
    strategy,
    marketId,
    eventTime,
    details: Object.freeze({ ...details }),
  });
}

export class KJPaperEngine {
  readonly #config: KJPaperEngineConfig;
  readonly #wallets = new Map<KJPaperStrategy, PaperWallet>();
  readonly #volatility = new StrategyVolatility();
  readonly #sessions = new Map<string, MarketSession>();
  readonly #pending = new Map<string, PaperIntent>();
  readonly #processedContexts = new Map<string, string>();
  readonly #processedSignalInputs = new Map<string, string>();
  readonly #settlements = new Map<string, KJOfficialSettlement>();
  readonly #settlementsByMarket = new Map<string, KJOfficialSettlement>();
  readonly #events: KJPaperEvent[] = [];

  constructor(config: Partial<KJPaperEngineConfig> = {}) {
    this.#config = Object.freeze({ ...DEFAULT_KJ_PAPER_ENGINE_CONFIG, ...config });
    validateConfig(this.#config);
    for (const strategy of ["J_FEE_AWARE", "K_DUAL_VOL"] as const) {
      this.#wallets.set(strategy, new PaperWallet(this.#config.initialCash));
    }
  }

  ingest(context: KJStrategyContextV1): boolean {
    if (context.mode !== "PAPER_ONLY" || context.safety.orderSubmissionAvailable) {
      throw new Error("K/J paper engine accepts only paper-only contexts");
    }
    const contextKey = kjPaperContextIdentity(context);
    const contextFingerprint = kjPaperContextFingerprint(context);
    const priorContext = this.#processedContexts.get(contextKey);
    if (priorContext !== undefined) {
      if (priorContext !== contextFingerprint) throw new Error("context identity has conflicting content");
      return false;
    }
    this.#processedContexts.set(contextKey, contextFingerprint);
    const now = milliseconds(context.decisionTime, "decisionTime");
    this.#stopExpired(now, context.decisionTime);
    const signalIdentity = kjPaperSignalIdentity(context);
    const signalFingerprint = kjPaperSignalFingerprint(context);
    const priorSignal = this.#processedSignalInputs.get(signalIdentity);
    if (priorSignal !== undefined && priorSignal !== signalFingerprint) {
      throw new Error("signal identity has conflicting content");
    }
    if (priorSignal === undefined) {
      this.#volatility.update(context.signal.price, context.signal.receiveTime);
      this.#processedSignalInputs.set(signalIdentity, signalFingerprint);
    }
    const session = this.#session(context);
    if (session.state !== "RUNNING") return true;
    this.#executePending(context, session, now);
    for (const strategy of ["J_FEE_AWARE", "K_DUAL_VOL"] as const) {
      this.#decide(context, session, strategy, now);
    }
    return true;
  }

  settle(value: KJOfficialSettlement): boolean {
    if (value.settlementId.trim() === "") throw new Error("settlement ID must be non-empty");
    if (value.evidenceReference.trim() === "") {
      throw new Error("settlement evidence reference must be non-empty");
    }
    const prior = this.#settlements.get(value.settlementId);
    if (prior !== undefined) {
      if (!sameSettlement(prior, value)) {
        throw new Error("settlement ID has conflicting content");
      }
      return false;
    }
    if (value.evidenceStatus !== "OFFICIAL_RESOLUTION") {
      throw new Error("paper settlement requires official resolution evidence");
    }
    const marketSettlement = this.#settlementsByMarket.get(value.marketId);
    if (marketSettlement !== undefined) {
      throw new Error("paper market already has a different settlement record");
    }
    const session = this.#sessions.get(value.marketId);
    if (session === undefined) throw new Error("settlement market session is unknown");
    if (milliseconds(value.settlementTime, "settlementTime")
      < milliseconds(session.intervalEnd, "intervalEnd")) {
      throw new Error("settlement precedes market end");
    }
    this.#stopSession(session, value.settlementTime);
    const winningToken = value.winner === "UP" ? session.upTokenId : session.downTokenId;
    for (const strategy of ["J_FEE_AWARE", "K_DUAL_VOL"] as const) {
      const wallet = this.#wallet(strategy);
      const ledger = session.ledgers.get(strategy)!;
      const payout = wallet.settle(session.upTokenId, session.downTokenId, winningToken);
      const gross = payout.minus(ledger.spent);
      const net = gross.minus(ledger.fees);
      this.#events.push(event("SETTLEMENT", strategy, session.marketId, value.settlementTime, {
        settlementId: value.settlementId,
        winner: value.winner,
        payout: payout.toCanonical(),
        grossPnl: gross.toCanonical(),
        fees: ledger.fees.toCanonical(),
        netPnl: net.toCanonical(),
        cashAfter: wallet.cash.toCanonical(),
        evidenceReference: value.evidenceReference,
      }));
    }
    session.state = "DONE";
    this.#events.push(event("MARKET_STATE", null, session.marketId, value.settlementTime, {
      from: "STOPPING",
      to: "DONE",
      reason: "OFFICIAL_SETTLEMENT_APPLIED",
    }));
    const stored = Object.freeze({ ...value });
    this.#settlements.set(value.settlementId, stored);
    this.#settlementsByMarket.set(value.marketId, stored);
    return true;
  }

  events(): readonly KJPaperEvent[] {
    return Object.freeze([...this.#events]);
  }

  state(marketId: string): KJMarketLifecycleState | null {
    return this.#sessions.get(marketId)?.state ?? null;
  }

  wallet(strategy: KJPaperStrategy): Readonly<{
    cash: string;
    available: string;
  }> {
    const wallet = this.#wallet(strategy);
    return Object.freeze({
      cash: wallet.cash.toCanonical(),
      available: wallet.available().toCanonical(),
    });
  }

  position(strategy: KJPaperStrategy, tokenId: string): string {
    return this.#wallet(strategy).position(tokenId).toCanonical();
  }

  snapshot(): KJPaperEngineSnapshot {
    const walletSnapshot = (strategy: KJPaperStrategy) => this.#wallet(strategy).snapshot();
    const ledgerSnapshot = (session: MarketSession, strategy: KJPaperStrategy) => {
      const ledger = session.ledgers.get(strategy)!;
      return Object.freeze({
        spent: ledger.spent.toCanonical(),
        fees: ledger.fees.toCanonical(),
        tradeCount: String(ledger.tradeCount),
      });
    };
    const markets = [...this.#sessions.values()]
      .sort((left, right) => left.intervalStart.localeCompare(right.intervalStart)
        || left.marketId.localeCompare(right.marketId))
      .map((session) => Object.freeze({
        marketId: session.marketId,
        conditionId: session.conditionId,
        slug: session.slug,
        intervalStart: session.intervalStart,
        intervalEnd: session.intervalEnd,
        upTokenId: session.upTokenId,
        downTokenId: session.downTokenId,
        anchorPrice: session.anchorPrice.toCanonical(),
        state: session.state,
        ledgers: Object.freeze({
          J_FEE_AWARE: ledgerSnapshot(session, "J_FEE_AWARE"),
          K_DUAL_VOL: ledgerSnapshot(session, "K_DUAL_VOL"),
        }),
      }));
    const pendingIntents = [...this.#pending.values()]
      .sort((left, right) => left.intentId.localeCompare(right.intentId))
      .map((intent) => Object.freeze({
        intentId: intent.intentId,
        strategy: intent.strategy,
        marketId: intent.marketId,
        tokenId: intent.tokenId,
        outcome: intent.outcome,
        decisionTime: intent.decisionTime,
        executableAfter: new Date(intent.executableAfter).toISOString(),
        probability: intent.probability.toCanonical(),
        decisionAsk: intent.decisionAsk.toCanonical(),
        maximumFillPrice: intent.maximumFillPrice.toCanonical(),
        intendedQuantity: intent.intendedQuantity.toCanonical(),
        reservedAmount: intent.reservedAmount.toCanonical(),
      }));
    return Object.freeze({
      schemaVersion: "kj-paper-engine-snapshot-v1",
      engineVersion: KJ_PAPER_ENGINE_VERSION,
      wallets: Object.freeze({
        J_FEE_AWARE: walletSnapshot("J_FEE_AWARE"),
        K_DUAL_VOL: walletSnapshot("K_DUAL_VOL"),
      }),
      markets: Object.freeze(markets),
      pendingIntents: Object.freeze(pendingIntents),
      eventCount: String(this.#events.length),
    });
  }

  #wallet(strategy: KJPaperStrategy): PaperWallet {
    const wallet = this.#wallets.get(strategy);
    if (wallet === undefined) throw new Error("paper wallet is missing");
    return wallet;
  }

  #session(context: KJStrategyContextV1): MarketSession {
    const existing = this.#sessions.get(context.market.marketId);
    if (existing !== undefined) {
      if (existing.conditionId !== context.market.conditionId
        || existing.slug !== context.market.slug
        || existing.intervalStart !== context.market.intervalStart
        || existing.intervalEnd !== context.market.intervalEnd
        || existing.upTokenId !== context.market.upTokenId
        || existing.downTokenId !== context.market.downTokenId) {
        throw new Error("market identity changed within a paper session");
      }
      return existing;
    }
    const decision = milliseconds(context.decisionTime, "decisionTime");
    const start = milliseconds(context.market.intervalStart, "intervalStart");
    const session: MarketSession = {
      marketId: context.market.marketId,
      conditionId: context.market.conditionId,
      slug: context.market.slug,
      intervalStart: context.market.intervalStart,
      intervalEnd: context.market.intervalEnd,
      upTokenId: context.market.upTokenId,
      downTokenId: context.market.downTokenId,
      anchorPrice: Money.from(context.signal.price),
      state: "INIT",
      lastDecisionByStrategy: new Map(),
      ledgers: new Map([
        ["J_FEE_AWARE", { spent: Money.from("0"), fees: Money.from("0"), tradeCount: 0 }],
        ["K_DUAL_VOL", { spent: Money.from("0"), fees: Money.from("0"), tradeCount: 0 }],
      ]),
    };
    this.#sessions.set(session.marketId, session);
    this.#events.push(event("MARKET_STATE", null, session.marketId, context.decisionTime, {
      from: null,
      to: "INIT",
      reason: "FIRST_CONTEXT",
      conditionId: session.conditionId,
      slug: session.slug,
      intervalStart: session.intervalStart,
      intervalEnd: session.intervalEnd,
      upTokenId: session.upTokenId,
      downTokenId: session.downTokenId,
      anchorPrice: session.anchorPrice.toCanonical(),
    }));
    if (decision - start > this.#config.anchorToleranceMilliseconds) {
      session.state = "STOPPING";
      this.#events.push(event("MARKET_STATE", null, session.marketId, context.decisionTime, {
        from: "INIT",
        to: "STOPPING",
        reason: "MISSED_SIGNAL_OPEN_ANCHOR",
      }));
      return session;
    }
    session.state = "RUNNING";
    this.#events.push(event("MARKET_STATE", null, session.marketId, context.decisionTime, {
      from: "INIT",
      to: "RUNNING",
      reason: "ANCHOR_CAPTURED",
    }));
    return session;
  }

  #stopExpired(now: number, eventTime: string): void {
    for (const session of this.#sessions.values()) {
      if (session.state === "RUNNING" && now >= milliseconds(session.intervalEnd, "intervalEnd")) {
        this.#stopSession(session, eventTime);
      }
    }
  }

  #stopSession(session: MarketSession, eventTime: string): void {
    if (session.state === "DONE" || session.state === "STOPPING") return;
    const prior = session.state;
    session.state = "STOPPING";
    for (const [key, intent] of [...this.#pending]) {
      if (intent.marketId !== session.marketId) continue;
      this.#wallet(intent.strategy).release(intent.intentId);
      this.#pending.delete(key);
      this.#events.push(event("NO_FILL", intent.strategy, session.marketId, eventTime, {
        intentId: intent.intentId,
        reason: "MARKET_STOPPING",
      }));
    }
    this.#events.push(event("MARKET_STATE", null, session.marketId, eventTime, {
      from: prior,
      to: "STOPPING",
      reason: "MARKET_INTERVAL_ENDED",
    }));
  }

  #executePending(context: KJStrategyContextV1, session: MarketSession, now: number): void {
    for (const [key, intent] of [...this.#pending]) {
      if (intent.marketId !== session.marketId || now < intent.executableAfter) continue;
      const book = intent.outcome === "UP" ? context.book.up : context.book.down;
      const price = Money.from(book.ask);
      const visible = Money.from(book.askSize).times(Money.from(this.#config.bookParticipation));
      const wallet = this.#wallet(intent.strategy);
      this.#pending.delete(key);
      if (price.comparedTo(intent.maximumFillPrice) > 0 || !visible.isPositive()) {
        wallet.release(intent.intentId);
        this.#events.push(event("NO_FILL", intent.strategy, session.marketId, context.decisionTime, {
          intentId: intent.intentId,
          reason: price.comparedTo(intent.maximumFillPrice) > 0 ? "SLIPPAGE_LIMIT" : "NO_VISIBLE_SIZE",
        }));
        continue;
      }
      const quantity = minimumMoney(intent.intendedQuantity, visible);
      const cost = price.times(quantity);
      const fee = Money.from(context.feeEvidence.rate)
        .times(price)
        .times(Money.from("1").minus(price))
        .times(quantity);
      wallet.fill(intent.intentId, intent.tokenId, quantity, cost, fee);
      const ledger = session.ledgers.get(intent.strategy)!;
      ledger.spent = ledger.spent.plus(cost);
      ledger.fees = ledger.fees.plus(fee);
      ledger.tradeCount += 1;
      this.#events.push(event("FILL", intent.strategy, session.marketId, context.decisionTime, {
        intentId: intent.intentId,
        tokenId: intent.tokenId,
        outcome: intent.outcome,
        price: price.toCanonical(),
        quantity: quantity.toCanonical(),
        intendedQuantity: intent.intendedQuantity.toCanonical(),
        partial: quantity.comparedTo(intent.intendedQuantity) < 0,
        cost: cost.toCanonical(),
        fee: fee.toCanonical(),
        cashAfter: wallet.cash.toCanonical(),
        positionAfter: wallet.position(intent.tokenId).toCanonical(),
        executionContextHash: kjPaperContextFingerprint(context),
        executionBookReceiveOrdinal: context.book.receiveStamp.localReceiveOrdinal,
      }));
    }
  }

  #decide(
    context: KJStrategyContextV1,
    session: MarketSession,
    strategy: KJPaperStrategy,
    now: number,
  ): void {
    const last = session.lastDecisionByStrategy.get(strategy);
    if (last !== undefined && now - last < this.#config.decisionIntervalMilliseconds) return;
    if ([...this.#pending.values()].some((intent) =>
      intent.marketId === session.marketId && intent.strategy === strategy)) return;
    const sigma = this.#volatility.sigma(strategy);
    if (sigma === null || sigma <= 0) return;
    session.lastDecisionByStrategy.set(strategy, now);
    const remainingSeconds = (milliseconds(session.intervalEnd, "intervalEnd") - now) / 1_000;
    const current = Number(context.signal.price);
    const opening = Number(session.anchorPrice.toCanonical());
    const probability = Money.from(kjPaperProbabilityFromZ(
      Math.log(current / opening) / (sigma * Math.sqrt(remainingSeconds)),
    ));
    const currentMoney = Money.from(context.signal.price);
    if (remainingSeconds < this.#config.criticalBandMaximumRemainingSeconds
      && currentMoney.minus(session.anchorPrice).abs()
        .comparedTo(Money.from(this.#config.criticalBandUsd)) < 0) {
      this.#events.push(event("DECISION", strategy, session.marketId, context.decisionTime, {
        action: "NO_TRADE",
        reason: "CRITICAL_BAND",
        probabilityUp: probability.toCanonical(),
        sigma: sigma.toString(),
      }));
      return;
    }
    const upAsk = Money.from(context.book.up.ask);
    const downAsk = Money.from(context.book.down.ask);
    const downProbability = Money.from("1").minus(probability);
    const upEdge = probability.minus(upAsk);
    const downEdge = downProbability.minus(downAsk);
    const outcome = upEdge.comparedTo(downEdge) >= 0 ? "UP" : "DOWN";
    const sideProbability = outcome === "UP" ? probability : downProbability;
    const ask = outcome === "UP" ? upAsk : downAsk;
    const askSize = Money.from(outcome === "UP" ? context.book.up.askSize : context.book.down.askSize);
    const edge = sideProbability.minus(ask);
    const rate = Money.from(context.feeEvidence.rate);
    const feePerShare = rate.times(ask).times(Money.from("1").minus(ask));
    const overround = upAsk.plus(downAsk).minus(Money.from("1"));
    const spreadBuffer = overround.isPositive()
      ? overround.dividedBy(Money.from("2"))
      : Money.from("0");
    const required = Money.from(this.#config.edgeThreshold).plus(feePerShare).plus(spreadBuffer);
    if (edge.comparedTo(required) <= 0 || edge.comparedTo(Money.from(this.#config.maxEdge)) > 0) {
      this.#events.push(event("DECISION", strategy, session.marketId, context.decisionTime, {
        action: "NO_TRADE",
        reason: edge.comparedTo(required) <= 0 ? "EDGE_BELOW_THRESHOLD" : "EDGE_ABOVE_STALE_GUARD",
        outcome,
        probabilityUp: probability.toCanonical(),
        sigma: sigma.toString(),
        edge: edge.toCanonical(),
        requiredEdge: required.toCanonical(),
      }));
      return;
    }
    const wallet = this.#wallet(strategy);
    const available = wallet.available();
    const kelly = edge.dividedBy(Money.from("1").minus(ask));
    const fraction = minimumMoney(
      kelly.times(Money.from(this.#config.kellyMultiplier)),
      Money.from(this.#config.maximumStakeFraction),
    );
    const feePerStake = rate.times(Money.from("1").minus(ask));
    const inclusiveCap = available
      .times(Money.from(this.#config.maximumStakeFraction))
      .dividedBy(Money.from("1").plus(feePerStake));
    const ledger = session.ledgers.get(strategy)!;
    const marketBudget = available
      .times(Money.from(this.#config.maximumMarketFraction))
      .minus(ledger.spent.plus(ledger.fees));
    if (!marketBudget.isPositive()) return;
    const stake = minimumMoney(
      minimumMoney(available.times(fraction), inclusiveCap),
      minimumMoney(Money.from(this.#config.maximumStakeAmount), marketBudget),
    );
    const quantity = minimumMoney(
      stake.dividedBy(ask),
      askSize.times(Money.from(this.#config.bookParticipation)),
    );
    const intendedStake = quantity.times(ask);
    if (intendedStake.comparedTo(Money.from(this.#config.minimumStake)) < 0) return;
    const maximumFillPrice = minimumMoney(
      ask.plus(Money.from(this.#config.maximumSlippage)),
      Money.from("1"),
    );
    const maximumFillFee = rate
      .times(maximumFillPrice)
      .times(Money.from("1").minus(maximumFillPrice))
      .times(quantity);
    const reserved = maximumFillPrice.times(quantity).plus(maximumFillFee);
    if (reserved.comparedTo(available) > 0) return;
    const tokenId = outcome === "UP" ? session.upTokenId : session.downTokenId;
    const intentId = hash(
      "intent",
      strategy,
      session.marketId,
      context.decisionTime,
      tokenId,
    );
    wallet.reserve(intentId, reserved);
    const contextHash = kjPaperContextFingerprint(context);
    this.#events.push(event("DECISION", strategy, session.marketId, context.decisionTime, {
      action: "INTENT",
      reason: "EDGE_ACCEPTED",
      outcome,
      probabilityUp: probability.toCanonical(),
      sigma: sigma.toString(),
      edge: edge.toCanonical(),
      requiredEdge: required.toCanonical(),
      intendedQuantity: quantity.toCanonical(),
      contextHash,
    }));
    this.#pending.set(`${strategy}:${session.marketId}`, {
      intentId,
      strategy,
      marketId: session.marketId,
      tokenId,
      outcome,
      decisionTime: context.decisionTime,
      executableAfter: now + this.#config.fillLatencyMilliseconds,
      probability: sideProbability,
      decisionAsk: ask,
      maximumFillPrice,
      intendedQuantity: quantity,
      reservedAmount: reserved,
    });
    this.#events.push(event("INTENT", strategy, session.marketId, context.decisionTime, {
      intentId,
      tokenId,
      outcome,
      probability: sideProbability.toCanonical(),
      decisionAsk: ask.toCanonical(),
      maximumFillPrice: maximumFillPrice.toCanonical(),
      intendedQuantity: quantity.toCanonical(),
      reservedAmount: reserved.toCanonical(),
      availableAfterReservation: wallet.available().toCanonical(),
      contextHash,
      signalInputHash: context.signal.inputHash,
      inputWatermarkReceiveOrdinal: context.inputWatermark.localReceiveOrdinal,
    }));
  }
}
