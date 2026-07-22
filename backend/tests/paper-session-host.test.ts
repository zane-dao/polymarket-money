import assert from "node:assert/strict";
import test from "node:test";

import {
  PaperMarketHost,
  type PublicPaperFeedObserver,
  type PublicPaperMarketFeed,
} from "../paper-session/index.js";
import type { PaperMarketSnapshotV1 } from "../paper-simulation/index.js";

const NOW = "2026-07-21T12:00:00.000Z";

function snapshot(marketId: string, receivedAtUtc = NOW): PaperMarketSnapshotV1 {
  return {
    schemaVersion: "paper-market-snapshot-v1",
    marketId,
    observedAtUtc: "2026-07-21T11:59:59.900Z",
    receivedAtUtc,
    eligible: true,
    yesAsks: [{ price: "0.5", quantity: "10" }],
    noAsks: [{ price: "0.49", quantity: "10" }],
  };
}

class FakePublicFeed implements PublicPaperMarketFeed {
  readonly feedId = "fake-public-feed";
  readonly source = "PUBLIC_MARKET_DATA" as const;
  readonly access = "READ_ONLY" as const;
  observer: PublicPaperFeedObserver | null = null;
  starts = 0;
  stops = 0;
  async start(observer: PublicPaperFeedObserver): Promise<void> { this.starts += 1; this.observer = observer; }
  async stop(): Promise<void> { this.stops += 1; this.observer = null; }
}

test("paper market host is inert until explicitly started and becomes a session adapter after a public snapshot", async () => {
  const feed = new FakePublicFeed();
  const host = new PaperMarketHost(feed, { hostId: "paper-host-test", now: () => NOW });
  assert.equal(feed.starts, 0);
  assert.equal(host.status().executionMode, "PAPER_ONLY");
  assert.equal(host.isReady(), false);

  assert.equal((await host.start()).lifecycle, "RUNNING");
  assert.equal(host.isReady(), false);
  feed.observer?.connection(true, NOW, "public websocket connected");
  feed.observer?.snapshot(snapshot("btc-5m-a"));

  assert.equal(host.isReady(), true);
  assert.deepEqual(host.latest("btc-5m-a"), snapshot("btc-5m-a"));
  assert.equal(host.status().snapshotCount, 1);
  assert.equal((await host.stop()).lifecycle, "STOPPED");
  assert.equal(host.isReady(), false);
  assert.equal(feed.stops, 1);
});

test("host bounds snapshot and health caches while preserving cumulative gap and error counters", async () => {
  const feed = new FakePublicFeed();
  const host = new PaperMarketHost(feed, {
    hostId: "bounded-paper-host",
    maximumCachedMarkets: 2,
    maximumHealthEvents: 2,
    now: () => NOW,
  });
  await host.start();
  feed.observer?.connection(true, NOW, "connected");
  feed.observer?.snapshot(snapshot("btc-5m-a"));
  feed.observer?.snapshot(snapshot("btc-5m-b"));
  feed.observer?.snapshot(snapshot("btc-5m-c"));
  feed.observer?.gap("btc-5m-c", "2026-07-21T12:00:01.000Z", "sequence discontinuity");
  feed.observer?.error(new Error("feed decode failure"), "2026-07-21T12:00:02.000Z");

  const status = host.status();
  assert.equal(host.latest("btc-5m-a"), null);
  assert.equal(status.cachedMarketCount, 2);
  assert.equal(status.snapshotCount, 3);
  assert.equal(status.gapCount, 1);
  assert.equal(status.errorCount, 1);
  assert.equal(status.connection, "DEGRADED");
  assert.deepEqual(status.events.map((event) => event.kind), ["GAP", "ERROR"]);
  assert.equal(status.ready, false);
});

test("late feed callbacks are ignored after caller stop and invalid snapshots fail closed as health errors", async () => {
  const feed = new FakePublicFeed();
  const host = new PaperMarketHost(feed, { hostId: "generation-paper-host", now: () => NOW });
  await host.start();
  const oldObserver = feed.observer;
  oldObserver?.connection(true, NOW, "connected");
  oldObserver?.snapshot({ ...snapshot("btc-5m-bad"), receivedAtUtc: "2026-07-21T11:59:00.000Z" });
  assert.equal(host.status().errorCount, 1);
  assert.equal(host.latest("btc-5m-bad"), null);

  await host.stop();
  oldObserver?.snapshot(snapshot("btc-5m-late"));
  assert.equal(host.latest("btc-5m-late"), null);
});

test("feed start failures move host to failed without inventing a ready market", async () => {
  const feed: PublicPaperMarketFeed = {
    feedId: "failing-public-feed",
    source: "PUBLIC_MARKET_DATA",
    access: "READ_ONLY",
    async start(): Promise<void> { throw new Error("offline fixture failure"); },
    async stop(): Promise<void> {},
  };
  const host = new PaperMarketHost(feed, { hostId: "failed-paper-host", now: () => NOW });
  await assert.rejects(host.start(), /offline fixture failure/);
  assert.equal(host.status().lifecycle, "FAILED");
  assert.equal(host.status().errorCount, 1);
  assert.equal(host.isReady(), false);
});

test("host readiness and latest snapshot fail closed after the configured age", async () => {
  const feed = new FakePublicFeed(); let now = NOW;
  const host = new PaperMarketHost(feed, { hostId: "stale-paper-host", maximumSnapshotAgeMs: 1_000, now: () => now });
  await host.start(); feed.observer?.connection(true, NOW, "connected"); feed.observer?.snapshot(snapshot("btc-5m-stale"));
  assert.equal(host.isReady(), true); assert.notEqual(host.latest("btc-5m-stale"), null);
  now = "2026-07-21T12:00:01.001Z";
  assert.equal(host.isReady(), false); assert.equal(host.latest("btc-5m-stale"), null);
});
