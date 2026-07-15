import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createEnvelopeDraft,
  parsePersistedEnvelope,
  rawSha256,
} from "../../execution/src/domain/raw-event.js";
import {
  parseClobMarketMessage,
  parseRestOrderBook,
  parseRtdsPriceMessage,
} from "../../execution/src/adapters/market-data/parsers.js";
import { BookState, PublicOrderBook } from "../../execution/src/adapters/market-data/book-state.js";
import {
  clobMarketSubscription,
  rtdsSubscription,
  validatePublicBtcFiveMinuteMarket,
} from "../../execution/src/adapters/market-data/public-sources.js";
import {
  DatasetManifestWriter,
  RawSegmentWriter,
} from "../../execution/src/storage/raw-segment.js";

const root = new URL("../../../", import.meta.url);

async function fixtureText(name: string): Promise<string> {
  return readFile(new URL(`data/fixtures/batch-2/${name}`, root), "utf8");
}

test("shared RawEventEnvelope fixture validates without changing raw payload", async () => {
  const line = (await fixtureText("raw-event-v1.golden.jsonl")).trimEnd();
  const bytes = Buffer.from(`${line}\n`, "utf8");
  const expected = JSON.parse(await fixtureText("raw-event-v1.golden.expected.json")) as {
    readonly segment_sha256: string;
    readonly byte_count: number;
  };
  const envelope = parsePersistedEnvelope(line);
  assert.equal(envelope.event_id, "evt-golden-001");
  assert.equal(envelope.source_sequence, "9007199254740993");
  assert.equal(rawSha256(envelope.raw_payload), envelope.raw_sha256);
  assert.match(envelope.raw_payload, /vendor_extra/);
  assert.equal(rawSha256(`${line}\n`), expected.segment_sha256);
  assert.equal(bytes.byteLength, expected.byte_count);
});

test("RTDS maps provider and source clocks and preserves the numeric lexeme", async () => {
  const fixture = JSON.parse(await fixtureText("rtds-events.json")) as Record<string, string>;
  const chainlink = parseRtdsPriceMessage(fixture.chainlink ?? "", "chainlink");
  const binance = parseRtdsPriceMessage(fixture.binance ?? "", "binance");
  assert.equal(chainlink.serverTime, "2025-07-23T23:41:28.421Z");
  assert.equal(chainlink.sourceTime, "2025-07-23T23:41:28.395Z");
  assert.equal(chainlink.valueDecimal, "67234.50");
  assert.equal(binance.valueDecimal, "67234.50000001");
});

test("RTDS rejects a non-BTC symbol into quarantine", async () => {
  const fixture = JSON.parse(await fixtureText("rtds-events.json")) as Record<string, string>;
  const parsed = parseRtdsPriceMessage(fixture.wrong_chainlink_symbol ?? "", "chainlink");
  assert.equal(parsed.parserStatus, "quarantined");

  const binance = parseRtdsPriceMessage(
    '{"topic":"crypto_prices","type":"update","timestamp":1753314088421,' +
      '"payload":{"symbol":"solusdt","timestamp":1753314088395,"value":189.55}}',
    "binance",
  );
  assert.equal(binance.parserStatus, "quarantined");
  assert.match(binance.quarantineReason ?? "", /unexpected symbol solusdt/);
});

test("malformed source data becomes an error while retaining exact raw text", () => {
  const raw = "{not-json";
  const clob = parseClobMarketMessage(raw);
  const rtds = parseRtdsPriceMessage(raw, "chainlink");
  assert.equal(clob.parserStatus, "error");
  assert.equal(rtds.parserStatus, "error");
  assert.equal(clob.rawPayload, raw);
  assert.equal(rtds.rawPayload, raw);
});

test("CLOB parser handles every price_changes element and size zero deletion", async () => {
  const fixture = JSON.parse(await fixtureText("clob-market-events.json")) as Record<string, unknown>;
  const parsed = parseClobMarketMessage(JSON.stringify(fixture.price_change));
  assert.equal(parsed.eventType, "price_change");
  assert.equal(parsed.priceChanges?.length, 2);
  assert.equal(parsed.priceChanges?.[0]?.deleteLevel, true);
  assert.equal(parsed.priceChanges?.[1]?.size, "200");
});

