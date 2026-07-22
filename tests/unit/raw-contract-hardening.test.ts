import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createEnvelopeDraft,
  parsePersistedEnvelope,
} from "../../backend/core/src/domain/raw-event.js";

const root = new URL("../../../", import.meta.url);

test("RawEventEnvelope rejects invalid calendars and non-canonical timestamp variants", async () => {
  const line = (await readFile(new URL("data/fixtures/batch-2/raw-event-v1.golden.jsonl", root), "utf8")).trimEnd();
  const baseline = JSON.parse(line) as Record<string, unknown>;
  for (const timestamp of [
    "2026-02-30T00:00:00.100Z",
    "2026-07-15T00:00:00Z",
    "2026-07-15T00:00:00.1Z",
    "2026-07-15 00:00:00.100Z",
    "20260715T000000.100Z",
    "2026-07-15T00:00:00.100+00:00",
  ]) {
    assert.throws(
      () => parsePersistedEnvelope(JSON.stringify({ ...baseline, receive_time: timestamp })),
      /canonical UTC|calendar/i,
      timestamp,
    );
  }
});

test("local clock causality is compared at the contract millisecond precision", () => {
  assert.throws(
    () => createEnvelopeDraft({
      eventId: "clock-order",
      source: "fixture.source",
      stream: "fixture-stream",
      eventType: "fixture",
      connectionId: "fixture-connection",
      subscriptionId: "fixture-subscription",
      receiveTime: "2026-07-15T00:00:00.101Z",
      processTime: "2026-07-15T00:00:00.100Z",
      rawPayload: "{}",
      parserStatus: "parsed",
    }),
    /must not precede/,
  );
});
