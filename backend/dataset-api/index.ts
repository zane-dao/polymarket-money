import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { scanDatasetPublicationRoots, scanDatasets, type DatasetSummaryV1 } from "../market-data/dataset-catalog.js";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const MAX_DATASETS = 1024;

export type DatasetListItemV1 = Readonly<{
  schemaVersion: "dataset-list-item-v2";
  datasetId: string;
  versionHash: string;
  format: "normalized-events-v1" | "external-historical-v1";
  continuity: "UNVERIFIED";
  startTimeUtc: string | null;
  endTimeUtc: string | null;
  rowCount: number;
  quarantineCount: number;
  status: "available";
  displayName: string;
  description: string;
  publishedAtUtc: string | null;
  source: string;
  tags: readonly string[];
  management: "managed" | "read-only";
}>;

export type DatasetDetailV1 = Readonly<Omit<DatasetListItemV1, "schemaVersion"> & {
  schemaVersion: "dataset-detail-v2";
  selectionReady: true;
  rawDataPolicy: "read-only-not-copied";
}>;

export type DatasetScanV1 = Readonly<{
  schemaVersion: "dataset-scan-v2";
  scannedAtUtc: string;
  datasetCount: number;
  datasets: readonly DatasetListItemV1[];
}>;

export type DatasetListV1 = Readonly<{
  schemaVersion: "dataset-list-v2";
  scannedAtUtc: string;
  datasets: readonly DatasetListItemV1[];
}>;

export type DatasetSelectionRequestV1 = Readonly<{
  schemaVersion: "dataset-selection-request-v1";
  datasetId: string;
  versionHash: string;
}>;

export type ValidatedDatasetSelectionV1 = Readonly<{
  schemaVersion: "validated-dataset-selection-v1";
  datasetId: string;
  versionHash: string;
  validatedAtUtc: string;
}>;

/** Backend-only execution capability. Never return this object through UI commands. */
export type ResolvedDatasetExecutionV1 = Readonly<{
  datasetId: string;
  versionHash: string;
  publicationDirectory: string;
}>;

export type DatasetSourceRegistrationRequestV1 = Readonly<{
  schemaVersion: "dataset-source-registration-request-v1";
  sourceDirectory: string;
}>;

export type RegisteredDatasetSourceV1 = Readonly<{
  schemaVersion: "registered-dataset-source-v1";
  sourceId: string;
  registeredAtUtc: string;
  datasetCount: number;
  rawDataPolicy: "read-only-not-copied";
}>;

type DatasetScanner = (dataRoot: string) => Promise<readonly DatasetSummaryV1[]>;
type Clock = () => string;
type PersistedSourceV1 = Readonly<{ schemaVersion: "persisted-dataset-source-v1"; sourceId: string; sourceDirectory: string; registeredAtUtc: string }>;