test("all required CLOB event types parse and market_resolved stays observational", async () => {
  const fixture = JSON.parse(await fixtureText("clob-market-events.json")) as Record<string, unknown>;
  for (const key of [
    "book_up",
    "tick_size_change",
    "last_trade_price",
    "best_bid_ask",
    "new_market",
    "market_resolved",
  ]) {
    const parsed = parseClobMarketMessage(JSON.stringify(fixture[key]));
    assert.equal(parsed.parserStatus, "parsed", key);
  }
  const resolved = parseClobMarketMessage(JSON.stringify(fixture.market_resolved));
  assert.equal(resolved.isGoldenSettlement, false);
});

test("unknown CLOB events are kept as unparsed raw data", async () => {
  const fixture = JSON.parse(await fixtureText("clob-market-events.json")) as Record<string, unknown>;
  const raw = JSON.stringify(fixture.unknown);
  const parsed = parseClobMarketMessage(raw);
  assert.equal(parsed.parserStatus, "unparsed");
  assert.equal(parsed.rawPayload, raw);
});

test("REST orderbook parser treats array order as non-authoritative", async () => {
  const fixture = JSON.parse(await fixtureText("clob-market-events.json")) as Record<string, unknown>;
  const source = fixture.book_up as Record<string, unknown>;
  const { event_type: _eventType, ...restBook } = source;
  const parsed = parseRestOrderBook(JSON.stringify(restBook));
  assert.equal(parsed.parserStatus, "parsed");
  const state = new PublicOrderBook({
    expectedConditionId: "condition-1",
    expectedAssetIds: ["token-up"],
    staleAfterMilliseconds: 1_000,
  });
  state.connected("rest-connection", "2026-07-15T00:00:00.000Z");
  state.applySnapshot(parsed, "rest-connection", "2026-07-15T00:00:00.100Z");
  assert.equal(state.bestBid("token-up"), "0.49");
  assert.equal(state.bestAsk("token-up"), "0.52");
});

test("Gamma identity uses eventStartTime, maps labels, and ignores creation startDate", async () => {
  const raw = await fixtureText("gamma-btc-5m.json");
  const market = validatePublicBtcFiveMinuteMarket(raw);
  assert.equal(market.intervalStart, "2026-04-03T01:50:00Z");
  assert.equal(market.intervalEnd, "2026-04-03T01:55:00Z");
  assert.match(market.upTokenId, /^433276/);
});

test("public subscriptions contain no auth, wallet, or user-channel fields", () => {
  const clob = JSON.stringify(clobMarketSubscription(["123", "456"]));
  const chainlink = JSON.stringify(rtdsSubscription("chainlink"));
  const binance = JSON.stringify(rtdsSubscription("binance"));
  for (const payload of [clob, chainlink, binance]) {
    assert.doesNotMatch(payload, /auth|wallet|api.?key|secret|passphrase/i);
  }
  assert.match(chainlink, /btc\/usd/);
  assert.equal(
    binance,
    '{"action":"subscribe","subscriptions":[{"topic":"crypto_prices","type":"update","filters":"btcusdt"}]}',
  );
  assert.doesNotMatch(binance, /solusdt|ethusdt/);
});

test("order book requires a new snapshot after disconnect", async () => {
  const fixture = JSON.parse(await fixtureText("clob-market-events.json")) as Record<string, unknown>;
  const book = new PublicOrderBook({
    expectedConditionId: "condition-1",
    expectedAssetIds: ["token-up", "token-down"],
    staleAfterMilliseconds: 1_000,
  });
  book.connected("connection-1", "2026-07-15T00:00:00.000Z");
  assert.equal(book.state, BookState.WAITING_FOR_SNAPSHOT);
  book.applySnapshot(
    parseClobMarketMessage(JSON.stringify(fixture.book_up)),
    "connection-1",
    "2026-07-15T00:00:00.100Z",
  );
  book.applySnapshot(
    parseClobMarketMessage(JSON.stringify(fixture.book_down)),
    "connection-1",
    "2026-07-15T00:00:00.200Z",
  );
  assert.equal(book.state, BookState.ACTIVE_UNVERIFIED);
  book.applyPriceChange(
    parseClobMarketMessage(JSON.stringify(fixture.price_change)),
    "connection-1",
    "2026-07-15T00:00:00.300Z",
  );
  assert.equal(book.bestAsk("token-up"), "0.53");
  assert.equal(book.bestBid("token-down"), "0.5");
  book.disconnected();
  assert.equal(book.bestAsk("token-up"), null);
  book.connected("connection-2", "2026-07-15T00:00:00.400Z");
  assert.throws(
    () => book.applyPriceChange(
      parseClobMarketMessage(JSON.stringify(fixture.price_change)),
      "connection-2",
      "2026-07-15T00:00:00.500Z",
    ),
    /snapshot/i,
  );
});

