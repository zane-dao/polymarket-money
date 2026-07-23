import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FileKJExecutionOutboxStore,
  InMemoryKJExecutionOutboxStore,
  InMemoryPaperSessionStateStore,
  KJPaperExecutionCoordinator,
  PaperSessionService,
  kjExecutionProposalFromEvents,
  type CallerManagedPublicMarketAdapter,
  type KJExecutionOutboxRecordV1,
  type KJExecutionOutboxStore,
  type KJExecutionProposalV1,
} from "../paper-session/index.js";
import type { KJPaperEvent, KJPaperStrategy } from "../core/src/runtime/kj-paper-engine.js";
import type { PaperMarketSnapshotV1, PaperRiskConfigV1 } from "../paper-simulation/index.js";

const NOW = "2026-07-22T10:00:00.000Z";
const HASH_A = "a".repeat(64); const HASH_B = "b".repeat(64); const HASH_C = "c".repeat(64);
const snapshot: PaperMarketSnapshotV1 = {
  schemaVersion: "paper-market-snapshot-v1", marketId: "btc-5m-coordinate", observedAtUtc: "2026-07-22T09:59:59.800Z",
  receivedAtUtc: "2026-07-22T09:59:59.900Z", eligible: true,
  yesAsks: [{ price: "0.5", quantity: "1" }], noAsks: [{ price: "0.48", quantity: "1" }],
};
const risk: PaperRiskConfigV1 = {
  schemaVersion: "paper-risk-config-v1", maximumQuoteAgeMs: 1_000, minimumNetEdge: "0.01",
  maximumOrderNotional: "100", maximumMarketExposure: "100", maximumTotalExposure: "100",
};
function adapter(ready = true): CallerManagedPublicMarketAdapter {
  return { adapterId: "coordinate-adapter", source: "PUBLIC_MARKET_DATA", lifecycle: "CALLER_MANAGED", isReady: () => ready, latest: (marketId) => ready && marketId === snapshot.marketId ? snapshot : null };
}
function proposal(strategy: KJPaperStrategy, intentId: string, overrides: Partial<KJExecutionProposalV1> = {}): KJExecutionProposalV1 {
  return {
    schemaVersion: "kj-execution-proposal-v1", intentId, proposalEventId: HASH_B, contextHash: HASH_C,
    strategy, marketId: snapshot.marketId, outcome: "UP", sideProbability: "0.8", maximumFillPrice: "0.5",
    quantity: "2", proposedAtUtc: NOW,
    feeEvidence: {
      schemaVersion: "paper-fee-evidence-v1", model: "POLYMARKET_TAKER_CURVE_V1", conditionId: "condition-coordinate",
      rate: "0.02", effectiveFromUtc: "2026-07-22T09:00:00.000Z", effectiveToUtc: "2026-07-22T11:00:00.000Z",
      evidenceStatus: "VERIFIED", evidenceReference: "offline-fixture:coordinate-fee",
    },
    ...overrides,
  };
}
async function paper(store = new InMemoryPaperSessionStateStore(), ready = true): Promise<{ service: PaperSessionService; store: InMemoryPaperSessionStateStore }> {
  const service = new PaperSessionService(adapter(ready), store); await service.initialize();
  return { service, store };
}
async function startAccounts(service: PaperSessionService): Promise<void> {
  for (const sessionId of ["canonical-j", "canonical-k"]) await service.start({ schemaVersion: "paper-session-start-v1", sessionId, initialCash: "100", risk, startedAtUtc: NOW });
}
const accounts = { J_FEE_AWARE: "canonical-j", K_DUAL_VOL: "canonical-k" } as const;

