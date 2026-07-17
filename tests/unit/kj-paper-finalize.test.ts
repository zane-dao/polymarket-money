import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import type { PublicBtcFiveMinuteMarket } from "../../execution/src/adapters/market-data/public-sources.js";
import type { ReceiveStamp } from "../../execution/src/domain/receive-time.js";
import { buildKJPaperMvpResult } from "../../execution/src/product/kj-paper-mvp-result.js";
import { KJPaperJournal } from "../../execution/src/storage/kj-paper-journal.js";
import { createKJStrategyContext } from "../../execution/src/strategy/kj-context.js";

const execFile = promisify(execFileCallback);
const START = "2026-07-17T00:00:00.000Z";
const END = "2026-07-17T00:05:00.000Z";
const COMMIT = "a".repeat(40);

function stamp(ordinal: number): ReceiveStamp {
  return {
    schemaVersion: "receive-stamp-v1",
    clockDomain: "finalize-test-clock",
    localWallReceiveTime: START,
    localMonotonicReceiveNs: String(ordinal * 1_000),
    localReceiveOrdinal: String(ordinal),
  };
}

function market(): PublicBtcFiveMinuteMarket {
  return {
    marketId: "market-finalize-1",
    conditionId: `0x${"1".repeat(64)}`,
    slug: "btc-updown-5m-1784246400",
    intervalStart: START,
    intervalEnd: END,
    upTokenId: "111",
    downTokenId: "222",
    active: true,
    closed: false,
    acceptingOrders: true,
    collectible: true,
    takerFeeRate: "0.07",
    rawPayload: "{}",
  };
}

test("paper finalization recovers a missing wrapper result into a reportable final result", async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), "kj-paper-finalize-"));
  const journalPath = join(runDirectory, "kj-inputs.ndjson");
  const runId = "kj-paper-20260717000000-12345678";
  const plan = {
    schemaVersion: "kj-paper-mvp-v1",
    runId,
    targetMarketCount: 1,
    plannedAt: "2026-07-16T23:59:00.000Z",
    firstFullMarketStart: START,
    captureEnd: END,
    expectedFinishBy: "2026-07-17T00:15:00.000Z",
    durationSeconds: 360,
    settlementGraceSeconds: 600,
    runDirectory,
    metricsDirectory: join(runDirectory, "metrics"),
    journalPath,
    summaryPath: join(runDirectory, "runtime-summary.json"),
    runtimeStdoutPath: join(runDirectory, "runtime.ndjson"),
    runtimeStderrPath: join(runDirectory, "runtime.stderr.log"),
    resultPath: join(runDirectory, "result.json"),
    collectorGitCommit: COMMIT,
  } as const;
  const runtimeSummary = {
    type: "runtime_summary",
    runId: "runtime-finalize-test",
    mode: "paper",
    collectorGitCommit: COMMIT,
    kjMarketStartBefore: END,
    kjPaperJournalPath: journalPath,
    terminalFailure: null,
    stoppedByDuration: true,
    realOrderCount: 0,
    safety: {
      liveClientConstructed: false,
      userChannelConnected: false,
      credentialsRead: false,
      ordersSent: 0,
    },
  };
  try {
    const journal = await KJPaperJournal.open(journalPath);
    await journal.appendRunPlan({
      schemaVersion: "kj-paper-run-plan-v1",
      runId,
      targetMarketCount: 1,
      firstFullMarketStart: START,
      captureEnd: END,
      collectorGitCommit: COMMIT,
    });
    const selectedMarket = market();
    const context = createKJStrategyContext({
      decisionTime: START,
      market: selectedMarket,
      book: {
        state: "ACTIVE_UNVERIFIED",
        continuity: "UNVERIFIED",
        up: { bid: "0.79", ask: "0.8", bidSize: "100", askSize: "100" },
        down: { bid: "0.19", ask: "0.2", bidSize: "100", askSize: "100" },
        receiveStamp: stamp(1),
      },
      signal: {
        provider: "BINANCE_SPOT",
        price: "100",
        sourceTime: START,
        serverTime: null,
        receiveTime: START,
        receiveStamp: stamp(2),
        connectionId: "spot-finalize-test",
        inputHash: "2".repeat(64),
      },
    });
    if (!context.ready) throw new Error(context.reason);
    await journal.appendContext(context.context);
    const pending = buildKJPaperMvpResult({
      plan,
      resultKind: "INITIAL",
      resultPath: plan.resultPath,
      childExitedCleanly: true,
      collectorGitCommit: COMMIT,
      runtimeSummary,
      journalPath,
      journalRecordCount: journal.recordCount,
      journalLastRecordHash: journal.lastRecordHash,
      journalRunPlan: journal.runPlanEvidence,
      unsettledMarkets: journal.unsettledMarkets(),
      snapshot: journal.engine.snapshot(),
    }) as { accepted: boolean; checks: { targetMarketsSettled: boolean; noPendingMarkets: boolean } };
    assert.equal(pending.accepted, false);
    assert.equal(pending.checks.targetMarketsSettled, false);
    assert.equal(pending.checks.noPendingMarkets, false);
    await journal.appendGammaResolution({
      expectedMarket: selectedMarket,
      responseStatus: 200,
      receiveTime: "2026-07-17T00:05:53.000Z",
      rawPayload: JSON.stringify({
        id: selectedMarket.marketId,
        conditionId: selectedMarket.conditionId,
        slug: selectedMarket.slug,
        description: "This market will resolve to \"Up\" if the end price is greater than or equal to the start price. Otherwise, it will resolve to \"Down\".",
        resolutionSource: "https://data.chain.link/streams/btc-usd",
        eventStartTime: START,
        endDate: END,
        outcomes: '["Up", "Down"]',
        outcomePrices: '["1", "0"]',
        clobTokenIds: '["111", "222"]',
        enableOrderBook: true,
        active: true,
        closed: true,
        acceptingOrders: false,
        umaResolutionStatus: "resolved",
        umaEndDate: "2026-07-17T00:05:52.000Z",
      }),
    });
    const readyInput = {
      plan,
      resultKind: "RECOVERED_FINAL" as const,
      resultPath: join(runDirectory, "final-result.json"),
      childExitedCleanly: true,
      collectorGitCommit: COMMIT,
      runtimeSummary,
      journalPath,
      journalRecordCount: journal.recordCount,
      journalLastRecordHash: journal.lastRecordHash,
      journalRunPlan: journal.runPlanEvidence,
      unsettledMarkets: journal.unsettledMarkets(),
      snapshot: journal.engine.snapshot(),
    };
    assert.equal((buildKJPaperMvpResult(readyInput) as { accepted: boolean }).accepted, true);
    assert.equal((buildKJPaperMvpResult({
      ...readyInput,
      journalRunPlan: null,
    }) as { accepted: boolean }).accepted, false);
    await journal.close();

    await writeFile(join(runDirectory, "run-plan.json"), `${JSON.stringify(plan)}\n`, "utf8");
    await writeFile(join(runDirectory, "runtime-summary.json"), `${JSON.stringify(runtimeSummary)}\n`, "utf8");
    const finalizeScript = fileURLToPath(new URL("../../scripts/finalize-kj-paper-run.js", import.meta.url));
    const finalized = await execFile(process.execPath, [finalizeScript, runDirectory]);
    assert.equal(JSON.parse(finalized.stdout).accepted, true);
    const finalResult = JSON.parse(await readFile(join(runDirectory, "final-result.json"), "utf8"));
    assert.equal(finalResult.accepted, true);
    assert.equal(finalResult.resultKind, "RECOVERED_FINAL");
    assert.equal(finalResult.checks.hashChainedRunPlan, true);

    const reportScript = fileURLToPath(new URL("../../scripts/report-kj-paper-run.js", import.meta.url));
    const reportDirectory = join(runDirectory, "report");
    const reported = await execFile(process.execPath, [
      reportScript,
      runDirectory,
      "--output",
      reportDirectory,
    ]);
    assert.equal(JSON.parse(reported.stdout).accepted, true);
    const report = JSON.parse(await readFile(join(reportDirectory, "summary.json"), "utf8"));
    assert.equal(report.resultFileName, "final-result.json");
    assert.equal(report.report.run.resultKind, "RECOVERED_FINAL");

    await assert.rejects(
      execFile(process.execPath, [finalizeScript, runDirectory]),
      /EEXIST/u,
    );
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});

