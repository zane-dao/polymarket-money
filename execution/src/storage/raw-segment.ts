import { createHash } from "node:crypto";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parsePersistedEnvelope,
  persistEnvelope,
  requireUtcIso,
  type RawEventEnvelopeDraftV1,
  type RawEventEnvelopeV1,
} from "../domain/raw-event.js";

export interface AppendReceipt {
  readonly eventId: string;
  readonly segmentId: string;
  readonly ordinal: number;
  readonly persistTime: string;
  readonly durable: true;
}

export interface ClosedSegment {
  readonly segmentId: string;
  readonly source: string;
  readonly stream: string;
  readonly partitionDate: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly byteCount: number;
  readonly eventCount: number;
  readonly parseErrorCount: number;
  readonly unknownEventCount: number;
  readonly firstReceiveTime: string;
  readonly lastReceiveTime: string;
  readonly marketIds: readonly string[];
  readonly assetIds: readonly string[];
  readonly continuity: "UNVERIFIED";
}

export interface OpenRawSegmentInput {
  readonly dataRoot: string;
  readonly segmentId: string;
  readonly source: string;
  readonly stream: string;
  readonly partitionDate: string;
  readonly clock?: () => string;
}

type WriterState = "OPEN" | "FAILED" | "CLOSED";

const SAFE_PATH_PART = /^[A-Za-z0-9._-]+$/;
const DATE_PART = /^\d{4}-\d{2}-\d{2}$/;
const HEX_COMMIT = /^[0-9a-f]{7,64}$/;
const DECIMAL_TOKEN_ID = /^[1-9]\d*$/;
const BTC_FIVE_MINUTE_SLUG = /^btc-updown-5m-(\d+)$/;
let repositoryRootPromise: Promise<string> | undefined;

function repositoryRoot(): Promise<string> {
  repositoryRootPromise ??= (async () => {
    let current = dirname(fileURLToPath(import.meta.url));
    while (dirname(current) !== current) {
      try {
        const packageMetadata = JSON.parse(await readFile(join(current, "package.json"), "utf8")) as {
          readonly name?: unknown;
        };
        if (packageMetadata.name === "polymarket-money") return realpath(current);
      } catch (error) {
        if (!isNotFound(error) && !(error instanceof SyntaxError)) throw error;
      }
      current = dirname(current);
    }
    throw new Error("cannot locate the polymarket-money repository root");
  })();
  return repositoryRootPromise;
}

async function rejectRepositoryDataRoot(path: string): Promise<void> {
  const repository = await repositoryRoot();
  if (isWithin(repository, resolve(path))) {
    throw new Error("POLY_DATA_ROOT must remain outside the Git repository");
  }
}

function safePart(value: string, field: string): string {
  if (typeof value !== "string" || !SAFE_PATH_PART.test(value) || value === "." || value === "..") {
    throw new Error(`${field} contains unsafe path characters`);
  }
  return value;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (
    child !== ".." &&
    !child.startsWith("../") &&
    !child.startsWith("..\\") &&
    !isAbsolute(child)
  );
}

async function ensureDirectoryTreeWithoutSymlinks(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("directory path must be absolute");
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = relative(root, absolute).split(/[\\/]+/u).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const before = await lstat(current);
      if (before.isSymbolicLink()) throw new Error(`symlink directory is forbidden: ${current}`);
      if (!before.isDirectory()) throw new Error(`path component is not a directory: ${current}`);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!(mkdirError instanceof Error && "code" in mkdirError && mkdirError.code === "EEXIST")) {
          throw mkdirError;
        }
      }
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error(`safe directory creation failed: ${current}`);
      }
      await syncDirectory(dirname(current));
    }
    const canonical = await realpath(current);
    if (canonical !== current) throw new Error(`symlink directory is forbidden: ${current}`);
  }
  return absolute;
}

