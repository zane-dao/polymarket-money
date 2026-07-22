import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  capturePublicSocket,
  fetchPublicMarketBySlug,
  type CapturedFrame,
  type PublicHttpRuntime,
  type PublicSocketRuntime,
} from "../../backend/core/src/adapters/market-data/public-sources.js";
import {
  createEnvelopeDraft,
  createEnvelopeDraftV2,
} from "../../backend/core/src/domain/raw-event.js";
import { ReceiveClock } from "../../backend/core/src/domain/receive-time.js";
import { RawSegmentWriter } from "../../backend/core/src/storage/raw-segment.js";

class FakeSocket extends EventTarget {
  readyState = 1;
  send(): void {}
  close(): void { this.readyState = 3; }
  emit(type: string, fields: Record<string, unknown> = {}): void {
    const event = new Event(type);
    Object.assign(event, fields);
    this.dispatchEvent(event);
  }
}

test("HTTP and WebSocket capture stamp the shared ReceiveClock at the network boundary", async () => {
  const clock = new ReceiveClock({
    clockDomain: "runtime-process-1",
    wallNow: () => "2026-07-16T00:00:00.000Z",
    monotonicNowNs: (() => {
      let value = 100n;
      return () => value++;
    })(),
  });
  const socket = new FakeSocket();
  const socketRuntime: PublicSocketRuntime = {
    createWebSocket: () => socket as unknown as WebSocket,
    now: () => "2026-07-16T00:00:00.000Z",
    receiveClock: clock,
  };
  const captured: CapturedFrame[] = [];
  const capture = capturePublicSocket({
    source: "binance-spot-book",
    timeoutMilliseconds: 1000,
    maxFrames: 1,
    maxFrameBytes: 100,
    maxTotalBytes: 100,
    accept: (frame) => {
      captured.push(frame);
      return Promise.resolve(true);
    },
  }, socketRuntime);
  socket.emit("open");
  socket.emit("message", { data: "{}" });
  await capture;
  assert.equal(captured[0]?.receiveStamp.clockDomain, "runtime-process-1");
  assert.equal(captured[0]?.receiveStamp.localReceiveOrdinal, "1");

  const httpRuntime: PublicHttpRuntime = {
    fetch: () => Promise.resolve(new Response("{}", { status: 200 })),
    now: () => "2026-07-16T00:00:00.000Z",
    receiveClock: clock,
  };
  const response = await fetchPublicMarketBySlug(
    "btc-updown-5m-1775181000",
    {},
    httpRuntime,
  );
  assert.equal(response.receiveStamp.localReceiveOrdinal, "2");
  assert.equal(response.receiveTime, response.receiveStamp.localWallReceiveTime);
});

test("active RawSegmentWriter accepts only raw-event-v2 while v1 stays readable only", async () => {
  const root = await mkdtemp(join(tmpdir(), "poly-r1-v2-"));
  try {
    const writer = await RawSegmentWriter.open({
      dataRoot: root,
      segmentId: "segment-v2",
      source: "binance.spot",
      stream: "book-ticker",
      partitionDate: "2026-07-16",
      clock: () => "2026-07-16T00:00:00.002Z",
    });
    const receiveClock = new ReceiveClock({
      clockDomain: "writer-process-1",
      wallNow: () => "2026-07-16T00:00:00.000Z",
      monotonicNowNs: () => 1000n,
    });
    await writer.append(createEnvelopeDraftV2({
      eventId: "event-v2",
      source: "binance.spot",
      stream: "book-ticker",
      eventType: "book_ticker",
      transportConnectionId: "spot-connection-1",
      subscriptionId: "public-only",
      receiveStamp: receiveClock.capture(),
      processTime: "2026-07-16T00:00:00.001Z",
      rawPayload: "{}",
      parserStatus: "parsed",
    }));
    const closed = await writer.close();
    const line = (await readFile(join(root, closed.relativePath), "utf8")).trim();
    assert.equal((JSON.parse(line) as { schema_version: string }).schema_version, "raw-event-v2");

    const v1Writer = await RawSegmentWriter.open({
      dataRoot: root,
      segmentId: "segment-refuse-v1",
      source: "binance.spot",
      stream: "book-ticker",
      partitionDate: "2026-07-16",
      clock: () => "2026-07-16T00:00:00.002Z",
    });
    await assert.rejects(v1Writer.append(createEnvelopeDraft({
      eventId: "event-v1",
      source: "binance.spot",
      stream: "book-ticker",
      eventType: "book_ticker",
      connectionId: "spot-connection-1",
      subscriptionId: "public-only",
      receiveTime: "2026-07-16T00:00:00.000Z",
      processTime: "2026-07-16T00:00:00.001Z",
      rawPayload: "{}",
      parserStatus: "parsed",
    }) as never), /raw-event-v2|schema/i);
    await v1Writer.leaveIncomplete();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
