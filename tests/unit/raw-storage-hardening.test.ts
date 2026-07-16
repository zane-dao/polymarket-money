import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createEnvelopeDraft,
  type RawEventEnvelopeDraftV1,
} from "../../execution/src/domain/raw-event.js";
import {
  DatasetManifestWriter,
  RawSegmentWriter,
  type ClosedSegment,
} from "../../execution/src/storage/raw-segment.js";

const DATE = "2026-07-15";
const RECEIVE = `${DATE}T00:00:00.100Z`;
const PROCESS = `${DATE}T00:00:00.200Z`;
const PERSIST = `${DATE}T00:00:00.300Z`;

function draft(
  eventId: string,
  source = "fixture.hardening",
  stream = "events",
): RawEventEnvelopeDraftV1 {
  return createEnvelopeDraft({
    eventId,
    source,
    stream,
    eventType: "fixture_event",
    connectionId: "connection-1",
    subscriptionId: "subscription-1",
    receiveTime: RECEIVE,
    processTime: PROCESS,
    rawPayload: JSON.stringify({ event_id: eventId, value: "0.123456789012345678" }),
    parserStatus: "parsed",
  });
}

async function openWriter(
  dataRoot: string,
  segmentId: string,
  source = "fixture.hardening",
  stream = "events",
): Promise<RawSegmentWriter> {
  return RawSegmentWriter.open({
    dataRoot,
    segmentId,
    source,
    stream,
    partitionDate: DATE,
    clock: () => PERSIST,
  });
}

function fixtureManifestInput(closed: readonly ClosedSegment[]) {
  return {
    datasetId: "dataset-hardening",
    source: "fixture.hardening",
    stream: "events",
    subscription: { topic: "public-fixture" },
    collectorGitCommit: "UNCOMMITTED",
    collectionStart: `${DATE}T00:00:00.000Z`,
    collectionEnd: `${DATE}T00:00:01.000Z`,
    segments: closed,
    sanitizedConfig: { endpointClass: "public" },
  } as const;
}