async function requireRegularFileWithinRoot(dataRoot: string, path: string): Promise<string> {
  const absolute = resolve(path);
  if (!isWithin(dataRoot, absolute)) throw new Error("file escapes POLY_DATA_ROOT");
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("segment must be a regular non-symlink file");
  const canonical = await realpath(absolute);
  if (canonical !== absolute || !isWithin(dataRoot, canonical)) {
    throw new Error("segment symlink escape is forbidden");
  }
  return canonical;
}

async function ensureAbsent(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  throw new Error(`path already exists: ${path}`);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishNoReplace(partialPath: string, finalPath: string): Promise<void> {
  // POSIX rename overwrites. A hard link fails atomically with EEXIST and gives
  // the required no-clobber publication semantics on the WSL native filesystem.
  await link(partialPath, finalPath);
  await chmod(finalPath, 0o400);
  await syncDirectory(dirname(finalPath));
  await unlink(partialPath);
  await syncDirectory(dirname(finalPath));
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateDraft(draft: RawEventEnvelopeDraftV1): RawEventEnvelopeDraftV1 {
  if (draft === null || typeof draft !== "object" || Array.isArray(draft)) {
    throw new Error("RawEventEnvelope draft must be an object");
  }
  if (Object.prototype.hasOwnProperty.call(draft, "persist_time")) {
    throw new Error("persist_time is writer-owned and forbidden on a draft");
  }
  const provisional = JSON.stringify({ ...draft, persist_time: draft.process_time });
  const validated = parsePersistedEnvelope(provisional);
  const { persist_time: _persistTime, ...canonicalDraft } = validated;
  return Object.freeze(canonicalDraft);
}

function draftFingerprint(draft: RawEventEnvelopeDraftV1): string {
  return digest(Buffer.from(JSON.stringify(draft), "utf8"));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

interface SegmentLocator {
  readonly segmentId: string;
  readonly source: string;
  readonly stream: string;
  readonly partitionDate: string;
  readonly relativePath: string;
}

async function inspectClosedSegmentFile(
  dataRoot: string,
  locator: SegmentLocator,
): Promise<ClosedSegment> {
  const segmentId = safePart(locator.segmentId, "segmentId");
  const source = safePart(locator.source, "source");
  const stream = safePart(locator.stream, "stream");
  if (!DATE_PART.test(locator.partitionDate)) throw new Error("partitionDate must be YYYY-MM-DD");
  const expectedRelativePath = join(
    source,
    locator.partitionDate,
    stream,
    `${segmentId}.jsonl`,
  ).split("\\").join("/");
  if (locator.relativePath !== expectedRelativePath) {
    throw new Error("segment relative path does not match source/date/stream/segmentId");
  }
  const path = await requireRegularFileWithinRoot(dataRoot, join(dataRoot, ...expectedRelativePath.split("/")));
  const bytes = await readFile(path);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("segment is not valid UTF-8", { cause: error });
  }
  if (!text.endsWith("\n")) throw new Error("segment must end with LF");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.some((line) => line === "" || line.endsWith("\r"))) {
    throw new Error("segment contains an empty, CRLF, or torn line");
  }
  const envelopes: RawEventEnvelopeV1[] = lines.map((line) => parsePersistedEnvelope(line));
  if (envelopes.some((event) => event.source !== source || event.stream !== stream)) {
    throw new Error("segment envelope source/stream mismatch");
  }
  if (envelopes.some((event) => event.receive_time.slice(0, 10) !== locator.partitionDate)) {
    throw new Error("segment envelope receive_time does not match partition date");
  }
  const eventIds = new Set<string>();
  for (const event of envelopes) {
    if (eventIds.has(event.event_id)) throw new Error("segment contains a duplicate event_id");
    eventIds.add(event.event_id);
  }
  const receiveTimes = envelopes.map((event) => event.receive_time).sort();
  const marketIds = [...new Set(envelopes.flatMap((event) => event.market_id === null ? [] : [event.market_id]))].sort();
  const assetIds = [...new Set(envelopes.flatMap((event) => event.asset_id === null ? [] : [event.asset_id]))].sort();
  return Object.freeze({
    segmentId,
    source,
    stream,
    partitionDate: locator.partitionDate,
    relativePath: expectedRelativePath,
    sha256: digest(bytes),
    byteCount: bytes.byteLength,
    eventCount: envelopes.length,
    parseErrorCount: envelopes.filter((event) => event.parser_status === "error").length,
    unknownEventCount: envelopes.filter((event) => event.parser_status === "unparsed").length,
    firstReceiveTime: receiveTimes[0] ?? "",
    lastReceiveTime: receiveTimes.at(-1) ?? "",
    marketIds: Object.freeze(marketIds),
    assetIds: Object.freeze(assetIds),
    continuity: "UNVERIFIED",
  });
}

function assertClosedSegmentMatches(expected: ClosedSegment, actual: ClosedSegment): void {
  for (const field of [
    "segmentId",
    "source",
    "stream",
    "partitionDate",
    "relativePath",
    "sha256",
    "byteCount",
    "eventCount",
    "parseErrorCount",
    "unknownEventCount",
    "firstReceiveTime",
    "lastReceiveTime",
    "continuity",
  ] as const) {
    if (expected[field] !== actual[field]) throw new Error(`closed segment metadata mismatch: ${field}`);
  }
  if (!sameStrings(expected.marketIds, actual.marketIds)) {
    throw new Error("closed segment metadata mismatch: marketIds");
  }
  if (!sameStrings(expected.assetIds, actual.assetIds)) {
    throw new Error("closed segment metadata mismatch: assetIds");
  }
}

export class RawSegmentWriter {
  readonly #dataRoot: string;
  readonly #segmentId: string;
  readonly #source: string;
  readonly #stream: string;
  readonly #partitionDate: string;
  readonly #partialPath: string;
  readonly #finalPath: string;
  readonly #clock: () => string;
  readonly #handle: FileHandle;
  readonly #seen = new Map<string, { fingerprint: string; receipt: AppendReceipt }>();
  readonly #marketIds = new Set<string>();
  readonly #assetIds = new Set<string>();
  #state: WriterState = "OPEN";
  #eventCount = 0;
  #parseErrorCount = 0;
  #unknownEventCount = 0;
  #firstReceiveTime: string | null = null;
  #lastReceiveTime: string | null = null;
  #closed: ClosedSegment | null = null;
  #operationTail: Promise<void> = Promise.resolve();

  private constructor(
    input: Required<Omit<OpenRawSegmentInput, "clock">> & { readonly clock: () => string },
    handle: FileHandle,
    partialPath: string,
    finalPath: string,
  ) {
    this.#dataRoot = input.dataRoot;
    this.#segmentId = input.segmentId;
    this.#source = input.source;
    this.#stream = input.stream;
    this.#partitionDate = input.partitionDate;
    this.#clock = input.clock;
    this.#handle = handle;
    this.#partialPath = partialPath;
    this.#finalPath = finalPath;
  }

  static async open(input: OpenRawSegmentInput): Promise<RawSegmentWriter> {
    if (!isAbsolute(input.dataRoot)) throw new Error("POLY_DATA_ROOT must be an absolute path");
    await rejectRepositoryDataRoot(input.dataRoot);
    const source = safePart(input.source, "source");
    const stream = safePart(input.stream, "stream");
    const segmentId = safePart(input.segmentId, "segmentId");
    if (!DATE_PART.test(input.partitionDate)) throw new Error("partitionDate must be YYYY-MM-DD");
    const dataRoot = await ensureDirectoryTreeWithoutSymlinks(resolve(input.dataRoot));
    await rejectRepositoryDataRoot(dataRoot);
    const partition = join(dataRoot, source, input.partitionDate, stream);
    const canonicalPartition = await ensureDirectoryTreeWithoutSymlinks(partition);
    if (!isWithin(dataRoot, canonicalPartition)) throw new Error("segment partition escapes POLY_DATA_ROOT");
    const partialPath = join(partition, `${segmentId}.jsonl.partial`);
    const finalPath = join(partition, `${segmentId}.jsonl`);
    await ensureAbsent(finalPath);
    const handle = await open(partialPath, "wx", 0o600);
    return new RawSegmentWriter(
      {
        dataRoot,
        source,
        stream,
        segmentId,
        partitionDate: input.partitionDate,
        clock: input.clock ?? (() => new Date().toISOString()),
      },
      handle,
      partialPath,
      finalPath,
    );
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation);
    this.#operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  append(draft: RawEventEnvelopeDraftV1): Promise<AppendReceipt> {
    return this.#serialize(() => this.#append(draft));
  }

  async #append(draft: RawEventEnvelopeDraftV1): Promise<AppendReceipt> {
    if (this.#state !== "OPEN") throw new Error(`cannot append while writer is ${this.#state}`);
    try {
      const canonicalDraft = validateDraft(draft);
      if (canonicalDraft.source !== this.#source || canonicalDraft.stream !== this.#stream) {
        throw new Error("segment source and stream are immutable");
      }
      if (canonicalDraft.receive_time.slice(0, 10) !== this.#partitionDate) {
        throw new Error("segment partition must be derived from receive_time UTC date");
      }
      const fingerprint = draftFingerprint(canonicalDraft);
      const previous = this.#seen.get(canonicalDraft.event_id);
      if (previous !== undefined) {
        if (previous.fingerprint !== fingerprint) {
          throw new Error("duplicate event_id has conflicting content");
        }
        return previous.receipt;
      }
      // persist_time is the logical durability-commit timestamp. It is writer
      // owned and acknowledged only after the following fsync succeeds.
      const persisted = persistEnvelope(canonicalDraft, this.#clock());
      const serialized = JSON.stringify(persisted);
      const envelope = parsePersistedEnvelope(serialized);
      const line = `${serialized}\n`;
      await this.#handle.writeFile(line, { encoding: "utf8" });
      await this.#handle.sync();
      const receipt: AppendReceipt = Object.freeze({
        eventId: envelope.event_id,
        segmentId: this.#segmentId,
        ordinal: this.#eventCount,
        persistTime: envelope.persist_time,
        durable: true,
      });
      this.#eventCount += 1;
      if (envelope.parser_status === "error") this.#parseErrorCount += 1;
      if (envelope.parser_status === "unparsed") this.#unknownEventCount += 1;
      if (envelope.market_id !== null) this.#marketIds.add(envelope.market_id);
      if (envelope.asset_id !== null) this.#assetIds.add(envelope.asset_id);
      this.#firstReceiveTime =
        this.#firstReceiveTime === null || envelope.receive_time < this.#firstReceiveTime
          ? envelope.receive_time
          : this.#firstReceiveTime;
      this.#lastReceiveTime =
        this.#lastReceiveTime === null || envelope.receive_time > this.#lastReceiveTime
          ? envelope.receive_time
          : this.#lastReceiveTime;
      this.#seen.set(envelope.event_id, { fingerprint, receipt });
      return receipt;
    } catch (error) {
      this.#state = "FAILED";
      throw error;
    }
  }

  close(): Promise<ClosedSegment> {
    return this.#serialize(() => this.#close());
  }

  async #close(): Promise<ClosedSegment> {
    if (this.#closed !== null) return this.#closed;
    if (this.#state !== "OPEN") throw new Error(`cannot close while writer is ${this.#state}`);
    if (this.#eventCount === 0 || this.#firstReceiveTime === null || this.#lastReceiveTime === null) {
      this.#state = "FAILED";
      throw new Error("an empty segment cannot be published");
    }
    try {
      await this.#handle.sync();
      await this.#handle.close();
      const bytes = await readFile(this.#partialPath);
      const text = bytes.toString("utf8");
      if (!text.endsWith("\n")) throw new Error("segment must end with LF");
      const lines = text.slice(0, -1).split("\n");
      if (lines.length !== this.#eventCount || lines.some((line) => line === "")) {
        throw new Error("segment line count changed before close");
      }
      for (const line of lines) parsePersistedEnvelope(line);
      await publishNoReplace(this.#partialPath, this.#finalPath);
      const proposed: ClosedSegment = Object.freeze({
        segmentId: this.#segmentId,
        source: this.#source,
        stream: this.#stream,
        partitionDate: this.#partitionDate,
        relativePath: relative(this.#dataRoot, this.#finalPath).split("\\").join("/"),
        sha256: digest(bytes),
        byteCount: bytes.byteLength,
        eventCount: this.#eventCount,
        parseErrorCount: this.#parseErrorCount,
        unknownEventCount: this.#unknownEventCount,
        firstReceiveTime: this.#firstReceiveTime,
        lastReceiveTime: this.#lastReceiveTime,
        marketIds: Object.freeze([...this.#marketIds].sort()),
        assetIds: Object.freeze([...this.#assetIds].sort()),
        continuity: "UNVERIFIED" as const,
      });
      const closed = await inspectClosedSegmentFile(this.#dataRoot, proposed);
      assertClosedSegmentMatches(proposed, closed);
      this.#closed = closed;
      this.#state = "CLOSED";
      return closed;
    } catch (error) {
      this.#state = "FAILED";
      throw error;
    }
  }

  leaveIncomplete(): Promise<void> {
    return this.#serialize(() => this.#leaveIncomplete());
  }

  async #leaveIncomplete(): Promise<void> {
    if (this.#state === "CLOSED") throw new Error("closed segment is immutable");
    try {
      await this.#handle.sync();
      await this.#handle.close();
    } finally {
      this.#state = "FAILED";
    }
  }
}

export interface DatasetManifestSegmentV1 {
  readonly ordinal: number;
  readonly relative_path: string;
  readonly sha256: string;
  readonly byte_count: number;
  readonly event_count: number;
  readonly parse_error_count: number;
  readonly unknown_event_count: number;
  readonly first_receive_time: string;
  readonly last_receive_time: string;
}

export interface DatasetManifestV1 {
  readonly dataset_id: string;
  readonly schema_version: "dataset-manifest-v1";
  readonly source: string;
  readonly stream: string;
  readonly subscription: Readonly<Record<string, unknown>>;
  readonly collector_git_commit: string;
  readonly collection_start: string;
  readonly collection_end: string;
  readonly segments: readonly DatasetManifestSegmentV1[];
  readonly event_count: number;
  readonly parse_error_count: number;
  readonly unknown_event_count: number;
  readonly first_receive_time: string;
  readonly last_receive_time: string;
  readonly market_ids: readonly string[];
  readonly asset_ids: readonly string[];
  readonly continuity: "UNVERIFIED";
  readonly sanitized_config: Readonly<Record<string, string | number | boolean>>;
}

export interface PublishManifestInput {
  readonly datasetId: string;
  readonly source: string;
  readonly stream: string;
  readonly subscription: Readonly<Record<string, unknown>>;
  readonly collectorGitCommit: string;
  readonly collectionStart: string;
  readonly collectionEnd: string;
  readonly segments: readonly ClosedSegment[];
  readonly sanitizedConfig: Readonly<Record<string, string | number | boolean>>;
}

const SENSITIVE_VALUE = /(?:^sk-|-----BEGIN|api.?key|private.?key|mnemonic|seed phrase|passphrase|credential|gamma.?auth|wallet secret)/i;
const SANITIZED_CONFIG_KEYS = new Set([
  "endpointClass",
  "heartbeatSeconds",
  "maxEvents",
  "timeoutSeconds",
  "customFeatures",
  "symbolFilter",
  "maxFrameBytes",
  "maxTotalBytes",
  "maxResponseBytes",
]);

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!sameStrings(actual, expected)) throw new Error(`${field} contains unsupported fields`);
}

function validatePublicSubscription(
  source: string,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const subscription = record(value, "subscription");
  if (source === "polymarket.gamma") {
    requireExactKeys(subscription, ["endpoint", "slug"], "Gamma subscription");
    if (subscription.endpoint !== "gamma-market-by-slug") {
      throw new Error("Gamma subscription endpoint must be gamma-market-by-slug");
    }
    if (typeof subscription.slug !== "string") throw new Error("Gamma subscription slug is required");
    const match = BTC_FIVE_MINUTE_SLUG.exec(subscription.slug);
    const epoch = match?.[1] === undefined ? Number.NaN : Number(match[1]);
    if (!Number.isSafeInteger(epoch) || epoch % 300 !== 0) {
      throw new Error("Gamma subscription must use an exact BTC five-minute slug");
    }
    return Object.freeze({ endpoint: subscription.endpoint, slug: subscription.slug });
  }
  if (source === "polymarket.clob.market") {
    requireExactKeys(subscription, ["assets_ids", "type", "custom_feature_enabled"], "CLOB subscription");
    if (subscription.type !== "market" || subscription.custom_feature_enabled !== true) {
      throw new Error("CLOB subscription must be the public market channel");
    }
    if (
      !Array.isArray(subscription.assets_ids) ||
      subscription.assets_ids.length === 0 ||
      !subscription.assets_ids.every((item) => typeof item === "string" && DECIMAL_TOKEN_ID.test(item)) ||
      new Set(subscription.assets_ids).size !== subscription.assets_ids.length
    ) {
      throw new Error("CLOB subscription requires distinct decimal asset IDs");
    }
    return Object.freeze({
      assets_ids: Object.freeze([...subscription.assets_ids]),
      type: "market",
      custom_feature_enabled: true,
    });
  }
  if (source === "polymarket.rtds.chainlink" || source === "polymarket.rtds.binance") {
    requireExactKeys(subscription, ["action", "subscriptions"], "RTDS subscription");
    if (subscription.action !== "subscribe" || !Array.isArray(subscription.subscriptions) || subscription.subscriptions.length !== 1) {
      throw new Error("RTDS subscription must contain one public subscription");
    }
    const child = record(subscription.subscriptions[0], "RTDS subscription item");
    requireExactKeys(child, ["topic", "type", "filters"], "RTDS subscription item");
    const expected = source.endsWith("chainlink")
      ? { topic: "crypto_prices_chainlink", type: "*", filters: '{"symbol":"btc/usd"}' }
      : { topic: "crypto_prices", type: "update", filters: "btcusdt" };
    if (child.topic !== expected.topic || child.type !== expected.type || child.filters !== expected.filters) {
      throw new Error("RTDS subscription is not the allowlisted BTC public feed");
    }
    return Object.freeze({
      action: "subscribe",
      subscriptions: Object.freeze([Object.freeze(expected)]),
    });
  }
  if (source.startsWith("fixture.")) {
    requireExactKeys(subscription, ["topic"], "fixture subscription");
    if (subscription.topic !== "public-fixture") throw new Error("fixture subscription must be public-fixture");
    return Object.freeze({ topic: "public-fixture" });
  }
  throw new Error(`unsupported public manifest source: ${source}`);
}

function validateCollectorCommit(source: string, value: string): string {
  if (typeof value !== "string") {
    throw new Error("collector_git_commit must be a string");
  }
  if (HEX_COMMIT.test(value)) return value;
  if (source.startsWith("fixture.") && value === "UNCOMMITTED") return value;
  throw new Error("public collector_git_commit must be a 7-64 character lowercase hex commit");
}

function validateSanitizedConfig(
  value: Readonly<Record<string, string | number | boolean>>,
): Readonly<Record<string, string | number | boolean>> {
  const config = record(value, "sanitized_config");
  for (const [key, item] of Object.entries(config)) {
    if (!SANITIZED_CONFIG_KEYS.has(key)) {
      throw new Error(`sanitized_config key is not allowlisted: ${key}`);
    }
    if (typeof item === "string" && SENSITIVE_VALUE.test(item)) {
      throw new Error(`sensitive value forbidden at sanitized_config.${key}`);
    }
    if (key === "endpointClass" && item !== "public" && item !== "public-read-only") {
      throw new Error("endpointClass must identify a public read-only endpoint");
    }
    if (
      (key === "heartbeatSeconds" || key === "timeoutSeconds") &&
      (!Number.isSafeInteger(item) || (item as number) <= 0 || (item as number) > 300)
    ) {
      throw new Error(`${key} must be a bounded positive integer`);
    }
    if (key === "maxEvents" && (!Number.isSafeInteger(item) || (item as number) <= 0 || (item as number) > 10_000)) {
      throw new Error("maxEvents must be a bounded positive integer");
    }
    if (
      (key === "maxFrameBytes" || key === "maxTotalBytes" || key === "maxResponseBytes")
      && (!Number.isSafeInteger(item) || (item as number) <= 0 || (item as number) > 50 * 1024 * 1024)
    ) {
      throw new Error(`${key} must be a bounded positive byte count`);
    }
    if (key === "customFeatures" && typeof item !== "boolean") {
      throw new Error("customFeatures must be boolean");
    }
    if (key === "symbolFilter" && item !== "btc/usd" && item !== "btcusdt") {
      throw new Error("symbolFilter must be an allowlisted BTC symbol");
    }
  }
  if (config.endpointClass === undefined) throw new Error("sanitized_config.endpointClass is required");
  return Object.freeze({ ...config } as Record<string, string | number | boolean>);
}

function assertCollectionContainsSegments(
  collectionStart: string,
  collectionEnd: string,
  segments: readonly ClosedSegment[],
): void {
  const start = Date.parse(collectionStart);
  const end = Date.parse(collectionEnd);
  for (const segment of segments) {
    if (Date.parse(segment.firstReceiveTime) < start || Date.parse(segment.lastReceiveTime) > end) {
      throw new Error("segment receive range falls outside collection range");
    }
  }
}

export class DatasetManifestWriter {
  readonly #dataRoot: string;

  constructor(dataRoot: string) {
    if (!isAbsolute(dataRoot)) throw new Error("POLY_DATA_ROOT must be absolute");
    this.#dataRoot = resolve(dataRoot);
  }

  async publish(input: PublishManifestInput): Promise<DatasetManifestV1> {
    await rejectRepositoryDataRoot(this.#dataRoot);
    const dataRoot = await ensureDirectoryTreeWithoutSymlinks(this.#dataRoot);
    await rejectRepositoryDataRoot(dataRoot);
    const datasetId = safePart(input.datasetId, "datasetId");
    const source = safePart(input.source, "source");
    const stream = safePart(input.stream, "stream");
    if (input.segments.length === 0) throw new Error("manifest requires at least one closed segment");
    if (input.segments.some((segment) => segment.source !== source || segment.stream !== stream)) {
      throw new Error("manifest cannot mix sources or streams");
    }
    const collectionStart = requireUtcIso(input.collectionStart, "collection_start");
    const collectionEnd = requireUtcIso(input.collectionEnd, "collection_end");
    if (Date.parse(collectionEnd) < Date.parse(collectionStart)) {
      throw new Error("collection_end must not precede collection_start");
    }
    const subscription = validatePublicSubscription(source, input.subscription);
    const collectorGitCommit = validateCollectorCommit(source, input.collectorGitCommit);
    const sanitizedConfig = validateSanitizedConfig(input.sanitizedConfig);
    const seenPaths = new Set<string>();
    const seenSegmentIds = new Set<string>();
    const actualSegments: ClosedSegment[] = [];
    for (const claimed of input.segments) {
      if (seenPaths.has(claimed.relativePath) || seenSegmentIds.has(claimed.segmentId)) {
        throw new Error("manifest cannot reference a duplicate segment path or segment ID");
      }
      seenPaths.add(claimed.relativePath);
      seenSegmentIds.add(claimed.segmentId);
      const actual = await inspectClosedSegmentFile(dataRoot, claimed);
      assertClosedSegmentMatches(claimed, actual);
      actualSegments.push(actual);
    }
    assertCollectionContainsSegments(collectionStart, collectionEnd, actualSegments);
    const segments = actualSegments.map((segment, ordinal) => Object.freeze({
      ordinal,
      relative_path: segment.relativePath,
      sha256: segment.sha256,
      byte_count: segment.byteCount,
      event_count: segment.eventCount,
      parse_error_count: segment.parseErrorCount,
      unknown_event_count: segment.unknownEventCount,
      first_receive_time: segment.firstReceiveTime,
      last_receive_time: segment.lastReceiveTime,
    }));
    const marketIds = new Set(actualSegments.flatMap((segment) => segment.marketIds));
    const assetIds = new Set(actualSegments.flatMap((segment) => segment.assetIds));
    if (source === "polymarket.clob.market") {
      const subscribedAssets = subscription.assets_ids;
      if (!Array.isArray(subscribedAssets)) throw new Error("validated CLOB subscription lost assets_ids");
      for (const assetId of subscribedAssets) {
        if (typeof assetId !== "string") throw new Error("validated CLOB asset ID changed type");
        assetIds.add(assetId);
      }
    }
    const manifest: DatasetManifestV1 = Object.freeze({
      dataset_id: datasetId,
      schema_version: "dataset-manifest-v1",
      source,
      stream,
      subscription,
      collector_git_commit: collectorGitCommit,
      collection_start: collectionStart,
      collection_end: collectionEnd,
      segments: Object.freeze(segments),
      event_count: segments.reduce((sum, segment) => sum + segment.event_count, 0),
      parse_error_count: segments.reduce((sum, segment) => sum + segment.parse_error_count, 0),
      unknown_event_count: segments.reduce((sum, segment) => sum + segment.unknown_event_count, 0),
      first_receive_time: segments.map((segment) => segment.first_receive_time).sort()[0] ?? "",
      last_receive_time: segments.map((segment) => segment.last_receive_time).sort().at(-1) ?? "",
      market_ids: Object.freeze([...marketIds].sort()),
      asset_ids: Object.freeze([...assetIds].sort()),
      continuity: "UNVERIFIED",
      sanitized_config: sanitizedConfig,
    });
    const manifestDirectory = await ensureDirectoryTreeWithoutSymlinks(join(dataRoot, "manifests"));
    if (!isWithin(dataRoot, manifestDirectory)) throw new Error("manifest directory escapes POLY_DATA_ROOT");
    const partialPath = join(manifestDirectory, `${datasetId}.manifest.json.partial`);
    const finalPath = join(manifestDirectory, `${datasetId}.manifest.json`);
    await ensureAbsent(finalPath);
    const handle = await open(partialPath, "wx", 0o600);
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    try {
      await handle.writeFile(serialized, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      await publishNoReplace(partialPath, finalPath);
    } catch (error) {
      try {
        await handle.close();
      } catch {
        // Preserve the original publication failure and leave .partial visible.
      }
      throw error;
    }
    const publishedPath = await requireRegularFileWithinRoot(dataRoot, finalPath);
    const published = await readFile(publishedPath);
    if (!published.equals(Buffer.from(serialized, "utf8"))) {
      throw new Error("published manifest bytes do not match the verified manifest");
    }
    for (const expected of actualSegments) {
      const actual = await inspectClosedSegmentFile(dataRoot, expected);
      assertClosedSegmentMatches(expected, actual);
    }
    return manifest;
  }
}
