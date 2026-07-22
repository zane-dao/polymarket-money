import { Money } from "../domain/money.js";
import type { PublicBtcFiveMinuteMarket } from "../adapters/market-data/public-sources.js";
import {
  DEFAULT_KJ_PAPER_ENGINE_CONFIG,
  type KJPaperEngineSnapshot,
} from "../runtime/kj-paper-engine.js";
import type { KJPaperRunPlanEvidence } from "../storage/kj-paper-journal.js";
import {
  KJ_PAPER_MVP_VERSION,
  type KJPaperMvpPlan,
} from "./kj-paper-mvp.js";

export type KJPaperMvpResultKind = "INITIAL" | "RECOVERED_FINAL";

export interface BuildKJPaperMvpResultInput {
  readonly plan: KJPaperMvpPlan;
  readonly resultKind: KJPaperMvpResultKind;
  readonly resultPath: string;
  readonly childExitedCleanly: boolean;
  readonly collectorGitCommit: string;
  readonly runtimeSummary: unknown;
  readonly journalPath: string;
  readonly journalRecordCount: number;
  readonly journalLastRecordHash: string | null;
  readonly journalRunPlan: KJPaperRunPlanEvidence | null;
  readonly unsettledMarkets: readonly PublicBtcFiveMinuteMarket[];
  readonly snapshot: KJPaperEngineSnapshot;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function buildKJPaperMvpResult(input: BuildKJPaperMvpResultInput): unknown {
  const summary = object(input.runtimeSummary, "runtime summary");
  const safety = object(summary.safety, "runtime safety");
  const state = input.snapshot;
  const targetMarkets = state.markets.filter((market) => (
    Date.parse(market.intervalStart) >= Date.parse(input.plan.firstFullMarketStart)
    && Date.parse(market.intervalStart) < Date.parse(input.plan.captureEnd)
  ));
  const completedMarkets = targetMarkets.filter((market) => market.state === "DONE").length;
  const unsettledMarkets = input.unsettledMarkets.map((market) => market.marketId);
  const chainedPlan = input.journalRunPlan;
  const planBound = chainedPlan !== null
    && chainedPlan.runId === input.plan.runId
    && chainedPlan.targetMarketCount === input.plan.targetMarketCount
    && chainedPlan.firstFullMarketStart === input.plan.firstFullMarketStart
    && chainedPlan.captureEnd === input.plan.captureEnd
    && chainedPlan.collectorGitCommit === input.collectorGitCommit
    && (input.plan.warmupSeconds !== undefined
      ? chainedPlan.schemaVersion === "kj-paper-run-plan-v3"
        && chainedPlan.warmupSeconds === input.plan.warmupSeconds
        && (input.plan.campaign === undefined
          ? chainedPlan.campaign === undefined
          : chainedPlan.campaign?.campaignId === input.plan.campaign.campaignId
            && chainedPlan.campaign?.campaignHash === input.plan.campaign.campaignHash
            && chainedPlan.campaign?.campaignRunIndex === input.plan.campaign.campaignRunIndex)
      : input.plan.campaign === undefined
        ? chainedPlan.schemaVersion === "kj-paper-run-plan-v1"
        : chainedPlan.schemaVersion === "kj-paper-run-plan-v2"
        && chainedPlan.campaignId === input.plan.campaign.campaignId
        && chainedPlan.campaignHash === input.plan.campaign.campaignHash
        && chainedPlan.campaignRunIndex === input.plan.campaign.campaignRunIndex);
  const checks = Object.freeze({
    childExitedCleanly: input.childExitedCleanly,
    noTerminalFailure: summary.terminalFailure === null,
    runtimeIdentityBound: summary.collectorGitCommit === input.collectorGitCommit
      && summary.kjMarketStartBefore === input.plan.captureEnd
      && summary.kjPaperJournalPath === input.journalPath
      && summary.mode === "paper",
    noRealOrders: summary.realOrderCount === 0
      && safety.ordersSent === 0
      && safety.liveClientConstructed === false
      && safety.userChannelConnected === false
      && safety.credentialsRead === false,
    targetMarketsObserved: targetMarkets.length === input.plan.targetMarketCount,
    targetMarketsSettled: completedMarkets === input.plan.targetMarketCount,
    noPendingMarkets: unsettledMarkets.length === 0 && state.pendingIntents.length === 0,
    durableInputsPresent: input.journalRecordCount > 2 && input.journalLastRecordHash !== null,
    hashChainedRunPlan: planBound,
  });
  const accepted = Object.values(checks).every(Boolean);
  const cash = state.wallets;
  return Object.freeze({
    schemaVersion: KJ_PAPER_MVP_VERSION,
    resultKind: input.resultKind,
    accepted,
    checks,
    runId: input.plan.runId,
    runtimeRunId: typeof summary.runId === "string" ? summary.runId : null,
    collectorGitCommit: input.collectorGitCommit,
    planBinding: planBound ? "HASH_CHAINED" : "MISSING_OR_CONFLICTING",
    targetMarketCount: input.plan.targetMarketCount,
    completedMarketCount: completedMarkets,
    observedTargetMarketCount: targetMarkets.length,
    totalEngineMarketCount: state.markets.length,
    journalRecordCount: input.journalRecordCount,
    journalLastRecordHash: input.journalLastRecordHash,
    unsettledMarketIds: unsettledMarkets,
    strategies: {
      J_FEE_AWARE: {
        finalCash: cash.J_FEE_AWARE.cash,
        netPnl: Money.from(cash.J_FEE_AWARE.cash)
          .minus(Money.from(DEFAULT_KJ_PAPER_ENGINE_CONFIG.initialCash)).toCanonical(),
      },
      K_DUAL_VOL: {
        finalCash: cash.K_DUAL_VOL.cash,
        netPnl: Money.from(cash.K_DUAL_VOL.cash)
          .minus(Money.from(DEFAULT_KJ_PAPER_ENGINE_CONFIG.initialCash)).toCanonical(),
      },
    },
    engineState: state,
    artifacts: {
      runDirectory: input.plan.runDirectory,
      journal: input.plan.journalPath,
      summary: input.plan.summaryPath,
      result: input.resultPath,
      runtimeLog: input.plan.runtimeStdoutPath,
      runtimeErrorLog: input.plan.runtimeStderrPath,
    },
  });
}
