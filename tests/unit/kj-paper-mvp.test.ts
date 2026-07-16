import assert from "node:assert/strict";
import test from "node:test";

import {
  KJ_MARKET_INTERVAL_MILLISECONDS,
  planKJPaperMvp,
} from "../../execution/src/product/kj-paper-mvp.js";

test("MVP plans the next complete market and keeps every artifact outside Git", () => {
  const now = Date.parse("2026-07-17T12:03:12.345Z");
  const plan = planKJPaperMvp({
    nowMilliseconds: now,
    marketCount: 2,
    settlementGraceSeconds: 90,
    outputRoot: "/root/polymarket-money-data/paper-mvp",
    repositoryRoot: "/root/projects/polymarket-money",
    runId: "kj-paper-20260717120312-12345678",
  });
  assert.equal(plan.firstFullMarketStart, "2026-07-17T12:05:00.000Z");
  assert.equal(plan.captureEnd, "2026-07-17T12:15:00.000Z");
  assert.equal(plan.expectedFinishBy, "2026-07-17T12:16:30.000Z");
  assert.equal(plan.durationSeconds, Math.ceil((
    Date.parse(plan.captureEnd) - now
  ) / 1_000));
  assert.equal(Date.parse(plan.captureEnd) - Date.parse(plan.firstFullMarketStart),
    2 * KJ_MARKET_INTERVAL_MILLISECONDS);
  assert.match(plan.journalPath, /^\/root\/polymarket-money-data\/paper-mvp\//u);
});

test("MVP rejects unsafe roots and unbounded sessions", () => {
  const base = {
    nowMilliseconds: 0,
    marketCount: 1,
    settlementGraceSeconds: 90,
    outputRoot: "/root/projects/polymarket-money/artifacts",
    repositoryRoot: "/root/projects/polymarket-money",
    runId: "kj-paper-19700101000000-12345678",
  } as const;
  assert.throws(() => planKJPaperMvp(base), /outside the Git repository/u);
  assert.throws(() => planKJPaperMvp({ ...base, outputRoot: "/tmp/mvp", marketCount: 13 }), /1 through 12/u);
  assert.throws(() => planKJPaperMvp({
    ...base,
    outputRoot: "/tmp/mvp",
    settlementGraceSeconds: 1_801,
  }), /1 through 1800/u);
});
