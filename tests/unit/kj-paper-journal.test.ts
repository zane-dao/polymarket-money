import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import type { PublicBtcFiveMinuteMarket } from "../../execution/src/adapters/market-data/public-sources.js";
import type { GammaResolutionInput } from "../../execution/src/adapters/settlement/gamma-resolution.js";
import type { ReceiveStamp } from "../../execution/src/domain/receive-time.js";
import { KJPaperJournal } from "../../execution/src/storage/kj-paper-journal.js";
import { createKJStrategyContext, type KJStrategyContextV1 } from "../../execution/src/strategy/kj-context.js";

const START = Date.parse("2026-07-17T00:00:00.000Z");
const execFile = promisify(execFileCallback);

function iso(offsetSeconds: number): string {
  return new Date(START + offsetSeconds * 1_000).toISOString();
}

function market(index = 1): PublicBtcFiveMinuteMarket {
  const start = START + (index - 1) * 300_000;
  return {
    marketId: `market-${index}`,
    conditionId: `0x${String(index).repeat(64)}`,
    slug: `btc-updown-5m-${Math.floor(start / 1_000)}`,
    intervalStart: new Date(start).toISOString(),
    intervalEnd: new Date(start + 300_000).toISOString(),
    upTokenId: `${index}11`,
    downTokenId: `${index}22`,
    active: true,
    closed: false,
    acceptingOrders: true,
    collectible: true,
    takerFeeRate: "0.07",
    rawPayload: "{}",
  };
}

function stamp(at: string, ordinal: number): ReceiveStamp {
  return {
    schemaVersion: "receive-stamp-v1",
    clockDomain: "journal-runtime-1",
    localWallReceiveTime: at,
    localMonotonicReceiveNs: String(ordinal * 1_000),
    localReceiveOrdinal: String(ordinal),
  };
}

function context(
  offsetSeconds: number,
  price: string,
  ordinal: number,
  selectedMarket = market(1),
): KJStrategyContextV1 {
  const decisionTime = iso(offsetSeconds);
  const result = createKJStrategyContext({
    decisionTime,
    market: selectedMarket,
    book: {
      state: "ACTIVE_UNVERIFIED",
      continuity: "UNVERIFIED",
      up: { bid: "0.79", ask: "0.8", bidSize: "1000", askSize: "1000" },
      down: { bid: "0.19", ask: "0.2", bidSize: "1000", askSize: "1000" },
      receiveStamp: stamp(decisionTime, ordinal * 2 - 1),
    },
    signal: {
      provider: "BINANCE_SPOT",
      price,
      sourceTime: decisionTime,
      serverTime: null,
      receiveTime: decisionTime,
      receiveStamp: stamp(decisionTime, ordinal * 2),
      connectionId: "spot-1",
      inputHash: ordinal.toString(16).padStart(64, "0"),
    },
  });
  if (!result.ready) throw new Error(result.reason);
  return result.context;
}

function inputSeries(): readonly KJStrategyContextV1[] {
  const values: KJStrategyContextV1[] = [context(0, "100", 1)];
  let ordinal = 2;
  for (let offset = 5; offset < 180; offset += 5, ordinal += 1) {
    values.push(context(offset, offset % 10 === 0 ? "100.1" : "99.9", ordinal));
  }
  values.push(context(185, "110", 40));
  values.push(context(186, "110", 41));
  values.push(context(300, "110", 42, market(2)));
  return values;
}

function gammaResolution(): GammaResolutionInput {
  const expected = market(1);
  return {
    expectedMarket: expected,
    responseStatus: 200,
    receiveTime: iso(360),
    rawPayload: JSON.stringify({
      id: expected.marketId,
      conditionId: expected.conditionId,
      slug: expected.slug,
      description: "This market will resolve to \"Up\" if the end price is greater than or equal to the start price. Otherwise, it will resolve to \"Down\".",
      resolutionSource: "https://data.chain.link/streams/btc-usd",
      eventStartTime: expected.intervalStart,
      endDate: expected.intervalEnd,
      outcomes: '["Up", "Down"]',
      outcomePrices: '["1", "0"]',
      clobTokenIds: JSON.stringify([expected.upTokenId, expected.downTokenId]),
      enableOrderBook: true,
      active: true,
      closed: true,
      acceptingOrders: false,
      umaResolutionStatus: "resolved",
      umaEndDate: iso(352),
    }),
  };
}