test("paper finalization can recover a missing wrapper result only from a clean runtime summary", async () => {
  const runDirectory = await mkdtemp(join(tmpdir(), "kj-paper-finalize-missing-result-"));
  const journalPath = join(runDirectory, "kj-inputs.ndjson");
  const runId = "kj-paper-20260717000000-87654321";
  const plan = {
    schemaVersion: "kj-paper-mvp-v1",
    runId,
    targetMarketCount: 1,
    plannedAt: "2026-07-16T23:59:00.000Z",
    firstFullMarketStart: START,
    captureEnd: END,
    expectedFinishBy: "2026-07-17T00:15:00.000Z",
    durationSeconds: 360,
    settlementGraceSeconds: 600,
    runDirectory,
    metricsDirectory: join(runDirectory, "metrics"),
    journalPath,
    summaryPath: join(runDirectory, "runtime-summary.json"),
    runtimeStdoutPath: join(runDirectory, "runtime.ndjson"),
    runtimeStderrPath: join(runDirectory, "runtime.stderr.log"),
    resultPath: join(runDirectory, "result.json"),
    collectorGitCommit: COMMIT,
  } as const;
  const runtimeSummary = {
    type: "runtime_summary",
    mode: "paper",
    collectorGitCommit: COMMIT,
    kjMarketStartBefore: END,
    kjPaperJournalPath: journalPath,
    stoppedByDuration: true,
    terminalFailure: null,
    realOrderCount: 0,
    safety: {
      liveClientConstructed: false,
      userChannelConnected: false,
      credentialsRead: false,
      ordersSent: 0,
    },
  };
  try {
    const journal = await KJPaperJournal.open(journalPath);
    await journal.appendRunPlan({
      schemaVersion: "kj-paper-run-plan-v1",
      runId,
      targetMarketCount: 1,
      firstFullMarketStart: START,
      captureEnd: END,
      collectorGitCommit: COMMIT,
    });
    await journal.close();
    await writeFile(join(runDirectory, "run-plan.json"), `${JSON.stringify(plan)}\n`, "utf8");
    await writeFile(join(runDirectory, "runtime-summary.json"), `${JSON.stringify(runtimeSummary)}\n`, "utf8");

    const finalizeScript = fileURLToPath(new URL("../../scripts/finalize-kj-paper-run.js", import.meta.url));
    await assert.rejects(execFile(process.execPath, [finalizeScript, runDirectory]));
    const finalResult = JSON.parse(await readFile(join(runDirectory, "final-result.json"), "utf8").catch(() => "null"));
    assert.equal(finalResult, null);
  } finally {
    await rm(runDirectory, { recursive: true, force: true });
  }
});