test("coordinator routes J and K to isolated canonical sessions and records partial FAK execution", async () => {
  const { service } = await paper(); await startAccounts(service);
  const outbox = new InMemoryKJExecutionOutboxStore(); const coordinator = new KJPaperExecutionCoordinator(service, outbox, accounts); await coordinator.initialize();
  const j = await coordinator.coordinate(proposal("J_FEE_AWARE", HASH_A));
  const k = await coordinator.coordinate(proposal("K_DUAL_VOL", "d".repeat(64), { outcome: "DOWN", sideProbability: "0.7", maximumFillPrice: "0.48" }));
  assert.equal(j.sessionId, "canonical-j"); assert.equal(k.sessionId, "canonical-k");
  assert.equal(j.request.schemaVersion, "paper-order-request-v2"); assert.equal(j.request.timeInForce, "FAK");
  assert.equal(k.request.token, "NO"); assert.equal(k.request.modelProbabilityYes, "0.3");
  assert.equal(j.paperOrderStatus, "CANCELLED");
  assert.equal((await service.detail("canonical-j")).fills[0]?.quantity, "1");
  assert.equal((await service.detail("canonical-k")).fills[0]?.quantity, "1");
  assert.equal((await service.detail("canonical-j")).orders.length, 1);
  assert.equal(outbox.records.length, 4);
  assert.equal(outbox.records[1]?.previousRecordHash, outbox.records[0]?.recordHash);
});

test("same intent is idempotent while conflicting proposal content fails closed", async () => {
  const { service } = await paper(); await startAccounts(service);
  const coordinator = new KJPaperExecutionCoordinator(service, new InMemoryKJExecutionOutboxStore(), accounts); await coordinator.initialize();
  const input = proposal("J_FEE_AWARE", HASH_A); const first = await coordinator.coordinate(input); const replay = await coordinator.coordinate(input);
  assert.equal(replay.paperOrderId, first.paperOrderId);
  assert.equal((await service.detail("canonical-j")).orders.length, 1);
  await assert.rejects(coordinator.coordinate({ ...input, quantity: "1" }), /conflicting proposal/);
});

test("kill switch and canonical risk rejection remain authoritative outcomes", async () => {
  const { service } = await paper(); await startAccounts(service);
  await service.setSystemKillSwitch(true, NOW, "OFFLINE_TEST_STOP");
  const coordinator = new KJPaperExecutionCoordinator(service, new InMemoryKJExecutionOutboxStore(), accounts); await coordinator.initialize();
  const killed = await coordinator.coordinate(proposal("J_FEE_AWARE", HASH_A));
  assert.equal(killed.paperOrderStatus, "REJECTED"); assert.equal(killed.rejectionReason, "KILL_SWITCH_ENABLED");
  await service.setSystemKillSwitch(false, NOW, "OFFLINE_TEST_RESUME");
  const rejected = await coordinator.coordinate(proposal("K_DUAL_VOL", "d".repeat(64), { sideProbability: "0.51" }));
  assert.equal(rejected.paperOrderStatus, "REJECTED"); assert.equal(rejected.rejectionReason, "INSUFFICIENT_EDGE_AFTER_FEES");
});

