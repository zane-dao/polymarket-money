import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ReceiveClock,
  compareReceiveStamps,
  receiveStampAtOrBefore,
} from "../../execution/src/domain/receive-time.js";
import {
  createEnvelopeDraftV2,
  parsePersistedEnvelope,
  requireSubsecondReceiveStamp,
} from "../../execution/src/domain/raw-event.js";

const root = new URL("../../../", import.meta.url);

test("same monotonic nanosecond is ordered by the domain-wide ordinal", () => {
  const clock = new ReceiveClock({
    clockDomain: "process-session-1",
    wallNow: () => "2026-07-16T00:00:00.000Z",
    monotonicNowNs: () => 1_000n,
  });
  const first = clock.capture();
  const second = clock.capture();
  assert.equal(first.localMonotonicReceiveNs, "1000");
  assert.equal(first.localReceiveOrdinal, "1");
  assert.equal(second.localReceiveOrdinal, "2");
  assert.equal(compareReceiveStamps(first, second), -1);
  assert.equal(receiveStampAtOrBefore(first, first), true);
  assert.equal(receiveStampAtOrBefore(second, first), false);
});

test("ReceiveStamp from another clock domain is not comparable", () => {
  const left = new ReceiveClock({
    clockDomain: "process-a",
    wallNow: () => "2026-07-16T00:00:00.000Z",
    monotonicNowNs: () => 1n,
  }).capture();
  const right = new ReceiveClock({
    clockDomain: "process-b",
    wallNow: () => "2026-07-16T00:00:00.000Z",
    monotonicNowNs: () => 1n,
  }).capture();
  assert.throws(() => compareReceiveStamps(left, right), /clock domain/i);
});

test("raw-event-v2 carries the full ReceiveStamp and v1 is ineligible for subsecond work", async () => {
  const stamp = new ReceiveClock({
    clockDomain: "process-session-1",
    wallNow: () => "2026-07-16T00:00:00.100Z",
    monotonicNowNs: () => 42n,
  }).capture();
  const draft = createEnvelopeDraftV2({
    eventId: "event-v2",
    source: "binance.spot",
    stream: "book-ticker",
    eventType: "book_ticker",
    transportConnectionId: "external-connection-1",
    subscriptionId: "subscription-1",
    receiveStamp: stamp,
    processTime: "2026-07-16T00:00:00.101Z",
    providerSourceTime: null,
    providerServerTime: null,
    rawPayload: "{}",
    parserStatus: "parsed",
  });
  assert.equal(draft.schema_version, "raw-event-v2");
  assert.equal(draft.clock_domain, "process-session-1");
  assert.equal(draft.local_monotonic_receive_ns, "42");
  assert.equal(draft.local_receive_ordinal, "1");
  assert.equal(requireSubsecondReceiveStamp(draft).clockDomain, "process-session-1");

  const line = (await readFile(
    new URL("data/fixtures/batch-2/raw-event-v1.golden.jsonl", root),
    "utf8",
  )).trimEnd();
  const historical = parsePersistedEnvelope(line);
  assert.throws(() => requireSubsecondReceiveStamp(historical), /raw-event-v1.*subsecond/i);
});
