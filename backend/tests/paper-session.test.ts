import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FilePaperSessionStateStore,
  InMemoryPaperSessionStateStore,
  PaperSessionService,
  type CallerManagedPublicMarketAdapter,
} from "../paper-session/index.js";
import type { PaperMarketSnapshotV1, PaperOrderRequestV1, PaperOrderRequestV2, PaperRiskConfigV1 } from "../paper-simulation/index.js";

const NOW = "2026-07-21T11:00:00.000Z";
const snapshot: PaperMarketSnapshotV1 = {
  schemaVersion: "paper-market-snapshot-v1", marketId: "btc-5m-session", observedAtUtc: "2026-07-21T10:59:59.900Z",
  receivedAtUtc: "2026-07-21T10:59:59.950Z", eligible: true,
  yesAsks: [{ price: "0.5", quantity: "10" }], noAsks: [{ price: "0.49", quantity: "10" }],
};
const risk: PaperRiskConfigV1 = {
  schemaVersion: "paper-risk-config-v1", maximumQuoteAgeMs: 1_000, minimumNetEdge: "0.01",
  maximumOrderNotional: "100", maximumMarketExposure: "100", maximumTotalExposure: "100",
};
const order: PaperOrderRequestV1 = {
  schemaVersion: "paper-order-request-v1", idempotencyKey: "session-idem", clientOrderId: "session-client",
  marketId: "btc-5m-session", token: "YES", limitPrice: "0.5", quantity: "2", timeInForce: "GTC",
  expiresAtUtc: null, modelProbabilityYes: "0.7", feeRate: "0.01",
};
const evidenceOrder: PaperOrderRequestV2 = {
  schemaVersion: "paper-order-request-v2", idempotencyKey: "session-v2-idem", clientOrderId: "session-v2-client",
  marketId: "btc-5m-session", token: "YES", limitPrice: "0.5", quantity: "2", timeInForce: "FAK",
  expiresAtUtc: null, modelProbabilityYes: "0.7",
  feeEvidence: {
    schemaVersion: "paper-fee-evidence-v1", model: "POLYMARKET_TAKER_CURVE_V1", conditionId: "condition-session",
    rate: "0.02", effectiveFromUtc: "2026-07-21T10:00:00.000Z", effectiveToUtc: "2026-07-21T12:00:00.000Z",
    evidenceStatus: "VERIFIED", evidenceReference: "offline-fixture:session-fee",
  },
};
function adapter(ready = true): CallerManagedPublicMarketAdapter {
  return { adapterId: "public-test-adapter", source: "PUBLIC_MARKET_DATA", lifecycle: "CALLER_MANAGED", isReady: () => ready, latest: (marketId) => marketId === snapshot.marketId ? snapshot : null };
}

test("session facade starts, stops, resumes, lists and persists an engine without owning collection", async () => {
  const store = new InMemoryPaperSessionStateStore(); const service = new PaperSessionService(adapter(), store); await service.initialize();
  const started = await service.start({ schemaVersion: "paper-session-start-v1", sessionId: "session-1", initialCash: "100", risk, startedAtUtc: NOW });
  assert.equal(started.status, "RUNNING"); assert.equal(started.adapterId, "public-test-adapter");
  assert.equal((await service.submitOrder("session-1", order, NOW)).status, "FILLED");
  assert.equal((await service.stop("session-1", "2026-07-21T11:01:00.000Z")).status, "STOPPED");
  await assert.rejects(service.submitOrder("session-1", { ...order, idempotencyKey: "stopped" }, NOW), /stopped/);
  assert.equal((await service.resume("session-1", "2026-07-21T11:02:00.000Z")).status, "RUNNING");
  assert.deepEqual((await service.list()).map((value) => value.sessionId), ["session-1"]);
  const freshFacade = new PaperSessionService(adapter(), store); await freshFacade.initialize();
  assert.equal((await freshFacade.status("session-1")).fillCount, 1); assert.equal((await freshFacade.exportSession("session-1")).simulation.fills.length, 1);
});