function validateUtc(name: string, value: string): void {
  if (!UTC_ISO.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${name} is invalid`);
}

function validateIdentity(datasetId: string, versionHash: string): void {
  if (!SAFE_ID.test(datasetId)) throw new Error("datasetId is invalid");
  if (!HASH.test(versionHash)) throw new Error("versionHash is invalid");
}

function isInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function validatePublicationRoot(sourceDirectory: string, repositoryRoot: string): Promise<string> {
  if (!isAbsolute(sourceDirectory)) throw new Error("sourceDirectory must be absolute");
  const requested = resolve(sourceDirectory);
  const canonical = await realpath(requested).catch(() => { throw new Error("sourceDirectory does not exist"); });
  if (canonical !== requested) throw new Error("sourceDirectory must not contain symbolic links");
  const info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("sourceDirectory must be a real directory");
  const canonicalRepository = await realpath(repositoryRoot);
  if (isInside(canonicalRepository, canonical)) throw new Error("sourceDirectory must be outside the repository");
  const datasets = await readdir(canonical, { withFileTypes: true });
  if (datasets.length === 0 || datasets.some((entry) => !entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith("dataset_id="))) throw new Error("sourceDirectory has an unknown normalized publication layout");
  for (const dataset of datasets) {
    const versions = await readdir(join(canonical, dataset.name), { withFileTypes: true });
    if (versions.length === 0 || versions.some((entry) => !entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith("version="))) throw new Error("sourceDirectory has an unknown normalized publication layout");
    for (const version of versions) {
      const manifest = await lstat(join(canonical, dataset.name, version.name, "manifest.json")).catch(() => null);
      if (manifest === null || !manifest.isFile() || manifest.isSymbolicLink()) throw new Error("sourceDirectory contains an incomplete normalized publication");
    }
  }
  return canonical;
}

/** Backend-only registry. Persisted paths never cross the command DTO boundary. */
export class FileDatasetSourceRegistry {
  readonly #root: string;
  readonly #repositoryRoot: string;
  readonly #clock: Clock;

  constructor(dataRoot: string, repositoryRoot: string, clock: Clock = () => new Date().toISOString()) {
    if (!isAbsolute(dataRoot) || !isAbsolute(repositoryRoot)) throw new Error("dataset source registry roots must be absolute");
    this.#root = resolve(dataRoot, "workbench", "dataset-sources");
    this.#repositoryRoot = resolve(repositoryRoot);
    this.#clock = clock;
  }

  async register(request: DatasetSourceRegistrationRequestV1): Promise<RegisteredDatasetSourceV1> {
    if (typeof request !== "object" || request === null || Array.isArray(request) || Object.keys(request).sort().join("\0") !== ["schemaVersion", "sourceDirectory"].sort().join("\0") || request.schemaVersion !== "dataset-source-registration-request-v1" || typeof request.sourceDirectory !== "string") throw new Error("dataset source registration request is invalid");
    const canonical = await validatePublicationRoot(request.sourceDirectory, this.#repositoryRoot);
    const publications = await scanDatasetPublicationRoots([canonical]);
    if (publications.length === 0) throw new Error("sourceDirectory contains no verified dataset publication");
    const sourceId = createHash("sha256").update(canonical).digest("hex");
    const registeredAtUtc = this.#clock(); validateUtc("registeredAtUtc", registeredAtUtc);
    const persisted: PersistedSourceV1 = { schemaVersion: "persisted-dataset-source-v1", sourceId, sourceDirectory: canonical, registeredAtUtc };
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const target = join(this.#root, `${sourceId}.json`); const temporary = join(this.#root, `${sourceId}.${process.pid}.${randomUUID()}.partial`);
    await writeFile(temporary, `${JSON.stringify(persisted)}\n`, { flag: "wx", mode: 0o600 });
    try { await rename(temporary, target); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    return Object.freeze({ schemaVersion: "registered-dataset-source-v1", sourceId, registeredAtUtc, datasetCount: publications.length, rawDataPolicy: "read-only-not-copied" });
  }

  async roots(): Promise<readonly string[]> {
    const entries = await readdir(this.#root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
    const roots: string[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f]{64}\.json$/u.test(entry.name)) continue;
      const raw: unknown = JSON.parse(await readFile(join(this.#root, entry.name), "utf8"));
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("dataset source registry entry is invalid");
      const value = raw as PersistedSourceV1;
      if (Object.keys(value).sort().join("\0") !== ["schemaVersion", "sourceId", "sourceDirectory", "registeredAtUtc"].sort().join("\0") || value.schemaVersion !== "persisted-dataset-source-v1" || value.sourceId !== entry.name.slice(0, -5) || createHash("sha256").update(value.sourceDirectory).digest("hex") !== value.sourceId) throw new Error("dataset source registry entry is invalid");
      roots.push(await validatePublicationRoot(value.sourceDirectory, this.#repositoryRoot));
    }
    return Object.freeze(roots);
  }
}

function listItem(value: DatasetSummaryV1, management: "managed" | "read-only"): DatasetListItemV1 {
  if (value.schemaVersion !== "dataset-summary-v1") throw new Error("scanner returned an unsupported dataset summary");
  validateIdentity(value.datasetId, value.versionHash);
  if (value.format !== "normalized-events-v1" && value.format !== "external-historical-v1") throw new Error("dataset format is invalid");
  if (value.continuity !== "UNVERIFIED" || value.status !== "available") throw new Error("dataset verification state is invalid");
  if (value.startTimeUtc !== null) validateUtc("dataset startTimeUtc", value.startTimeUtc);
  if (value.endTimeUtc !== null) validateUtc("dataset endTimeUtc", value.endTimeUtc);
  if (value.startTimeUtc !== null && value.endTimeUtc !== null && Date.parse(value.startTimeUtc) > Date.parse(value.endTimeUtc)) throw new Error("dataset time range is invalid");
  if (!Number.isSafeInteger(value.rowCount) || value.rowCount < 0 || !Number.isSafeInteger(value.quarantineCount) || value.quarantineCount < 0) throw new Error("dataset counts are invalid");
  return Object.freeze({
    schemaVersion: "dataset-list-item-v2",
    datasetId: value.datasetId,
    versionHash: value.versionHash,
    format: value.format,
    continuity: value.continuity,
    startTimeUtc: value.startTimeUtc,
    endTimeUtc: value.endTimeUtc,
    rowCount: value.rowCount,
    quarantineCount: value.quarantineCount,
    status: value.status,
    displayName: value.displayName,
    description: value.description,
    publishedAtUtc: value.publishedAtUtc,
    source: value.source,
    tags: value.tags,
    management,
  });
}

function detail(value: DatasetListItemV1): DatasetDetailV1 {
  return Object.freeze({
    schemaVersion: "dataset-detail-v2",
    datasetId: value.datasetId,
    versionHash: value.versionHash,
    format: value.format,
    continuity: value.continuity,
    startTimeUtc: value.startTimeUtc,
    endTimeUtc: value.endTimeUtc,
    rowCount: value.rowCount,
    quarantineCount: value.quarantineCount,
    status: value.status,
    displayName: value.displayName,
    description: value.description,
    publishedAtUtc: value.publishedAtUtc,
    source: value.source,
    tags: value.tags,
    management: value.management,
    selectionReady: true,
    rawDataPolicy: "read-only-not-copied",
  });
}

/**
 * Application facade for the UI/Tauri boundary. The data root and manifest paths
 * remain backend-only; every selectable version must first pass scanDatasets.
 */
export class DatasetApplicationService {
  readonly #dataRoot: string;
  readonly #scanner: DatasetScanner;
  readonly #clock: Clock;
  readonly #sourceRegistry: FileDatasetSourceRegistry;
  readonly #defaultScanner: boolean;
  #snapshot: ReadonlyMap<string, DatasetListItemV1> | null = null;
  #scannedAtUtc: string | null = null;
  #scanQueue: Promise<void> = Promise.resolve();

  constructor(dataRoot: string, options: Readonly<{ scanner?: DatasetScanner; clock?: Clock; repositoryRoot?: string }> = {}) {
    if (!isAbsolute(dataRoot)) throw new Error("dataRoot must be absolute");
    this.#dataRoot = resolve(dataRoot);
    this.#scanner = options.scanner ?? scanDatasets;
    this.#defaultScanner = options.scanner === undefined;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#sourceRegistry = new FileDatasetSourceRegistry(this.#dataRoot, options.repositoryRoot ?? process.cwd(), this.#clock);
  }

  registerSource(request: DatasetSourceRegistrationRequestV1): Promise<RegisteredDatasetSourceV1> { return this.#sourceRegistry.register(request); }

  async scan(): Promise<DatasetScanV1> {
    let output: DatasetScanV1 | undefined;
    const operation = this.#scanQueue.then(async () => {
      const fixed = await this.#scanner(this.#dataRoot);
      const managed = this.#defaultScanner ? await scanDatasetPublicationRoots([resolve(this.#dataRoot, "normalized")]) : fixed;
      const managedKeys = new Set(managed.map((item) => this.#key(item.datasetId, item.versionHash)));
      const registeredRoots = await this.#sourceRegistry.roots();
      const registered = registeredRoots.length === 0 ? [] : await scanDatasetPublicationRoots(registeredRoots);
      const scanned = [...fixed, ...registered];
      if (!Array.isArray(scanned) || scanned.length > MAX_DATASETS) throw new Error("dataset scan result exceeds application limit");
      const items = scanned.map((item) => listItem(item, managedKeys.has(this.#key(item.datasetId, item.versionHash)) ? "managed" : "read-only")).sort((left, right) => left.datasetId.localeCompare(right.datasetId) || left.versionHash.localeCompare(right.versionHash));
      const snapshot = new Map<string, DatasetListItemV1>();
      for (const item of items) {
        const key = this.#key(item.datasetId, item.versionHash);
        if (snapshot.has(key)) throw new Error("dataset scan returned a duplicate version");
        snapshot.set(key, item);
      }
      const scannedAtUtc = this.#clock();
      validateUtc("scannedAtUtc", scannedAtUtc);
      this.#snapshot = snapshot;
      this.#scannedAtUtc = scannedAtUtc;
      output = Object.freeze({ schemaVersion: "dataset-scan-v2", scannedAtUtc, datasetCount: items.length, datasets: Object.freeze(items) });
    });
    this.#scanQueue = operation.catch(() => undefined);
    await operation;
    if (output === undefined) throw new Error("dataset scan did not produce a result");
    return output;
  }

  list(): DatasetListV1 {
    const snapshot = this.#requireSnapshot();
    return Object.freeze({ schemaVersion: "dataset-list-v2", scannedAtUtc: this.#scannedAtUtc!, datasets: Object.freeze([...snapshot.values()]) });
  }

  get(datasetId: string, versionHash: string): DatasetDetailV1 {
    validateIdentity(datasetId, versionHash);
    const value = this.#requireSnapshot().get(this.#key(datasetId, versionHash));
    if (value === undefined) throw new Error("dataset version is not available in the verified scan");
    return detail(value);
  }

  async resolveForExecution(input: DatasetSelectionRequestV1): Promise<ResolvedDatasetExecutionV1> {
    if (typeof input !== "object" || input === null || Array.isArray(input) || Object.keys(input).sort().join("\0") !== ["schemaVersion", "datasetId", "versionHash"].sort().join("\0") || input.schemaVersion !== "dataset-selection-request-v1") throw new Error("dataset selection contains unknown fields");
    validateIdentity(input.datasetId, input.versionHash);
    const roots = [resolve(this.#dataRoot, "normalized"), resolve(this.#dataRoot, "external-research", "normalized"), ...await this.#sourceRegistry.roots()];
    const matches: string[] = [];
    for (const root of roots) {
      const summaries = await scanDatasetPublicationRoots([root]);
      if (!summaries.some((item) => item.datasetId === input.datasetId && item.versionHash === input.versionHash)) continue;
      const candidate = resolve(root, `dataset_id=${input.datasetId}`, `version=${input.versionHash}`);
      const canonicalRoot = await realpath(root); const canonicalCandidate = await realpath(candidate);
      if (!isInside(canonicalRoot, canonicalCandidate) || canonicalCandidate !== candidate) throw new Error("dataset execution publication contains a symbolic-link escape");
      const info = await lstat(canonicalCandidate); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("dataset execution publication is unsafe");
      matches.push(canonicalCandidate);
    }
    if (matches.length === 0) throw new Error("dataset version is not available in the verified scan");
    if (matches.length > 1) throw new Error("dataset version is ambiguous across publication roots");
    return Object.freeze({ datasetId: input.datasetId, versionHash: input.versionHash, publicationDirectory: matches[0]! });
  }

  validateSelection(input: DatasetSelectionRequestV1): ValidatedDatasetSelectionV1 {
    if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("dataset selection must be an object");
    const keys = Object.keys(input).sort();
    if (keys.length !== 3 || keys[0] !== "datasetId" || keys[1] !== "schemaVersion" || keys[2] !== "versionHash") throw new Error("dataset selection contains unknown fields");
    if (input.schemaVersion !== "dataset-selection-request-v1") throw new Error("unsupported dataset selection request");
    validateIdentity(input.datasetId, input.versionHash);
    if (!this.#requireSnapshot().has(this.#key(input.datasetId, input.versionHash))) throw new Error("dataset version is not available in the verified scan");
    const validatedAtUtc = this.#clock();
    validateUtc("validatedAtUtc", validatedAtUtc);
    return Object.freeze({ schemaVersion: "validated-dataset-selection-v1", datasetId: input.datasetId, versionHash: input.versionHash, validatedAtUtc });
  }

  async deleteManagedPublication(datasetId: string, versionHash: string, confirmation: string): Promise<void> {
    validateIdentity(datasetId, versionHash);
    if (confirmation !== `${datasetId}:${versionHash}`) throw new Error("dataset deletion confirmation does not match");
    const root = resolve(this.#dataRoot, "normalized");
    const available = await scanDatasetPublicationRoots([root]);
    if (!available.some((item) => item.datasetId === datasetId && item.versionHash === versionHash)) throw new Error("only a workbench-managed normalized publication can be deleted");
    const candidate = resolve(root, `dataset_id=${datasetId}`, `version=${versionHash}`);
    const canonicalRoot = await realpath(root); const canonicalCandidate = await realpath(candidate);
    if (!isInside(canonicalRoot, canonicalCandidate) || canonicalCandidate !== candidate) throw new Error("dataset deletion target is unsafe");
    const info = await lstat(canonicalCandidate); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("dataset deletion target is unsafe");
    await rm(canonicalCandidate, { recursive: true });
    this.#snapshot = null; this.#scannedAtUtc = null;
  }

  #key(datasetId: string, versionHash: string): string { return `${datasetId}\u0000${versionHash}`; }

  #requireSnapshot(): ReadonlyMap<string, DatasetListItemV1> {
    if (this.#snapshot === null || this.#scannedAtUtc === null) throw new Error("datasets have not been scanned");
    return this.#snapshot;
  }
}

export const DATASET_API_LIMITS = Object.freeze({ maxDatasets: MAX_DATASETS });
