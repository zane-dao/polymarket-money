import { createHash } from "node:crypto";

import { Money } from "../domain/money.js";
import {
  DEFAULT_KJ_PAPER_ENGINE_CONFIG,
  type KJPaperEngineSnapshot,
  type KJPaperEvent,
  type KJPaperStrategy,
} from "../runtime/kj-paper-engine.js";

export const KJ_PAPER_REPORT_VERSION = "kj-paper-report-v1" as const;

const STRATEGIES = ["J_FEE_AWARE", "K_DUAL_VOL"] as const;
const HASH = /^[0-9a-f]{64}$/u;
const INTEGER = /^(?:0|[1-9]\d*)$/u;
const PNL_RECONCILIATION_TOLERANCE = Money.from("0.000000000000000000000000000000000000000000000000000000000001");

interface ReportPlan {
  readonly runId: string;
  readonly targetMarketCount: number;
  readonly firstFullMarketStart: string;
  readonly captureEnd: string;
  readonly journalPath: string;
  readonly collectorGitCommit: string;
  readonly warmupSeconds?: number;
  readonly campaign?: Readonly<{
    campaignId: string;
    campaignHash: string;
    campaignRunIndex: number;
  }>;
}

export interface KJPaperMarketReportRow {
  readonly marketId: string;
  readonly slug: string;
  readonly intervalStart: string;
  readonly intervalEnd: string;
  readonly winner: "UP" | "DOWN";
  readonly settlementTime: string;
  readonly strategy: KJPaperStrategy;
  readonly tradeCount: string;
  readonly spent: string;
  readonly payout: string;
  readonly grossPnl: string;
  readonly fees: string;
  readonly netPnl: string;
  readonly cashAfter: string;
  readonly evidenceReference: string;
}

export interface BuildKJPaperReportInput {
  readonly plan: unknown;
  readonly result: unknown;
  readonly runtimeSummary: unknown;
  readonly journalPath: string;
  readonly journalRecordCount: number;
  readonly journalLastRecordHash: string | null;
  readonly journalRunPlan: unknown | null;
  readonly unsettledMarketIds: readonly string[];
  readonly snapshot: KJPaperEngineSnapshot;
  readonly events: readonly KJPaperEvent[];
  readonly warmupEvidence: Readonly<{
    signalCount: number;
    sourceFamily: "BINANCE" | "CHAINLINK" | null;
    firstReceiveTime: string | null;
    lastReceiveTime: string | null;
  }>;
}