class FailSecondAppendStore implements KJExecutionOutboxStore {
  readonly records: KJExecutionOutboxRecordV1[] = [];
  #attempt = 0;
  async load(): Promise<readonly KJExecutionOutboxRecordV1[]> { return structuredClone(this.records); }
  async append(record: KJExecutionOutboxRecordV1): Promise<void> {
    this.#attempt += 1;
    if (this.#attempt === 2) throw new Error("injected terminal ack failure");
    this.records.push(structuredClone(record));
  }
}

test("recovery replays submit-after-ack crash through canonical idempotency even without a live adapter", async () => {
  const state = new InMemoryPaperSessionStateStore(); const first = await paper(state); await startAccounts(first.service);
  const outbox = new FailSecondAppendStore(); const crashed = new KJPaperExecutionCoordinator(first.service, outbox, accounts); await crashed.initialize();
  await assert.rejects(crashed.coordinate(proposal("J_FEE_AWARE", HASH_A)), /terminal ack failure/);
  assert.equal((await first.service.detail("canonical-j")).orders.length, 1); assert.equal(outbox.records.length, 1);

  const recoveredPaper = await paper(state, false);
  const recovered = new KJPaperExecutionCoordinator(recoveredPaper.service, outbox, accounts); await recovered.initialize();
  assert.equal(recovered.links()[0]?.state, "SUBMITTED");
  assert.equal((await recoveredPaper.service.detail("canonical-j")).orders.length, 1);
  assert.equal(outbox.records.length, 2);
});

test("file outbox persists a verifiable hash chain and restores terminal links", async () => {
  const root = await mkdtemp(join(tmpdir(), "kj-execution-outbox-")); const { service } = await paper(); await startAccounts(service);
  const coordinator = new KJPaperExecutionCoordinator(service, new FileKJExecutionOutboxStore(root), accounts); await coordinator.initialize();
  await coordinator.coordinate(proposal("J_FEE_AWARE", HASH_A));
  const lines = (await readFile(join(root, "workbench", "paper-sessions", "kj-execution-links.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  const records = lines.map((line) => JSON.parse(line) as KJExecutionOutboxRecordV1);
  assert.equal(records[1]?.previousRecordHash, records[0]?.recordHash);
  await coordinator.close();
  await assert.rejects(coordinator.coordinate(proposal("K_DUAL_VOL", "d".repeat(64))), /coordinator is closed/u);
  const restored = new KJPaperExecutionCoordinator(service, new FileKJExecutionOutboxStore(root), accounts); await restored.initialize();
  assert.equal(restored.links()[0]?.state, "SUBMITTED");
  await restored.close();
});

test("recovery keeps historical runner sessions while new proposals use the current accounts", async () => {
  const { service } = await paper();
  const historical = { J_FEE_AWARE: "historical-runner-j", K_DUAL_VOL: "historical-runner-k" } as const;
  const current = { J_FEE_AWARE: "current-runner-j", K_DUAL_VOL: "current-runner-k" } as const;
  for (const sessionId of [...Object.values(historical), ...Object.values(current)]) {
    await service.start({ schemaVersion: "paper-session-start-v1", sessionId, initialCash: "100", risk, startedAtUtc: NOW });
  }
  const outbox = new InMemoryKJExecutionOutboxStore();
  const first = new KJPaperExecutionCoordinator(service, outbox, historical); await first.initialize();
  await first.coordinate(proposal("J_FEE_AWARE", HASH_A));

  const recovered = new KJPaperExecutionCoordinator(service, outbox, current); await recovered.initialize();
  assert.equal(recovered.links()[0]?.sessionId, historical.J_FEE_AWARE);
  const next = await recovered.coordinate(proposal("K_DUAL_VOL", "d".repeat(64)));
  assert.equal(next.sessionId, current.K_DUAL_VOL);
});

test("recovery rejects an outbox whose historical Paper session is missing", async () => {
  const first = await paper(); await startAccounts(first.service);
  const outbox = new InMemoryKJExecutionOutboxStore();
  const coordinator = new KJPaperExecutionCoordinator(first.service, outbox, accounts); await coordinator.initialize();
  await coordinator.coordinate(proposal("J_FEE_AWARE", HASH_A));

  const empty = await paper();
  await assert.rejects(
    new KJPaperExecutionCoordinator(empty.service, outbox, accounts).initialize(),
    /references missing Paper session: canonical-j/u,
  );
});

test("recovery rejects a hash-tampered outbox before replaying an order", async () => {
  const { service } = await paper(); await startAccounts(service);
  const source = new InMemoryKJExecutionOutboxStore(); const first = new KJPaperExecutionCoordinator(service, source, accounts); await first.initialize();
  await first.coordinate(proposal("J_FEE_AWARE", HASH_A));
  const tampered = new InMemoryKJExecutionOutboxStore(); tampered.records.push(...structuredClone(source.records));
  tampered.records[0] = { ...tampered.records[0]!, link: { ...tampered.records[0]!.link, sessionId: "canonical-k" } };
  const recovered = new KJPaperExecutionCoordinator(service, tampered, accounts);
  await assert.rejects(recovered.initialize(), /hash mismatch/);
});

test("K/J INTENT and FILL events map into one explicit execution proposal", () => {
  const base = { schemaVersion: "kj-paper-engine-v2", strategy: "J_FEE_AWARE", marketId: snapshot.marketId } as const;
  const intent: KJPaperEvent = { ...base, eventId: HASH_A, eventType: "INTENT", eventTime: NOW, details: { intentId: HASH_A, outcome: "DOWN", probability: "0.7", maximumFillPrice: "0.49", contextHash: HASH_C } };
  const fill: KJPaperEvent = { ...base, eventId: HASH_B, eventType: "FILL", eventTime: NOW, details: { intentId: HASH_A, quantity: "1" } };
  const mapped = kjExecutionProposalFromEvents(intent, fill, proposal("J_FEE_AWARE", HASH_A).feeEvidence);
  assert.equal(mapped.outcome, "DOWN"); assert.equal(mapped.sideProbability, "0.7"); assert.equal(mapped.quantity, "1");
});