test("start and resume fail closed when caller-managed public adapter is unavailable", async () => {
  const store = new InMemoryPaperSessionStateStore(); const unavailable = new PaperSessionService(adapter(false), store); await unavailable.initialize();
  await assert.rejects(unavailable.start({ schemaVersion: "paper-session-start-v1", sessionId: "no-feed", initialCash: "100", risk, startedAtUtc: NOW }), /does not start collection/);
  const ready = new PaperSessionService(adapter(), store); await ready.initialize();
  await ready.start({ schemaVersion: "paper-session-start-v1", sessionId: "resume-feed", initialCash: "100", risk, startedAtUtc: NOW }); await ready.stop("resume-feed", NOW);
  const cannotResume = new PaperSessionService(adapter(false), store); await cannotResume.initialize(); await assert.rejects(cannotResume.resume("resume-feed", NOW), /does not start collection/);
});

test("system kill switch persists, reaches all sessions and blocks paper orders after recovery", async () => {
  const store = new InMemoryPaperSessionStateStore(); const first = new PaperSessionService(adapter(), store); await first.initialize();
  await first.start({ schemaVersion: "paper-session-start-v1", sessionId: "kill-1", initialCash: "100", risk, startedAtUtc: NOW });
  const controller = new PaperSessionService(adapter(), store); await controller.initialize();
  const control = await controller.setSystemKillSwitch(true, "2026-07-21T11:03:00.000Z", "OPERATOR_EMERGENCY"); assert.equal(control.killSwitchEnabled, true);
  assert.equal((await controller.status("kill-1")).systemKillSwitchEnabled, true);
  const second = new PaperSessionService(adapter(), store); await second.initialize(); assert.equal(second.systemStatus().killSwitchEnabled, true);
  const rejected = await second.submitOrder("kill-1", { ...order, idempotencyKey: "after-kill" }, "2026-07-21T11:03:00.000Z");
  assert.equal(rejected.rejectionReason, "KILL_SWITCH_ENABLED");
  await second.setSystemKillSwitch(false, "2026-07-21T11:04:00.000Z", "OPERATOR_RECOVERY");
  assert.equal((await second.status("kill-1")).systemKillSwitchEnabled, false);
});

test("file paper store restores sessions and the system kill switch across backend commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "paper-session-file-")); const store = new FilePaperSessionStateStore(root);
  const first = new PaperSessionService(adapter(), store); await first.initialize();
  await first.start({ schemaVersion: "paper-session-start-v1", sessionId: "durable-1", initialCash: "100", risk, startedAtUtc: NOW });
  await first.setSystemKillSwitch(true, "2026-07-21T11:05:00.000Z", "DURABLE_EMERGENCY");
  const restored = new PaperSessionService(adapter(), new FilePaperSessionStateStore(root)); await restored.initialize();
  assert.equal(restored.systemStatus().killSwitchEnabled, true); assert.deepEqual((await restored.list()).map((value) => value.sessionId), ["durable-1"]);
  assert.equal((await restored.status("durable-1")).systemKillSwitchEnabled, true);
});

test("file paper store recovers a v2 evidence-fee order and replays its idempotency key", async () => {
  const root = await mkdtemp(join(tmpdir(), "paper-session-v2-file-"));
  const first = new PaperSessionService(adapter(), new FilePaperSessionStateStore(root)); await first.initialize();
  await first.start({ schemaVersion: "paper-session-start-v1", sessionId: "durable-v2", initialCash: "100", risk, startedAtUtc: NOW });
  const submitted = await first.submitOrder("durable-v2", evidenceOrder, NOW);
  assert.equal(submitted.status, "FILLED");
  assert.equal((await first.detail("durable-v2")).fills[0]?.fee, "0.01");
  const restored = new PaperSessionService(adapter(), new FilePaperSessionStateStore(root)); await restored.initialize();
  const replayed = await restored.submitOrder("durable-v2", evidenceOrder, NOW);
  assert.equal(replayed.orderId, submitted.orderId);
  assert.equal((await restored.detail("durable-v2")).fills.length, 1);
});

