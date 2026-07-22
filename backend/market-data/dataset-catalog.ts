import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/u;

export type DatasetSummaryV1 = Readonly<{
  schemaVersion: "dataset-summary-v1";
  datasetId: string;
  versionHash: string;
  format: "normalized-events-v1" | "external-historical-v1";
  continuity: "UNVERIFIED";
  startTimeUtc: string | null;
  endTimeUtc: string | null;
  rowCount: number;
  quarantineCount: number;
  status: "available";
}>;

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
  }
  throw new Error("manifest contains a non-JSON value");
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("manifest must be an object");
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${field} must be a string`);
  return value;
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${field} must be a non-negative integer`);
  return value as number;
}

async function digest(path: string, expectedBytes: number): Promise<string> {
  if (expectedBytes > MAX_OUTPUT_BYTES) throw new Error("dataset output exceeds scan limit");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== expectedBytes) throw new Error("dataset output size mismatch");
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function verifyOutputs(directory: string, outputs: Record<string, unknown>, byteField: "byte_count" | "bytes", rowField: "row_count" | "rows"): Promise<number> {
  let rows = 0;
  for (const [name, raw] of Object.entries(outputs)) {
    if (name.includes("/") || name.includes("\\") || name === "." || name === "..") throw new Error("unsafe output name");
    const evidence = object(raw);
    const bytes = integer(evidence[byteField], `${name}.${byteField}`);
    const count = integer(evidence[rowField], `${name}.${rowField}`);
    const expected = text(evidence.sha256, `${name}.sha256`);
    if (!HASH.test(expected) || await digest(join(directory, name), bytes) !== expected) throw new Error("dataset output hash mismatch");
    rows += count;
  }
  return rows;
}

async function verifyManifest(path: string): Promise<DatasetSummaryV1> {
  const link = await lstat(path);
  if (!link.isFile() || link.isSymbolicLink() || link.size > MAX_MANIFEST_BYTES) throw new Error("unsafe manifest");
  const bytes = await readFile(path);
  const manifest = object(JSON.parse(bytes.toString("utf8")) as unknown);
  const versionHash = text(manifest.dataset_hash, "dataset_hash");
  if (!HASH.test(versionHash)) throw new Error("dataset_hash is invalid");
  const core = { ...manifest }; delete core.dataset_hash;
  if (createHash("sha256").update(canonical(core)).digest("hex") !== versionHash) throw new Error("dataset manifest hash mismatch");
  const directory = resolve(path, "..");
  const outputs = object(manifest.outputs);
  const schema = manifest.schema_version;
  if (schema === "normalized-dataset-manifest-v1") {
    const rowCount = await verifyOutputs(directory, outputs, "byte_count", "row_count");
    return Object.freeze({ schemaVersion: "dataset-summary-v1", datasetId: text(manifest.dataset_id, "dataset_id"), versionHash,
      format: "normalized-events-v1", continuity: "UNVERIFIED", startTimeUtc: typeof manifest.min_source_time === "string" ? manifest.min_source_time : null,
      endTimeUtc: typeof manifest.max_source_time === "string" ? manifest.max_source_time : null, rowCount,
      quarantineCount: integer(manifest.quarantine_count, "quarantine_count"), status: "available" });
  }
  if (schema === "external-historical-normalized-v1") {
    const rowCount = await verifyOutputs(directory, outputs, "bytes", "rows");
    const window = object(manifest.study_window);
    return Object.freeze({ schemaVersion: "dataset-summary-v1", datasetId: text(manifest.dataset_id, "dataset_id"), versionHash,
      format: "external-historical-v1", continuity: "UNVERIFIED", startTimeUtc: text(window.start, "study_window.start"),
      endTimeUtc: text(window.end_exclusive, "study_window.end_exclusive"), rowCount, quarantineCount: 0, status: "available" });
  }
  throw new Error("unsupported dataset manifest");
}

/** Scans only immutable normalized publication locations; raw inputs remain untouched. */
export async function scanDatasetPublicationRoots(normalizedRoots: readonly string[]): Promise<readonly DatasetSummaryV1[]> {
  const manifests: string[] = [];
  for (const root of normalizedRoots) {
    if (!isAbsolute(root)) throw new Error("normalized publication root must be absolute");
    const normalized = resolve(root);
    const rootInfo = await lstat(normalized).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (rootInfo === null) continue;
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("normalized root must be a real directory");
    for (const dataset of await readdir(normalized, { withFileTypes: true })) {
      if (!dataset.isDirectory() || dataset.isSymbolicLink() || !dataset.name.startsWith("dataset_id=")) continue;
      const datasetDirectory = join(normalized, dataset.name);
      for (const version of await readdir(datasetDirectory, { withFileTypes: true })) {
        if (!version.isDirectory() || version.isSymbolicLink() || !version.name.startsWith("version=")) continue;
        const path = join(datasetDirectory, version.name, "manifest.json");
        if (!relative(normalized, path).startsWith("..")) manifests.push(path);
        if (manifests.length > 1024) throw new Error("dataset scan limit exceeded");
      }
    }
  }
  const datasets: DatasetSummaryV1[] = [];
  for (const path of manifests.sort()) {
    try { datasets.push(await verifyManifest(path)); } catch { /* Invalid/incomplete publications are unavailable, never partially surfaced. */ }
  }
  return Object.freeze(datasets.sort((a, b) => a.datasetId.localeCompare(b.datasetId) || a.versionHash.localeCompare(b.versionHash)));
}

/** Scans the two project-owned immutable publication roots. */
export async function scanDatasets(dataRoot: string): Promise<readonly DatasetSummaryV1[]> {
  if (!isAbsolute(dataRoot)) throw new Error("dataRoot must be absolute");
  return scanDatasetPublicationRoots([resolve(dataRoot, "normalized"), resolve(dataRoot, "external-research", "normalized")]);
}