test("concurrent appends are serialized and retrying one event ID is idempotent", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "poly-storage-concurrent-"));
  try {
    const writer = await openWriter(dataRoot, "segment-concurrent");
    const firstDraft = draft("event-a");
    const [first, duplicate, second] = await Promise.all([
      writer.append(firstDraft),
      writer.append(firstDraft),
      writer.append(draft("event-b")),
    ]);
    assert.equal(first.ordinal, 0);
    assert.equal(duplicate.ordinal, 0);
    assert.equal(second.ordinal, 1);

    const [closedFirst, closedSecond] = await Promise.all([writer.close(), writer.close()]);
    assert.strictEqual(closedFirst, closedSecond);
    assert.equal(closedFirst.eventCount, 2);
    const lines = (await readFile(join(dataRoot, closedFirst.relativePath), "utf8")).trimEnd().split("\n");
    assert.equal(lines.length, 2);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("append followed immediately by close is ordered behind the durable append", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "poly-storage-append-close-"));
  try {
    const writer = await openWriter(dataRoot, "segment-append-close");
    const appendPromise = writer.append(draft("event-before-close"));
    const closePromise = writer.close();
    const [receipt, closed] = await Promise.all([appendPromise, closePromise]);
    assert.equal(receipt.ordinal, 0);
    assert.equal(closed.eventCount, 1);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("writer rejects an invalid draft before returning a durable receipt", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "poly-storage-contract-"));
  try {
    const writer = await openWriter(dataRoot, "segment-invalid");
    const invalid = {
      ...draft("event-invalid"),
      raw_sha256: "0".repeat(64),
    } as RawEventEnvelopeDraftV1;
    await assert.rejects(writer.append(invalid), /raw_sha256/i);
    await writer.leaveIncomplete();
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("data root and partition directory symlinks are rejected", async () => {
  const base = await mkdtemp(join(tmpdir(), "poly-storage-symlink-"));
  try {
    const outside = join(base, "outside");
    const linkedRoot = join(base, "linked-root");
    await mkdir(outside);
    await symlink(outside, linkedRoot, "dir");
    await assert.rejects(openWriter(linkedRoot, "segment-root-link"), /symlink/i);

    const realRoot = join(base, "real-root");
    await mkdir(realRoot);
    await symlink(outside, join(realRoot, "fixture.hardening"), "dir");
    await assert.rejects(openWriter(realRoot, "segment-partition-link"), /symlink/i);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("raw storage refuses a data root inside the Git repository", async () => {
  const repository = new URL("../../../", import.meta.url);
  await assert.rejects(
    openWriter(join(repository.pathname, "data", "raw"), "segment-in-repository"),
    /outside the Git repository/i,
  );
});

test("manifest directory symlink is rejected", async () => {
  const base = await mkdtemp(join(tmpdir(), "poly-manifest-symlink-"));
  try {
    const dataRoot = join(base, "data");
    const outside = join(base, "outside");
    await mkdir(dataRoot);
    await mkdir(outside);
    const writer = await openWriter(dataRoot, "segment-manifest-link");
    await writer.append(draft("event-manifest-link"));
    const closed = await writer.close();
    await symlink(outside, join(dataRoot, "manifests"), "dir");
    await assert.rejects(
      new DatasetManifestWriter(dataRoot).publish(fixtureManifestInput([closed])),
      /symlink/i,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("manifest verifies real segment metadata and rejects duplicates or forged claims", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "poly-manifest-metadata-"));
  try {
    const writer = await openWriter(dataRoot, "segment-metadata");
    await writer.append(draft("event-metadata"));
    const closed = await writer.close();

    await assert.rejects(
      new DatasetManifestWriter(dataRoot).publish(fixtureManifestInput([
        { ...closed, sha256: "0".repeat(64) },
      ])),
      /metadata mismatch: sha256/i,
    );
    await assert.rejects(
      new DatasetManifestWriter(dataRoot).publish(fixtureManifestInput([closed, closed])),
      /duplicate segment/i,
    );
    await assert.rejects(
      new DatasetManifestWriter(dataRoot).publish({
        ...fixtureManifestInput([closed]),
        datasetId: "dataset-sensitive",
        sanitizedConfig: { endpointClass: "sk-not-a-public-endpoint" },
      }),
      /sensitive value/i,
    );
    await assert.rejects(
      new DatasetManifestWriter(dataRoot).publish({
        ...fixtureManifestInput([closed]),
        datasetId: "dataset-bad-subscription",
        subscription: { topic: "private-fixture" },
      }),
      /public-fixture/i,
    );
    await assert.rejects(
      new DatasetManifestWriter(dataRoot).publish({
        ...fixtureManifestInput([closed]),
        datasetId: "dataset-bad-commit",
        collectorGitCommit: "not-a-commit",
      }),
      /collector_git_commit/i,
    );

    const manifest = await new DatasetManifestWriter(dataRoot).publish(fixtureManifestInput([closed]));
    assert.equal(manifest.event_count, 1);
    assert.equal(manifest.segments[0]?.sha256, closed.sha256);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("manifest accepts only the allowlisted public CLOB subscription shape", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "poly-manifest-public-schema-"));
  try {
    const source = "polymarket.clob.market";
    const stream = "market-channel";
    const writer = await openWriter(dataRoot, "segment-clob", source, stream);
    await writer.append(draft("event-clob", source, stream));
    const closed = await writer.close();
    const base = {
      source,
      stream,
      collectorGitCommit: "abcdef0",
      collectionStart: `${DATE}T00:00:00.000Z`,
      collectionEnd: `${DATE}T00:00:01.000Z`,
      segments: [closed],
      sanitizedConfig: { endpointClass: "public-read-only" },
    } as const;
    await assert.rejects(
      new DatasetManifestWriter(dataRoot).publish({
        ...base,
        datasetId: "dataset-clob-invalid",
        subscription: {
          assets_ids: ["not-a-decimal-token"],
          type: "market",
          custom_feature_enabled: true,
        },
      }),
      /decimal asset IDs/i,
    );
    const manifest = await new DatasetManifestWriter(dataRoot).publish({
      ...base,
      datasetId: "dataset-clob-valid",
      subscription: {
        assets_ids: ["123456789012345678901234567890"],
        type: "market",
        custom_feature_enabled: true,
      },
    });
    assert.equal(manifest.source, source);
    assert.deepEqual(manifest.asset_ids, ["123456789012345678901234567890"]);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("manifest accepts only allowlisted public RTDS transports with an effective BTC filter", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "poly-manifest-rtds-schema-"));
  try {
    const source = "polymarket.rtds.binance";
    const stream = "crypto-prices";
    const writer = await openWriter(dataRoot, "segment-binance", source, stream);
    await writer.append(draft("event-binance", source, stream));
    const closed = await writer.close();
    const base = {
      source,
      stream,
      collectorGitCommit: "abcdef0",
      collectionStart: `${DATE}T00:00:00.000Z`,
      collectionEnd: `${DATE}T00:00:01.000Z`,
      segments: [closed],
      sanitizedConfig: {
        endpointClass: "public-read-only",
        symbolFilter: "btcusdt",
        transportScope: "btc-only",
      },
    } as const;
    const valid = {
      action: "subscribe",
      subscriptions: [{ topic: "crypto_prices", type: "update", filters: "btcusdt" }],
    } as const;
    const manifest = await new DatasetManifestWriter(dataRoot).publish({
      ...base,
      datasetId: "dataset-binance-valid",
      subscription: valid,
    });
    assert.deepEqual(manifest.subscription, valid);

    await assert.rejects(
      new DatasetManifestWriter(dataRoot).publish({
        ...base,
        datasetId: "dataset-binance-extra-symbols",
        subscription: {
          action: "subscribe",
          subscriptions: [{
            topic: "crypto_prices",
            type: "update",
            filters: "solusdt,btcusdt,ethusdt",
          }],
        },
      }),
      /allowlisted Binance public transport/i,
    );
    await assert.rejects(
      new DatasetManifestWriter(dataRoot).publish({
        ...base,
        datasetId: "dataset-binance-extra-subscription",
        subscription: {
          action: "subscribe",
          subscriptions: [
            { topic: "crypto_prices", type: "update", filters: "btcusdt" },
            { topic: "crypto_prices", type: "update", filters: "ethusdt" },
          ],
        },
      }),
      /one public subscription/i,
    );

    const allSymbols = await new DatasetManifestWriter(dataRoot).publish({
      ...base,
      datasetId: "dataset-binance-all-symbols",
      subscription: {
        action: "subscribe",
        subscriptions: [{ topic: "crypto_prices", type: "update" }],
      },
      sanitizedConfig: {
        endpointClass: "public-read-only",
        symbolFilter: "btcusdt",
        transportScope: "all-symbols-quarantine",
      },
    });
    assert.equal(allSymbols.sanitized_config.transportScope, "all-symbols-quarantine");

    await assert.rejects(
      new DatasetManifestWriter(dataRoot).publish({
        ...base,
        datasetId: "dataset-binance-scope-mismatch",
        subscription: {
          action: "subscribe",
          subscriptions: [{ topic: "crypto_prices", type: "update" }],
        },
      }),
      /transport scope/i,
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("manifest accepts direct Binance public bookTicker without trading fields", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "poly-manifest-direct-binance-"));
  try {
    const source = "binance.spot";
    const stream = "book-ticker";
    const writer = await openWriter(dataRoot, "segment-direct-binance", source, stream);
    await writer.append(draft("event-direct-binance", source, stream));
    const closed = await writer.close();
    const manifest = await new DatasetManifestWriter(dataRoot).publish({
      datasetId: "dataset-direct-binance",
      source,
      stream,
      subscription: { endpoint: "market-data-only", stream: "bookTicker", symbol: "btcusdt" },
      collectorGitCommit: "abcdef0",
      collectionStart: `${DATE}T00:00:00.000Z`,
      collectionEnd: `${DATE}T00:00:01.000Z`,
      segments: [closed],
      sanitizedConfig: { endpointClass: "public-read-only", symbolFilter: "btcusdt" },
    });
    assert.equal(manifest.source, source);
    await assert.rejects(
      new DatasetManifestWriter(dataRoot).publish({
        datasetId: "dataset-direct-binance-invalid",
        source,
        stream,
        subscription: { endpoint: "trading", stream: "bookTicker", symbol: "btcusdt" },
        collectorGitCommit: "abcdef0",
        collectionStart: `${DATE}T00:00:00.000Z`,
        collectionEnd: `${DATE}T00:00:01.000Z`,
        segments: [closed],
        sanitizedConfig: { endpointClass: "public-read-only", symbolFilter: "btcusdt" },
      }),
      /public BTCUSDT bookTicker/,
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