export interface KJPaperReport {
  readonly schemaVersion: typeof KJ_PAPER_REPORT_VERSION;
  readonly evidenceStatus:
    | "DESCRIPTIVE_PAPER_ONLY"
    | "DESCRIPTIVE_PAPER_ONLY_LEGACY_UNBOUND_PLAN";
  readonly profitabilityClaimEligible: false;
  readonly planBinding: "HASH_CHAINED" | "LEGACY_UNBOUND";
  readonly run: Readonly<{
    runId: string;
    collectorGitCommit: string;
    targetMarketCount: number;
    firstFullMarketStart: string;
    captureEnd: string;
    journalPath: string;
    journalRecordCount: string;
    journalLastRecordHash: string;
    resultKind: "INITIAL" | "RECOVERED_FINAL" | "LEGACY";
    warmup?: Readonly<{
      requiredSeconds: number;
      signalCount: string;
      observedSeconds: string;
      sourceFamily: "BINANCE" | "CHAINLINK";
    }>;
    campaign?: Readonly<{
      campaignId: string;
      campaignHash: string;
      campaignRunIndex: number;
    }>;
  }>;
  readonly checks: Readonly<Record<string, true>>;
  readonly strategies: Readonly<Record<KJPaperStrategy, Readonly<{
    marketCount: string;
    tradedMarketCount: string;
    noTradeMarketCount: string;
    profitableMarketCount: string;
    losingMarketCount: string;
    flatMarketCount: string;
    totalTradeCount: string;
    totalSpent: string;
    totalGrossPnl: string;
    totalFees: string;
    totalNetPnl: string;
    pnlReconciliationResidual: string;
    averageNetPnlPerMarket: string;
    finalCash: string;
  }>>>;
  readonly markets: readonly KJPaperMarketReportRow[];
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be non-empty`);
  return value;
}

function utc(value: unknown, field: string): string {
  const candidate = text(value, field);
  if (!candidate.endsWith("Z") || !Number.isFinite(Date.parse(candidate))) {
    throw new Error(`${field} must be explicit UTC`);
  }
  return candidate;
}

function safeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function integerText(value: unknown, field: string): string {
  const candidate = text(value, field);
  if (!INTEGER.test(candidate)) throw new Error(`${field} must be a canonical non-negative integer`);
  return candidate;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("report JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  throw new Error("report accepts only JSON values");
}

export function kjPaperReportHash(value: KJPaperReport): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

export interface KJPaperReportArtifactCore {
  readonly schemaVersion: "kj-paper-report-artifact-v1";
  readonly report: KJPaperReport;
  readonly sourceFileSha256: Readonly<{
    runPlan: string;
    result: string;
    runtimeSummary: string;
  }>;
  readonly resultFileName: "result.json" | "final-result.json";
  readonly marketsCsvSha256: string;
}

export function kjPaperReportArtifactHash(value: KJPaperReportArtifactCore): string {
  for (const [field, digest] of Object.entries({
    ...value.sourceFileSha256,
    marketsCsv: value.marketsCsvSha256,
  })) {
    if (!HASH.test(digest)) throw new Error(`paper report ${field} SHA-256 is invalid`);
  }
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function plan(value: unknown): ReportPlan {
  const candidate = object(value, "run plan");
  if (candidate.schemaVersion !== "kj-paper-mvp-v1") throw new Error("run plan schema is unsupported");
  const targetMarketCount = safeInteger(candidate.targetMarketCount, "targetMarketCount");
  if (targetMarketCount === 0) throw new Error("targetMarketCount must be positive");
  const firstFullMarketStart = utc(candidate.firstFullMarketStart, "firstFullMarketStart");
  const captureEnd = utc(candidate.captureEnd, "captureEnd");
  if (Date.parse(firstFullMarketStart) >= Date.parse(captureEnd)) {
    throw new Error("run plan target window must be non-empty");
  }
  const collectorGitCommit = text(candidate.collectorGitCommit, "collectorGitCommit");
  if (!/^[0-9a-f]{40,64}$/u.test(collectorGitCommit)) throw new Error("collectorGitCommit is invalid");
  const warmupSeconds = candidate.warmupSeconds === undefined
    ? undefined
    : safeInteger(candidate.warmupSeconds, "warmupSeconds");
  if (warmupSeconds !== undefined && warmupSeconds === 0) throw new Error("warmupSeconds must be positive");
  let campaign: ReportPlan["campaign"];
  if (candidate.campaign !== undefined) {
    const binding = object(candidate.campaign, "campaign binding");
    const campaignId = text(binding.campaignId, "campaignId");
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/u.test(campaignId)) throw new Error("campaignId is invalid");
    const campaignHash = text(binding.campaignHash, "campaignHash");
    if (!HASH.test(campaignHash)) throw new Error("campaignHash is invalid");
    const campaignRunIndex = safeInteger(binding.campaignRunIndex, "campaignRunIndex");
    if (campaignRunIndex === 0) throw new Error("campaignRunIndex must be positive");
    campaign = Object.freeze({ campaignId, campaignHash, campaignRunIndex });
  }
  return Object.freeze({
    runId: text(candidate.runId, "runId"),
    targetMarketCount,
    firstFullMarketStart,
    captureEnd,
    journalPath: text(candidate.journalPath, "journalPath"),
    collectorGitCommit,
    ...(warmupSeconds === undefined ? {} : { warmupSeconds }),
    ...(campaign === undefined ? {} : { campaign }),
  });
}

function requireAcceptedResult(value: unknown, expected: ReportPlan, input: BuildKJPaperReportInput): Record<string, unknown> {
  const result = object(value, "MVP result");
  if (result.schemaVersion !== "kj-paper-mvp-v1" || result.accepted !== true) {
    throw new Error("paper report requires an accepted MVP result");
  }
  const checks = object(result.checks, "MVP result checks");
  if (Object.keys(checks).length === 0 || Object.values(checks).some((passed) => passed !== true)) {
    throw new Error("MVP result contains a failed acceptance check");
  }
  if (result.runId !== expected.runId || result.collectorGitCommit !== expected.collectorGitCommit) {
    throw new Error("MVP result identity conflicts with its run plan");
  }
  if (safeInteger(result.targetMarketCount, "result targetMarketCount") !== expected.targetMarketCount
    || safeInteger(result.observedTargetMarketCount, "observedTargetMarketCount") !== expected.targetMarketCount
    || safeInteger(result.completedMarketCount, "completedMarketCount") !== expected.targetMarketCount) {
    throw new Error("MVP result target counts conflict with its run plan");
  }
  if (safeInteger(result.journalRecordCount, "journalRecordCount") !== input.journalRecordCount
    || result.journalLastRecordHash !== input.journalLastRecordHash) {
    throw new Error("MVP result journal anchor conflicts with replay");
  }
  if (stableJson(result.engineState) !== stableJson(input.snapshot)) {
    throw new Error("MVP result engine snapshot conflicts with journal replay");
  }
  return result;
}

function requireSafeRuntime(value: unknown, expected: ReportPlan): void {
  const summary = object(value, "runtime summary");
  const safety = object(summary.safety, "runtime safety");
  if (summary.terminalFailure !== null
    || summary.realOrderCount !== 0
    || safety.liveClientConstructed !== false
    || safety.userChannelConnected !== false
    || safety.credentialsRead !== false
    || safety.ordersSent !== 0) {
    throw new Error("runtime summary does not prove paper-only safety");
  }
  if (summary.collectorGitCommit !== expected.collectorGitCommit
    || summary.kjMarketStartBefore !== expected.captureEnd) {
    throw new Error("runtime summary identity or target cutoff conflicts with the plan");
  }
}

function verifyWarmup(
  expected: ReportPlan,
  evidence: BuildKJPaperReportInput["warmupEvidence"],
  runtime: unknown,
): KJPaperReport["run"]["warmup"] | undefined {
  if (expected.warmupSeconds === undefined) return undefined;
  if (evidence.signalCount < 2 || evidence.sourceFamily === null
    || evidence.firstReceiveTime === null || evidence.lastReceiveTime === null) {
    throw new Error("planned K warmup lacks durable signal evidence");
  }
  const first = Date.parse(evidence.firstReceiveTime);
  const last = Date.parse(evidence.lastReceiveTime);
  const start = Date.parse(expected.firstFullMarketStart);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first >= last || last >= start
    || last - first < expected.warmupSeconds * 1_000) {
    throw new Error("planned K warmup duration is incomplete or crosses the first market boundary");
  }
  const source = object(runtime, "runtime summary").kjSignalSource;
  const expectedFamily = source === "BINANCE_SPOT" ? "BINANCE" : source === "CHAINLINK" ? "CHAINLINK" : null;
  if (expectedFamily !== evidence.sourceFamily) throw new Error("warmup signal source family conflicts with runtime source");
  return Object.freeze({
    requiredSeconds: expected.warmupSeconds,
    signalCount: String(evidence.signalCount),
    observedSeconds: String((last - first) / 1_000),
    sourceFamily: evidence.sourceFamily,
  });
}

function settlementRow(
  event: KJPaperEvent,
  market: KJPaperEngineSnapshot["markets"][number],
  strategy: KJPaperStrategy,
): KJPaperMarketReportRow {
  if (event.strategy !== strategy || event.eventType !== "SETTLEMENT") {
    throw new Error("paper report received a non-matching settlement event");
  }
  const details = event.details;
  const winner = details.winner;
  if (winner !== "UP" && winner !== "DOWN") throw new Error("settlement winner is invalid");
  const ledger = market.ledgers[strategy];
  const spent = Money.from(ledger.spent);
  const payout = Money.from(text(details.payout, "settlement payout"));
  const grossPnl = Money.from(text(details.grossPnl, "settlement grossPnl"));
  const fees = Money.from(text(details.fees, "settlement fees"));
  const netPnl = Money.from(text(details.netPnl, "settlement netPnl"));
  if (payout.minus(spent).comparedTo(grossPnl) !== 0) {
    throw new Error("settlement payout - spent does not equal gross PnL");
  }
  if (grossPnl.minus(fees).comparedTo(netPnl) !== 0) {
    throw new Error("settlement gross PnL - fees does not equal net PnL");
  }
  if (fees.comparedTo(Money.from(ledger.fees)) !== 0) {
    throw new Error("settlement fees conflict with the market ledger");
  }
  return Object.freeze({
    marketId: market.marketId,
    slug: market.slug,
    intervalStart: market.intervalStart,
    intervalEnd: market.intervalEnd,
    winner,
    settlementTime: utc(event.eventTime, "settlementTime"),
    strategy,
    tradeCount: integerText(ledger.tradeCount, "tradeCount"),
    spent: spent.toCanonical(),
    payout: payout.toCanonical(),
    grossPnl: grossPnl.toCanonical(),
    fees: fees.toCanonical(),
    netPnl: netPnl.toCanonical(),
    cashAfter: Money.from(text(details.cashAfter, "settlement cashAfter")).toCanonical(),
    evidenceReference: text(details.evidenceReference, "settlement evidenceReference"),
  });
}

function strategySummary(
  strategy: KJPaperStrategy,
  rows: readonly KJPaperMarketReportRow[],
  result: Record<string, unknown>,
  snapshot: KJPaperEngineSnapshot,
): KJPaperReport["strategies"][KJPaperStrategy] {
  const selected = rows.filter((row) => row.strategy === strategy);
  let totalSpent = Money.from("0");
  let totalGross = Money.from("0");
  let totalFees = Money.from("0");
  let totalNet = Money.from("0");
  let totalTrades = 0;
  let traded = 0;
  let profitable = 0;
  let losing = 0;
  for (const row of selected) {
    totalSpent = totalSpent.plus(Money.from(row.spent));
    totalGross = totalGross.plus(Money.from(row.grossPnl));
    totalFees = totalFees.plus(Money.from(row.fees));
    totalNet = totalNet.plus(Money.from(row.netPnl));
    const trades = Number(row.tradeCount);
    totalTrades += trades;
    if (trades > 0) traded += 1;
    const comparison = Money.from(row.netPnl).comparedTo(Money.from("0"));
    if (comparison > 0) profitable += 1;
    else if (comparison < 0) losing += 1;
  }
  const resultStrategies = object(result.strategies, "result strategies");
  const resultStrategy = object(resultStrategies[strategy], `result strategy ${strategy}`);
  const finalCash = snapshot.wallets[strategy].cash;
  const cashPnl = Money.from(finalCash).minus(Money.from(DEFAULT_KJ_PAPER_ENGINE_CONFIG.initialCash));
  const residual = cashPnl.minus(totalNet);
  if (residual.abs().comparedTo(PNL_RECONCILIATION_TOLERANCE) > 0
    || Money.from(text(resultStrategy.finalCash, `result ${strategy} finalCash`)).comparedTo(Money.from(finalCash)) !== 0
    || Money.from(text(resultStrategy.netPnl, `result ${strategy} netPnl`)).comparedTo(cashPnl) !== 0) {
    throw new Error(`${strategy} aggregate PnL conflicts with final wallet or MVP result`);
  }
  const marketCount = selected.length;
  return Object.freeze({
    marketCount: String(marketCount),
    tradedMarketCount: String(traded),
    noTradeMarketCount: String(marketCount - traded),
    profitableMarketCount: String(profitable),
    losingMarketCount: String(losing),
    flatMarketCount: String(marketCount - profitable - losing),
    totalTradeCount: String(totalTrades),
    totalSpent: totalSpent.toCanonical(),
    totalGrossPnl: totalGross.toCanonical(),
    totalFees: totalFees.toCanonical(),
    totalNetPnl: totalNet.toCanonical(),
    pnlReconciliationResidual: residual.toCanonical(),
    averageNetPnlPerMarket: totalNet.dividedBy(Money.from(String(marketCount))).toCanonical(),
    finalCash,
  });
}

export function buildKJPaperReport(input: BuildKJPaperReportInput): KJPaperReport {
  const runPlan = plan(input.plan);
  if (input.journalPath !== runPlan.journalPath) throw new Error("opened journal differs from the run plan");
  if (input.journalLastRecordHash === null || !HASH.test(input.journalLastRecordHash)) {
    throw new Error("journal replay has no valid tail hash");
  }
  if (input.unsettledMarketIds.length !== 0 || input.snapshot.pendingIntents.length !== 0) {
    throw new Error("paper report refuses unsettled markets or pending intents");
  }
  const result = requireAcceptedResult(input.result, runPlan, input);
  const resultKind = result.resultKind === "INITIAL" || result.resultKind === "RECOVERED_FINAL"
    ? result.resultKind
    : "LEGACY";
  requireSafeRuntime(input.runtimeSummary, runPlan);
  const warmup = verifyWarmup(runPlan, input.warmupEvidence, input.runtimeSummary);
  let planBinding: KJPaperReport["planBinding"] = "LEGACY_UNBOUND";
  if (input.journalRunPlan !== null) {
    const chained = object(input.journalRunPlan, "hash-chained run plan");
    const expected = {
      schemaVersion: runPlan.campaign === undefined ? "kj-paper-run-plan-v1" : "kj-paper-run-plan-v2",
      runId: runPlan.runId,
      targetMarketCount: runPlan.targetMarketCount,
      firstFullMarketStart: runPlan.firstFullMarketStart,
      captureEnd: runPlan.captureEnd,
      collectorGitCommit: runPlan.collectorGitCommit,
      ...(runPlan.campaign === undefined ? {} : runPlan.campaign),
    };
    if (stableJson(chained) !== stableJson(expected)) {
      throw new Error("hash-chained run plan conflicts with run-plan.json");
    }
    planBinding = "HASH_CHAINED";
  }

  const lower = Date.parse(runPlan.firstFullMarketStart);
  const upper = Date.parse(runPlan.captureEnd);
  const targetMarkets = input.snapshot.markets.filter((market) => {
    const start = Date.parse(market.intervalStart);
    return start >= lower && start < upper;
  });
  if (targetMarkets.length !== runPlan.targetMarketCount
    || targetMarkets.some((market) => market.state !== "DONE")) {
    throw new Error("journal replay does not contain exactly the completed target markets");
  }
  for (const market of input.snapshot.markets.filter((candidate) => !targetMarkets.includes(candidate))) {
    for (const strategy of STRATEGIES) {
      const ledger = market.ledgers[strategy];
      if (ledger.tradeCount !== "0" || ledger.spent !== "0" || ledger.fees !== "0") {
        throw new Error("non-target warmup market contains paper trades");
      }
    }
  }
  if (input.snapshot.eventCount !== String(input.events.length)) {
    throw new Error("snapshot event count conflicts with replayed events");
  }

  const rows: KJPaperMarketReportRow[] = [];
  for (const market of targetMarkets) {
    const events = input.events.filter((event) => event.marketId === market.marketId
      && event.eventType === "SETTLEMENT");
    for (const strategy of STRATEGIES) {
      const matching = events.filter((event) => event.strategy === strategy);
      if (matching.length !== 1) throw new Error("target market lacks one settlement per strategy");
      rows.push(settlementRow(matching[0]!, market, strategy));
    }
    const pair = rows.slice(-2);
    if (pair[0]!.winner !== pair[1]!.winner
      || pair[0]!.settlementTime !== pair[1]!.settlementTime
      || pair[0]!.evidenceReference !== pair[1]!.evidenceReference) {
      throw new Error("strategy settlement evidence differs within one market");
    }
  }

  const strategies = Object.freeze({
    J_FEE_AWARE: strategySummary("J_FEE_AWARE", rows, result, input.snapshot),
    K_DUAL_VOL: strategySummary("K_DUAL_VOL", rows, result, input.snapshot),
  });
  return Object.freeze({
    schemaVersion: KJ_PAPER_REPORT_VERSION,
    evidenceStatus: planBinding === "HASH_CHAINED"
      ? "DESCRIPTIVE_PAPER_ONLY"
      : "DESCRIPTIVE_PAPER_ONLY_LEGACY_UNBOUND_PLAN",
    profitabilityClaimEligible: false,
    planBinding,
    run: Object.freeze({
      runId: runPlan.runId,
      collectorGitCommit: runPlan.collectorGitCommit,
      targetMarketCount: runPlan.targetMarketCount,
      firstFullMarketStart: runPlan.firstFullMarketStart,
      captureEnd: runPlan.captureEnd,
      journalPath: input.journalPath,
      journalRecordCount: String(input.journalRecordCount),
      journalLastRecordHash: input.journalLastRecordHash,
      resultKind,
      ...(warmup === undefined ? {} : { warmup }),
      ...(runPlan.campaign === undefined ? {} : { campaign: runPlan.campaign }),
    }),
    checks: Object.freeze({
      acceptedMvpResult: true,
      runtimePaperSafety: true,
      planResultRuntimeIdentity: true,
      journalTailAnchor: true,
      [planBinding === "HASH_CHAINED" ? "hashChainedRunPlan" : "legacyUnboundRunPlanDisclosed"]: true,
      replaySnapshotEquality: true,
      exactTargetWindow: true,
      officialSettlementPairs: true,
      perMarketPnlIdentity: true,
      aggregateWalletPnlIdentity: true,
      noPendingRisk: true,
    }),
    strategies,
    markets: Object.freeze(rows),
  });
}

function csvField(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function kjPaperReportCsv(report: KJPaperReport): string {
  const header = [
    "market_id", "slug", "interval_start", "interval_end", "winner", "settlement_time",
    "strategy", "trade_count", "spent", "payout", "gross_pnl", "fees", "net_pnl",
    "cash_after", "evidence_reference",
  ];
  const lines = report.markets.map((row) => [
    row.marketId, row.slug, row.intervalStart, row.intervalEnd, row.winner, row.settlementTime,
    row.strategy, row.tradeCount, row.spent, row.payout, row.grossPnl, row.fees, row.netPnl,
    row.cashAfter, row.evidenceReference,
  ].map(csvField).join(","));
  return `${header.map(csvField).join(",")}\n${lines.join("\n")}\n`;
}
