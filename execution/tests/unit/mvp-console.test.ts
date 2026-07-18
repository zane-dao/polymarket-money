import assert from "node:assert/strict";
import { test } from "node:test";
import { commandForHistoricalRun, createMvpConsoleSnapshot, listMvpPaperSummaries, listMvpResultSummaries } from "../../../scripts/mvp-console.js";

test("MVP console exposes explicit paper-only commands", () => {
  const snapshot = createMvpConsoleSnapshot("/tmp/polymarket-money-console-test");
  assert.equal(snapshot.liveTradingEnabled, false);
  assert.equal(snapshot.datasetAvailable, false);
  assert.match(snapshot.commands["L V2 train-selected VALIDATION research"]!, /v2-midrange-train-selected/);
  assert.match(snapshot.commands["Bounded K\/J realtime paper"]!, /paper:mvp/);
  assert.doesNotMatch(JSON.stringify(snapshot.commands), /private key|submit.*order/i);
});

test("displayed historical command and executable argument list share one fixed definition", () => {
  const output = "/tmp/mvp-runs/l-v2-validation";
  const command = commandForHistoricalRun("/tmp", "l-v2", output);
  assert.deepEqual(command.slice(-6), ["--candidate", "v2-midrange-train-selected", "--split", "VALIDATION", "--output", output]);
  assert.match(createMvpConsoleSnapshot("/tmp").commands["L V2 train-selected VALIDATION research"]!, /--split VALIDATION/);
});

test("MVP result listing is empty when no locally published run exists", () => {
  assert.deepEqual(listMvpResultSummaries("/tmp/polymarket-money-console-test"), []);
  assert.deepEqual(listMvpPaperSummaries("/tmp/polymarket-money-console-test"), []);
});