test("raw writer is durable, idempotent per event ID, and never overwrites a segment", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "poly-raw-writer-"));
  try {
    const rawPayload = "{\"event_type\":\"future_event\",\"value\":\"1.00\"}";
    const draft = createEnvelopeDraft({
      eventId: "evt-1",
      source: "fixture.source",
      stream: "fixture-stream",
      eventType: "future_event",
      connectionId: "connection-1",
      subscriptionId: "subscription-1",
      receiveTime: "2026-07-15T00:00:00.100Z",
      processTime: "2026-07-15T00:00:00.200Z",
      rawPayload,
      parserStatus: "unparsed",
    });
    assert.equal("persist_time" in draft, false);
    const writer = await RawSegmentWriter.open({
      dataRoot,
      segmentId: "segment-1",
      source: "fixture.source",
      stream: "fixture-stream",
      partitionDate: "2026-07-15",
      clock: () => "2026-07-15T00:00:00.300Z",
    });
    const first = await writer.append(draft);
    const duplicate = await writer.append(draft);
    assert.equal(first.ordinal, duplicate.ordinal);
    const closed = await writer.close();
    assert.equal(closed.eventCount, 1);
    assert.equal(closed.continuity, "UNVERIFIED");
    await assert.rejects(writer.append(draft), /CLOSED/);
    await assert.rejects(
      RawSegmentWriter.open({
        dataRoot,
        segmentId: "segment-1",
        source: "fixture.source",
        stream: "fixture-stream",
        partitionDate: "2026-07-15",
        clock: () => "2026-07-15T00:00:00.400Z",
      }),
      /exist/i,
    );
    const manifest = await new DatasetManifestWriter(dataRoot).publish({
      datasetId: "dataset-1",
      source: "fixture.source",
      stream: "fixture-stream",
      subscription: { topic: "public-fixture" },
      collectorGitCommit: "a".repeat(40),
      collectionStart: "2026-07-15T00:00:00.000Z",
      collectionEnd: "2026-07-15T00:00:01.000Z",
      segments: [closed],
      sanitizedConfig: { endpointClass: "public" },
    });
    assert.equal(manifest.event_count, 1);
    assert.equal(manifest.continuity, "UNVERIFIED");
    await assert.rejects(
      new DatasetManifestWriter(dataRoot).publish({
        datasetId: "dataset-1",
        source: "fixture.source",
        stream: "fixture-stream",
        subscription: { topic: "public-fixture" },
        collectorGitCommit: "a".repeat(40),
        collectionStart: "2026-07-15T00:00:00.000Z",
        collectionEnd: "2026-07-15T00:00:01.000Z",
        segments: [closed],
        sanitizedConfig: { endpointClass: "public" },
      }),
      /exist/i,
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("raw writer preserves repeated payload observations with distinct event IDs", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "poly-raw-duplicates-"));
  try {
    const common = {
      source: "fixture.source",
      stream: "fixture-stream",
      eventType: "price_update",
      connectionId: "connection-1",
      subscriptionId: "subscription-1",
      receiveTime: "2026-07-15T00:00:00.100Z",
      processTime: "2026-07-15T00:00:00.200Z",
      rawPayload: "{\"value\":\"1.2300\"}",
      parserStatus: "parsed" as const,
    };
    const writer = await RawSegmentWriter.open({
      dataRoot,
      segmentId: "segment-duplicates",
      source: "fixture.source",
      stream: "fixture-stream",
      partitionDate: "2026-07-15",
      clock: () => "2026-07-15T00:00:00.300Z",
    });
    await writer.append(createEnvelopeDraft({ ...common, eventId: "evt-a" }));
    await writer.append(createEnvelopeDraft({ ...common, eventId: "evt-b" }));
    const closed = await writer.close();
    assert.equal(closed.eventCount, 2);
    const lines = (await readFile(join(dataRoot, closed.relativePath), "utf8")).trimEnd().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(parsePersistedEnvelope(lines[0] ?? "").raw_sha256, parsePersistedEnvelope(lines[1] ?? "").raw_sha256);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
