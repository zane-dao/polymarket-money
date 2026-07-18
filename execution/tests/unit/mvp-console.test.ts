import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commandForHistoricalRun, createMvpConsoleSnapshot, listMvpPaperSummaries, listMvpResultSummaries } from "../../../scripts/mvp-console.js";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

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

test("MVP console distinguishes legacy summaries from complete manifest-verified publications", async () => {
  const root = await mkdtemp(join(tmpdir(), "mvp-console-result-"));
  const published = join(root, "mvp-runs", "verified");
  const core = { split: "VALIDATION", scenario: "BASE_1S", runs: { L: { net_pnl: "1", filled_count: 1 } } };
  const canonical = '{"runs":{"L":{"filled_count":1,"net_pnl":"1"}},"scenario":"BASE_1S","split":"VALIDATION"}';
  const result_hash = createHash("sha256").update(canonical, "utf8").digest("hex");
  try {
    await mkdir(published, { recursive: true });
    await writeFile(join(published, "summary.json"), `${JSON.stringify({ ...core, result_hash })}\n`);
    assert.deepEqual(listMvpResultSummaries(root).map((result) => result.summaryIntegrity), ["LEGACY_SUMMARY_VERIFIED"]);
    const events = "{\"event\":1}\n";
    const trades = "trade\n";
    await writeFile(join(published, "events.ndjson"), events);
    await writeFile(join(published, "trades.csv"), trades);
    await writeFile(join(published, "publication-intent.json"), JSON.stringify({ schema_version: "kj-historical-paper-publication-v1", result_hash }));
    const file = (name: string, value: string) => ({ bytes: Buffer.byteLength(value), sha256: createHash("sha256").update(value, "utf8").digest("hex") });
    const publicationCore = {
      schema_version: "kj-historical-paper-publication-v1",
      result_hash,
      files: {
        "summary.json": file("summary.json", JSON.stringify({ ...core, result_hash }) + "\n"),
        "events.ndjson": file("events.ndjson", events),
        "trades.csv": file("trades.csv", trades),
      },
    };
    const publication = { ...publicationCore, publication_hash: createHash("sha256").update(canonicalJson(publicationCore), "utf8").digest("hex") };
    await writeFile(join(published, "publication.json"), JSON.stringify(publication));
    assert.deepEqual(listMvpResultSummaries(root).map((result) => result.summaryIntegrity), ["COMPLETE_PUBLICATION_VERIFIED"]);
    await writeFile(join(published, "events.ndjson"), "tampered\n");
    assert.deepEqual(listMvpResultSummaries(root), []);
    await writeFile(join(published, "summary.json"), `${JSON.stringify({ ...core, result_hash: "0".repeat(64) })}\n`);
    assert.deepEqual(listMvpResultSummaries(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
