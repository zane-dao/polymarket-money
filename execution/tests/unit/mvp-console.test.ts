import assert from "node:assert/strict";
import { test } from "node:test";
import { createMvpConsoleSnapshot, listMvpPaperSummaries, listMvpResultSummaries } from "../../../scripts/mvp-console.js";

test("MVP console exposes explicit paper-only commands", () => {
  const snapshot = createMvpConsoleSnapshot("/tmp/polymarket-money-console-test");
  assert.equal(snapshot.liveTradingEnabled, false);
  assert.equal(snapshot.datasetAvailable, false);
  assert.match(snapshot.commands["L V2 historical replay"]!, /v2-midrange-train-selected/);
  assert.match(snapshot.commands["Bounded K\/J realtime paper"]!, /paper:mvp/);
  assert.doesNotMatch(JSON.stringify(snapshot.commands), /private key|submit.*order/i);
});

test("MVP result listing is empty when no locally published run exists", () => {
  assert.deepEqual(listMvpResultSummaries("/tmp/polymarket-money-console-test"), []);
  assert.deepEqual(listMvpPaperSummaries("/tmp/polymarket-money-console-test"), []);
});
