import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { scanDatasets } from "../market-data/dataset-catalog.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const item = value as Record<string, unknown>;
  return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
}

test("dataset catalog verifies immutable outputs and returns path-free summaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "datasets-"));
  const output = '{"event":1}\n';
  const outputHash = createHash("sha256").update(output).digest("hex");
  const core = { schema_version: "normalized-dataset-manifest-v1", normalized_schema_version: "normalized-record-v1", dataset_id: "btc-five-minute", continuity: "UNVERIFIED",
    normalizer_git_commit: "abcdef0", normalizer_code_sha256: "0".repeat(64), normalizer_worktree_state: "CLEAN", config: {}, raw_inputs: [], row_counts: { event: 1 },
    quarantine_count: 0, quality_counts: {}, min_source_time: "2026-01-01T00:00:00.000Z", max_source_time: "2026-01-01T00:00:01.000Z",
    min_visible_at: "2026-01-01T00:00:00.000Z", max_visible_at: "2026-01-01T00:00:01.000Z",
    outputs: { "records.jsonl": { sha256: outputHash, byte_count: Buffer.byteLength(output), row_count: 1 } } };
  const hash = createHash("sha256").update(canonical(core)).digest("hex");
  const directory = join(root, "normalized", "dataset_id=btc-five-minute", `version=${hash}`);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "records.jsonl"), output);
  await writeFile(join(directory, "manifest.json"), `${canonical({ ...core, dataset_hash: hash })}\n`);
  const datasets = await scanDatasets(root);
  assert.equal(datasets.length, 1); assert.equal(datasets[0]?.rowCount, 1);
  assert.equal(JSON.stringify(datasets).includes(root), false);
});

test("dataset catalog hides tampered publications and rejects a symlinked normalized root", async () => {
  const root = await mkdtemp(join(tmpdir(), "datasets-"));
  const directory = join(root, "normalized", "dataset_id=bad", "version=bad");
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, "manifest.json"), "{}\n");
  assert.deepEqual(await scanDatasets(root), []);
  const linkedRoot = await mkdtemp(join(tmpdir(), "datasets-link-"));
  await symlink(join(root, "normalized"), join(linkedRoot, "normalized"));
  await assert.rejects(scanDatasets(linkedRoot), /real directory/u);
});