const RUN_PLAN = Object.freeze({
  schemaVersion: "kj-paper-run-plan-v1" as const,
  runId: "kj-paper-20260717000000-12345678",
  targetMarketCount: 1,
  firstFullMarketStart: iso(0),
  captureEnd: iso(300),
  collectorGitCommit: "a".repeat(40),
});

test("K/J journal hash-binds the MVP run plan before market contexts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kj-paper-journal-plan-"));
  const path = join(directory, "paper-inputs.ndjson");
  try {
    const journal = await KJPaperJournal.open(path);
    assert.equal((await journal.appendRunPlan(RUN_PLAN)).appended, true);
    assert.equal((await journal.appendRunPlan(RUN_PLAN)).appended, false);
    await assert.rejects(
      journal.appendRunPlan({ ...RUN_PLAN, targetMarketCount: 2 }),
      /conflicts with its hash-chained plan/u,
    );
    await journal.appendContext(context(0, "100", 1));
    assert.deepEqual(journal.runPlanEvidence, RUN_PLAN);
    await journal.close();

    const recovered = await KJPaperJournal.open(path);
    assert.deepEqual(recovered.runPlanEvidence, RUN_PLAN);
    assert.equal(recovered.recoveredInputCount, 2);
    await recovered.close();

    const legacyPath = join(directory, "legacy.ndjson");
    const legacy = await KJPaperJournal.open(legacyPath);
    await legacy.appendContext(context(0, "100", 1));
    await assert.rejects(
      legacy.appendRunPlan(RUN_PLAN),
      /before every context/u,
    );
    await legacy.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("K/J journal preserves the campaign-bound v2 run plan across recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kj-paper-journal-campaign-"));
  const path = join(directory, "paper-inputs.ndjson");
  const campaignPlan = Object.freeze({
    ...RUN_PLAN, schemaVersion: "kj-paper-run-plan-v2" as const,
    campaignId: "campaign-test", campaignHash: "b".repeat(64), campaignRunIndex: 1,
  });
  try {
    const journal = await KJPaperJournal.open(path);
    await journal.appendRunPlan(campaignPlan);
    await journal.close();
    const recovered = await KJPaperJournal.open(path);
    assert.deepEqual(recovered.runPlanEvidence, campaignPlan);
    await recovered.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("K/J journal durably replays contexts, fills, wallets, and official settlement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kj-paper-journal-replay-"));
  const path = join(directory, "paper-inputs.ndjson");
  try {
    const journal = await KJPaperJournal.open(path);
    assert.equal(journal.recordCount, 1);
    assert.equal(journal.recoveredInputCount, 0);
    const inputs = inputSeries();
    for (const value of inputs) assert.equal((await journal.appendContext(value)).appended, true);
    assert.equal((await journal.appendContext(inputs[0]!)).appended, false);
    await journal.appendGammaResolution(gammaResolution());

    const events = journal.engine.events();
    const state = journal.engine.snapshot();
    const jWallet = journal.engine.wallet("J_FEE_AWARE");
    const kWallet = journal.engine.wallet("K_DUAL_VOL");
    assert.equal(journal.engine.state("market-1"), "DONE");
    assert.equal(journal.engine.position("J_FEE_AWARE", "111"), "0");
    const expectedRecordCount = 1 + inputs.length + 1;
    assert.equal(journal.recordCount, expectedRecordCount);
    const lastHash = journal.lastRecordHash;
    await journal.close();

    const recovered = await KJPaperJournal.open(path);
    assert.equal(recovered.recordCount, expectedRecordCount);
    assert.equal(recovered.recoveredInputCount, inputs.length + 1);
    assert.equal(recovered.lastRecordHash, lastHash);
    assert.deepEqual(recovered.engine.events(), events);
    assert.deepEqual(recovered.engine.snapshot(), state);
    assert.deepEqual(recovered.engine.wallet("J_FEE_AWARE"), jWallet);
    assert.deepEqual(recovered.engine.wallet("K_DUAL_VOL"), kWallet);
    assert.equal(recovered.engine.state("market-1"), "DONE");
    assert.equal((await recovered.appendGammaResolution(gammaResolution())).appended, false);
    await recovered.close();

    const inspectionScript = fileURLToPath(new URL(
      "../../scripts/inspect-kj-paper-journal.js",
      import.meta.url,
    ));
    const { stdout } = await execFile(process.execPath, [inspectionScript, path]);
    const inspection = JSON.parse(stdout) as {
      journalRecordCount: string;
      state: { eventCount: string; markets: readonly { state: string }[] };
    };
    assert.equal(inspection.journalRecordCount, String(expectedRecordCount));
    assert.equal(inspection.state.eventCount, String(events.length));
    assert.equal(inspection.state.markets[0]?.state, "DONE");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("K/J journal rejects conflicts before append and hash tampering during recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kj-paper-journal-tamper-"));
  const path = join(directory, "paper-inputs.ndjson");
  try {
    const journal = await KJPaperJournal.open(path);
    const original = context(0, "100", 1);
    await journal.appendContext(original);
    const conflict = {
      ...original,
      book: { ...original.book, up: { ...original.book.up, ask: "0.81" } },
    };
    await assert.rejects(
      journal.appendContext(conflict),
      /context identity has conflicting content/u,
    );
    assert.equal(journal.recordCount, 2);

    const later = context(5, "101", 2);
    const signalConflict = {
      ...later,
      inputWatermark: later.book.receiveStamp,
      signal: {
        ...original.signal,
        price: "101",
      },
    };
    await assert.rejects(
      journal.appendContext(signalConflict),
      /signal identity has conflicting content/u,
    );
    const changedMarket = context(5, "101", 2, {
      ...market(1),
      slug: "btc-updown-5m-conflicting",
    });
    await assert.rejects(
      journal.appendContext(changedMarket),
      /market identity has conflicting content/u,
    );
    assert.equal(journal.recordCount, 2);
    await journal.close();

    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    const tampered = JSON.parse(lines[1]!) as { payload: { signal: { price: string } } };
    tampered.payload.signal.price = "101";
    lines[1] = JSON.stringify(tampered);
    await writeFile(path, `${lines.join("\n")}\n`, { encoding: "utf8" });
    await assert.rejects(KJPaperJournal.open(path), /record hash mismatch/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("K/J journal fails closed on incomplete tail, symlink paths, and repository paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kj-paper-journal-boundary-"));
  const path = join(directory, "paper-inputs.ndjson");
  try {
    const journal = await KJPaperJournal.open(path);
    await journal.appendContext(context(0, "100", 1));
    await journal.close();
    await appendFile(path, "{\"partial\":", "utf8");
    await assert.rejects(KJPaperJournal.open(path), /incomplete trailing record/u);

    const outside = await mkdtemp(join(tmpdir(), "kj-paper-journal-outside-"));
    const linked = join(directory, "linked");
    await symlink(outside, linked, "dir");
    await assert.rejects(
      KJPaperJournal.open(join(linked, "escape.ndjson")),
      /symlink directory is forbidden|path component is unsafe/u,
    );
    await rm(outside, { recursive: true, force: true });

    await assert.rejects(
      KJPaperJournal.open("/root/projects/polymarket-money/data/forbidden-kj-journal.ndjson"),
      /must remain outside the Git repository/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("K/J journal heals a durable record ahead of checkpoint but rejects tail truncation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kj-paper-journal-checkpoint-"));
  const path = join(directory, "paper-inputs.ndjson");
  const checkpoint = `${path}.checkpoint.json`;
  try {
    const journal = await KJPaperJournal.open(path);
    const headerCheckpoint = await readFile(checkpoint, "utf8");
    await journal.appendContext(context(0, "100", 1));
    await journal.close();

    await writeFile(checkpoint, headerCheckpoint, "utf8");
    const healed = await KJPaperJournal.open(path);
    assert.equal(healed.recoveredInputCount, 1);
    await healed.close();
    const healedCheckpoint = JSON.parse(await readFile(checkpoint, "utf8")) as {
      recordCount: string;
    };
    assert.equal(healedCheckpoint.recordCount, "2");

    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    await writeFile(path, `${lines[0]}\n`, "utf8");
    await assert.rejects(
      KJPaperJournal.open(path),
      /truncated behind its checkpoint/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
