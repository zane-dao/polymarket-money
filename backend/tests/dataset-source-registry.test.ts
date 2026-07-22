import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { DatasetApplicationService } from "../dataset-api/index.js";

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const item = value as Record<string, unknown>;
  return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
}

async function publicationRoot(base: string, datasetId = "external-btc"): Promise<Readonly<{ root: string; hash: string }>> {
  const output = `${JSON.stringify({ event: "book", time: "2026-01-01T00:00:00Z" })}\n`;
  const evidence = { byte_count: Buffer.byteLength(output), row_count: 1, sha256: createHash("sha256").update(output).digest("hex") };
  const core = { schema_version: "normalized-dataset-manifest-v1", normalized_schema_version: "normalized-record-v1", dataset_id: datasetId, continuity: "UNVERIFIED", min_source_time: "2026-01-01T00:00:00Z", max_source_time: "2026-01-01T00:00:00Z", quarantine_count: 0, outputs: { "events.jsonl": evidence } };
  const hash = createHash("sha256").update(canonical(core)).digest("hex");
  const root = join(base, "normalized"); const version = join(root, `dataset_id=${datasetId}`, `version=${hash}`);
  await mkdir(version, { recursive: true }); await writeFile(join(version, "events.jsonl"), output); await writeFile(join(version, "manifest.json"), `${canonical({ ...core, dataset_hash: hash })}\n`);
  return { root, hash };
}

test("an external normalized root is registered persistently and scanned without exposing its path", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "dataset-registry-data-")); const sourceBase = await mkdtemp(join(tmpdir(), "dataset-registry-source-"));
  const source = await publicationRoot(sourceBase); const now = "2026-07-22T00:00:00Z";
  const first = new DatasetApplicationService(dataRoot, { repositoryRoot: resolve("."), clock: () => now });
  const registered = await first.registerSource({ schemaVersion: "dataset-source-registration-request-v1", sourceDirectory: source.root });
  assert.equal(registered.datasetCount, 1); assert.equal(registered.rawDataPolicy, "read-only-not-copied"); assert.equal(JSON.stringify(registered).includes(source.root), false);
  const registry = await readFile(join(dataRoot, "workbench", "dataset-sources", `${registered.sourceId}.json`), "utf8"); assert.equal(registry.includes(source.root), true);
  const restored = new DatasetApplicationService(dataRoot, { repositoryRoot: resolve("."), clock: () => now }); const scan = await restored.scan();
  assert.equal(scan.datasets[0]?.datasetId, "external-btc"); assert.equal(scan.datasets[0]?.versionHash, source.hash); assert.equal(JSON.stringify(scan).includes(source.root), false);
  const execution = await restored.resolveForExecution({ schemaVersion: "dataset-selection-request-v1", datasetId: "external-btc", versionHash: source.hash }); assert.equal(execution.publicationDirectory.startsWith(source.root), true);
  await assert.rejects(restored.resolveForExecution({ schemaVersion: "dataset-selection-request-v1", datasetId: "external-btc", versionHash: "f".repeat(64) }), /not available/u);
  await assert.rejects(readFile(join(dataRoot, "normalized", "dataset_id=external-btc", `version=${source.hash}`, "manifest.json")), /ENOENT/u);
});

test("dataset source registration rejects relative, repository, symlink, file and unknown-layout inputs", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "dataset-registry-reject-")); const external = await mkdtemp(join(tmpdir(), "dataset-registry-layout-"));
  const service = new DatasetApplicationService(dataRoot, { repositoryRoot: resolve(".") });
  await assert.rejects(service.registerSource({ schemaVersion: "dataset-source-registration-request-v1", sourceDirectory: "relative/normalized" }), /absolute/u);
  await assert.rejects(service.registerSource({ schemaVersion: "dataset-source-registration-request-v1", sourceDirectory: resolve("backend") }), /outside the repository/u);
  const file = join(external, "file"); await writeFile(file, "x"); await assert.rejects(service.registerSource({ schemaVersion: "dataset-source-registration-request-v1", sourceDirectory: file }), /real directory/u);
  const unknown = join(external, "unknown"); await mkdir(unknown); await writeFile(join(unknown, "notes.txt"), "not a publication"); await assert.rejects(service.registerSource({ schemaVersion: "dataset-source-registration-request-v1", sourceDirectory: unknown }), /unknown normalized publication layout/u);
  const source = await publicationRoot(external, "symlink-btc"); const link = join(external, "normalized-link"); await symlink(source.root, link, "dir"); await assert.rejects(service.registerSource({ schemaVersion: "dataset-source-registration-request-v1", sourceDirectory: link }), /symbolic links/u);
  const linkedOutputRoot = join(external, "linked-output"); const linkedOutput = "{}\n"; const target = join(external, "outside-events.jsonl"); await writeFile(target, linkedOutput); const evidence = { byte_count: Buffer.byteLength(linkedOutput), row_count: 1, sha256: createHash("sha256").update(linkedOutput).digest("hex") }; const core = { schema_version: "normalized-dataset-manifest-v1", normalized_schema_version: "normalized-record-v1", dataset_id: "linked-output", continuity: "UNVERIFIED", min_source_time: "2026-01-01T00:00:00Z", max_source_time: "2026-01-01T00:00:00Z", quarantine_count: 0, outputs: { "events.jsonl": evidence } }; const hash = createHash("sha256").update(canonical(core)).digest("hex"); const version = join(linkedOutputRoot, "dataset_id=linked-output", `version=${hash}`); await mkdir(version, { recursive: true }); await symlink(target, join(version, "events.jsonl")); await writeFile(join(version, "manifest.json"), `${canonical({ ...core, dataset_hash: hash })}\n`); await assert.rejects(service.registerSource({ schemaVersion: "dataset-source-registration-request-v1", sourceDirectory: linkedOutputRoot }), /no verified dataset publication/u);
});
