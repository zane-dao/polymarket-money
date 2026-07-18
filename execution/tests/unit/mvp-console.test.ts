import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("MVP console exposes only historical summaries whose Python-contract hash verifies", async () => {
  const root = await mkdtemp(join(tmpdir(), "mvp-console-result-"));
  const published = join(root, "mvp-runs", "verified");
  const core = { split: "VALIDATION", scenario: "BASE_1S", runs: { L: { net_pnl: "1", filled_count: 1 } } };
  const canonical = '{"runs":{"L":{"filled_count":1,"net_pnl":"1"}},"scenario":"BASE_1S","split":"VALIDATION"}';
  const result_hash = createHash("sha256").update(canonical, "utf8").digest("hex");
  try {
    await mkdir(published, { recursive: true });
    await writeFile(join(published, "summary.json"), `${JSON.stringify({ ...core, result_hash })}\n`);
    assert.deepEqual(listMvpResultSummaries(root).map((result) => result.summaryIntegrity), ["VERIFIED"]);
    await writeFile(join(published, "summary.json"), `${JSON.stringify({ ...core, result_hash: "0".repeat(64) })}\n`);
    assert.deepEqual(listMvpResultSummaries(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