test("session facade exposes durable order detail, cancel, reprice, expiry and settlement lifecycle", async () => {
  const store = new InMemoryPaperSessionStateStore(); const service = new PaperSessionService(adapter(), store); await service.initialize();
  const lifecycleRisk = { ...risk, maximumQuoteAgeMs: 600_000 };
  await service.start({ schemaVersion: "paper-session-start-v1", sessionId: "lifecycle-1", initialCash: "100", risk: lifecycleRisk, startedAtUtc: NOW });
  const open = await service.submitOrder("lifecycle-1", { ...order, idempotencyKey: "open-idem", clientOrderId: "open-client", limitPrice: "0.4", timeInForce: "GTC" }, NOW);
  assert.equal(open.status, "OPEN");
  assert.equal((await service.cancelOrder("lifecycle-1", open.orderId, "2026-07-21T11:01:00.000Z", "OPERATOR_CANCEL")).status, "CANCELLED");
  const repricedBase = await service.submitOrder("lifecycle-1", { ...order, idempotencyKey: "reprice-base", clientOrderId: "reprice-base", limitPrice: "0.4", timeInForce: "GTC" }, "2026-07-21T11:02:00.000Z");
  const repriced = await service.repriceOrder("lifecycle-1", repricedBase.orderId, { ...order, idempotencyKey: "reprice-next", clientOrderId: "reprice-next" }, "2026-07-21T11:03:00.000Z");
  assert.equal(repriced.status, "FILLED");
  const gtd = await service.submitOrder("lifecycle-1", { ...order, idempotencyKey: "gtd-idem", clientOrderId: "gtd-client", limitPrice: "0.4", timeInForce: "GTD", expiresAtUtc: "2026-07-21T11:04:00.000Z" }, "2026-07-21T11:03:30.000Z");
  assert.equal(gtd.status, "OPEN");
  assert.deepEqual((await service.expireOrders("lifecycle-1", "2026-07-21T11:04:00.000Z")).map((value) => value.orderId), [gtd.orderId]);
  const settlement = await service.settleMarket("lifecycle-1", snapshot.marketId, "YES", "2026-07-21T11:05:00.000Z");
  assert.equal(settlement.payout, "2");
  const detail = await service.detail("lifecycle-1");
  assert.equal(detail.schemaVersion, "paper-session-detail-v1");
  assert.equal(detail.orders.length, 4);
  assert.equal(detail.fills.length, 1);
  assert.equal(detail.positions.length, 0);
  assert.equal(detail.settlements.length, 1);
  assert.ok(detail.events.some((event) => event.kind === "ORDER_REPRICED"));
  const restored = new PaperSessionService(adapter(), store); await restored.initialize();
  assert.equal((await restored.detail("lifecycle-1")).settlements.length, 1);
});

test("session snapshot lifecycle rematches durable v2 orders and clock expires GTD without a snapshot", async () => {
  const store = new InMemoryPaperSessionStateStore();
  const first = new PaperSessionService(adapter(), store); await first.initialize();
  await first.start({ schemaVersion: "paper-session-start-v1", sessionId: "snapshot-loop", initialCash: "100", risk: { ...risk, maximumQuoteAgeMs: 600_000 }, startedAtUtc: NOW });
  const resting = await first.submitOrder("snapshot-loop", { ...evidenceOrder, idempotencyKey: "durable-rest", clientOrderId: "durable-rest", timeInForce: "GTC", limitPrice: "0.4" }, NOW);
  const gtd = await first.submitOrder("snapshot-loop", { ...evidenceOrder, idempotencyKey: "clock-gtd", clientOrderId: "clock-gtd", timeInForce: "GTD", limitPrice: "0.4", expiresAtUtc: "2026-07-21T11:01:00.000Z" }, NOW);
  assert.equal(resting.status, "OPEN"); assert.equal(gtd.status, "OPEN");

  const restored = new PaperSessionService(adapter(), store); await restored.initialize();
  const changed = await restored.processSnapshot({ ...snapshot, observedAtUtc: "2026-07-21T11:00:30.000Z", receivedAtUtc: "2026-07-21T11:00:30.000Z", yesAsks: [{ price: "0.4", quantity: "2" }] }, "2026-07-21T11:00:30.000Z");
  assert.equal(changed["snapshot-loop"]?.[0]?.orderId, resting.orderId);
  assert.equal((await restored.detail("snapshot-loop")).orders.find((value) => value.orderId === resting.orderId)?.status, "FILLED");
  const expired = await restored.processClock("2026-07-21T11:01:00.000Z");
  assert.equal(expired["snapshot-loop"]?.[0]?.orderId, gtd.orderId);
  const replay = await restored.submitOrder("snapshot-loop", { ...evidenceOrder, idempotencyKey: "durable-rest", clientOrderId: "durable-rest", timeInForce: "GTC", limitPrice: "0.4" }, "2026-07-21T11:01:01.000Z");
  assert.equal(replay.orderId, resting.orderId);
});
