import {
  PaperSimulationService,
  type PaperMarketSnapshotV1,
  type PaperOrderRequestV1,
  type PaperOrderRequestV2,
  type PaperOrderV1,
  type PaperFillV1,
  type PaperPositionV1,
  type PaperSettlementV1,
  type PaperEventV1,
  type PaperToken,
  type PaperRiskConfigV1,
  type PaperSimulationStateV1,
} from "../paper-simulation/index.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

export interface CallerManagedPublicMarketAdapter {
  readonly adapterId: string;
  readonly source: "PUBLIC_MARKET_DATA";
  readonly lifecycle: "CALLER_MANAGED";
  isReady(): boolean;
  latest(marketId: string): PaperMarketSnapshotV1 | null;
}

export type PaperSessionStatus = "RUNNING" | "STOPPED";
export type PaperSessionStartV1 = Readonly<{
  schemaVersion: "paper-session-start-v1";
  sessionId: string;
  initialCash: string;
  risk: PaperRiskConfigV1;
  startedAtUtc: string;
}>;

export type PaperSessionViewV1 = Readonly<{
  schemaVersion: "paper-session-view-v1";
  sessionId: string;
  status: PaperSessionStatus;
  adapterId: string;
  startedAtUtc: string;
  updatedAtUtc: string;
  cash: string;
  openOrderCount: number;
  fillCount: number;
  systemKillSwitchEnabled: boolean;
}>;

export type PaperSessionDetailV1 = Readonly<{
  schemaVersion: "paper-session-detail-v1";
  session: PaperSessionViewV1;
  orders: readonly PaperOrderV1[];
  fills: readonly PaperFillV1[];
  positions: readonly PaperPositionV1[];
  settlements: readonly PaperSettlementV1[];
  events: readonly PaperEventV1[];
}>;

export type PersistedPaperSessionV1 = Readonly<{
  schemaVersion: "persisted-paper-session-v1";
  sessionId: string;
  status: PaperSessionStatus;
  adapterId: string;
  startedAtUtc: string;
  updatedAtUtc: string;
  initialCash: string;
  risk: PaperRiskConfigV1;
  simulation: PaperSimulationStateV1;
}>;

export type PaperSystemControlV1 = Readonly<{
  schemaVersion: "paper-system-control-v1";
  killSwitchEnabled: boolean;
  updatedAtUtc: string;
  reason: string;
}>;

export interface PaperSessionStateStore {
  saveSession(session: PersistedPaperSessionV1): Promise<void>;
  loadSession(sessionId: string): Promise<PersistedPaperSessionV1 | null>;
  listSessions(): Promise<readonly PersistedPaperSessionV1[]>;
  saveSystemControl(control: PaperSystemControlV1): Promise<void>;
  loadSystemControl(): Promise<PaperSystemControlV1 | null>;
}

type ActiveSession = {
  persisted: Omit<PersistedPaperSessionV1, "simulation">;
  engine: PaperSimulationService;
};

function timestamp(value: string, field: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(`${field} must be a UTC ISO 8601 timestamp`);
}

export class PaperSessionService {
  readonly #adapter: CallerManagedPublicMarketAdapter;
  readonly #store: PaperSessionStateStore;
  readonly #sessions = new Map<string, ActiveSession>();
  #systemControl: PaperSystemControlV1 = Object.freeze({
    schemaVersion: "paper-system-control-v1", killSwitchEnabled: false,
    updatedAtUtc: "1970-01-01T00:00:00.000Z", reason: "INITIAL_STATE",
  });

  constructor(adapter: CallerManagedPublicMarketAdapter, store: PaperSessionStateStore) {
    if (!SAFE_ID.test(adapter.adapterId) || adapter.source !== "PUBLIC_MARKET_DATA" || adapter.lifecycle !== "CALLER_MANAGED") {
      throw new Error("a caller-managed public market adapter is required");
    }
    this.#adapter = adapter; this.#store = store;
  }

  async initialize(): Promise<void> {
    const restored = await this.#store.loadSystemControl();
    if (restored !== null) this.#systemControl = this.#validateControl(restored);
  }

  async start(input: PaperSessionStartV1): Promise<PaperSessionViewV1> {
    this.#validateStart(input);
    if (!this.#adapter.isReady()) throw new Error("public market adapter is not ready; the session service does not start collection");
    if (this.#sessions.has(input.sessionId) || await this.#store.loadSession(input.sessionId) !== null) throw new Error(`paper session already exists: ${input.sessionId}`);
    const engine = new PaperSimulationService(input.initialCash, input.risk);
    if (this.#systemControl.killSwitchEnabled) engine.setKillSwitch(true, input.startedAtUtc, this.#systemControl.reason);
    const persisted = {
      schemaVersion: "persisted-paper-session-v1" as const, sessionId: input.sessionId, status: "RUNNING" as const,
      adapterId: this.#adapter.adapterId, startedAtUtc: input.startedAtUtc, updatedAtUtc: input.startedAtUtc,
      initialCash: input.initialCash, risk: input.risk,
    };
    const active = { persisted, engine }; this.#sessions.set(input.sessionId, active); await this.#save(active);
    return this.#view(active);
  }

  async stop(sessionId: string, nowUtc: string): Promise<PaperSessionViewV1> {
    timestamp(nowUtc, "nowUtc"); const active = await this.#required(sessionId);
    active.persisted = { ...active.persisted, status: "STOPPED", updatedAtUtc: nowUtc };
    await this.#save(active); return this.#view(active);
  }

  async resume(sessionId: string, nowUtc: string): Promise<PaperSessionViewV1> {
    timestamp(nowUtc, "nowUtc");
    if (!this.#adapter.isReady()) throw new Error("public market adapter is not ready; the session service does not start collection");
    const active = await this.#required(sessionId);
    if (active.persisted.adapterId !== this.#adapter.adapterId) throw new Error("persisted session belongs to a different market adapter");
    active.persisted = { ...active.persisted, status: "RUNNING", updatedAtUtc: nowUtc };
    if (active.engine.killSwitchEnabled !== this.#systemControl.killSwitchEnabled) active.engine.setKillSwitch(this.#systemControl.killSwitchEnabled, nowUtc, this.#systemControl.reason);
    await this.#save(active); return this.#view(active);
  }

  async status(sessionId: string): Promise<PaperSessionViewV1> { return this.#view(await this.#required(sessionId)); }

  async list(): Promise<readonly PaperSessionViewV1[]> {
    const persisted = await this.#store.listSessions();
    for (const item of persisted) if (!this.#sessions.has(item.sessionId)) {
      const active = this.#restore(item); this.#sessions.set(item.sessionId, active); await this.#reconcileKillSwitch(active);
    }
    return Object.freeze([...this.#sessions.values()].map((active) => this.#view(active)).sort((a, b) => a.sessionId.localeCompare(b.sessionId)));
  }

  async submitOrder(sessionId: string, request: PaperOrderRequestV1 | PaperOrderRequestV2, nowUtc: string): Promise<PaperOrderV1> {
    const active = await this.#required(sessionId);
    const replay = active.engine.idempotentReplay(request); if (replay !== null) return replay;
    if (active.persisted.status !== "RUNNING") throw new Error("paper session is stopped");
    const snapshot = this.#adapter.latest(request.marketId); if (snapshot === null) throw new Error("public market adapter has no snapshot for the market");
    const result = active.engine.submit(request, snapshot, nowUtc);
    active.persisted = { ...active.persisted, updatedAtUtc: nowUtc }; await this.#save(active); return result;
  }

  async detail(sessionId: string): Promise<PaperSessionDetailV1> {
    const active = await this.#required(sessionId);
    return Object.freeze({
      schemaVersion: "paper-session-detail-v1",
      session: this.#view(active),
      orders: active.engine.listOrders(),
      fills: active.engine.listFills(),
      positions: active.engine.listPositions(),
      settlements: active.engine.listSettlements(),
      events: active.engine.listEvents(),
    });
  }

  async cancelOrder(sessionId: string, orderId: string, nowUtc: string, reason: string): Promise<PaperOrderV1> {
    timestamp(nowUtc, "nowUtc");
    const active = await this.#required(sessionId);
    const result = active.engine.cancel(orderId, nowUtc, reason);
    active.persisted = { ...active.persisted, updatedAtUtc: nowUtc };
    await this.#save(active);
    return result;
  }

  async repriceOrder(sessionId: string, orderId: string, replacement: PaperOrderRequestV1 | PaperOrderRequestV2, nowUtc: string): Promise<PaperOrderV1> {
    const active = await this.#required(sessionId);
    if (active.persisted.status !== "RUNNING") throw new Error("paper session is stopped");
    const snapshot = this.#adapter.latest(replacement.marketId);
    if (snapshot === null) throw new Error("public market adapter has no snapshot for the market");
    const result = active.engine.reprice(orderId, replacement, snapshot, nowUtc);
    active.persisted = { ...active.persisted, updatedAtUtc: nowUtc };
    await this.#save(active);
    return result;
  }

  async expireOrders(sessionId: string, nowUtc: string): Promise<readonly PaperOrderV1[]> {
    const active = await this.#required(sessionId);
    const result = active.engine.expire(nowUtc);
    active.persisted = { ...active.persisted, updatedAtUtc: nowUtc };
    await this.#save(active);
    return result;
  }

  /** Applies one public snapshot to every running session and persists before returning. */
  async processSnapshot(snapshot: PaperMarketSnapshotV1, nowUtc: string): Promise<Readonly<Record<string, readonly PaperOrderV1[]>>> {
    timestamp(nowUtc, "nowUtc");
    await this.list();
    const changed: Record<string, readonly PaperOrderV1[]> = {};
    for (const active of this.#sessions.values()) {
      if (active.persisted.status !== "RUNNING") continue;
      const orders = active.engine.onSnapshot(snapshot, nowUtc);
      if (orders.length === 0) continue;
      active.persisted = { ...active.persisted, updatedAtUtc: nowUtc };
      await this.#save(active);
      changed[active.persisted.sessionId] = orders;
    }
    return Object.freeze(changed);
  }

  /** Expires GTD orders from wall-clock time even when no market snapshot arrives. */
  async processClock(nowUtc: string): Promise<Readonly<Record<string, readonly PaperOrderV1[]>>> {
    timestamp(nowUtc, "nowUtc");
    await this.list();
    const expired: Record<string, readonly PaperOrderV1[]> = {};
    for (const active of this.#sessions.values()) {
      const orders = active.engine.expire(nowUtc);
      if (orders.length === 0) continue;
      active.persisted = { ...active.persisted, updatedAtUtc: nowUtc };
      await this.#save(active);
      expired[active.persisted.sessionId] = orders;
    }
    return Object.freeze(expired);
  }

  async settleMarket(sessionId: string, marketId: string, winningToken: PaperToken, nowUtc: string): Promise<PaperSettlementV1> {
    const active = await this.#required(sessionId);
    const result = active.engine.settle(marketId, winningToken, nowUtc);
    active.persisted = { ...active.persisted, updatedAtUtc: nowUtc };
    await this.#save(active);
    return result;
  }

  async setSystemKillSwitch(enabled: boolean, nowUtc: string, reason: string): Promise<PaperSystemControlV1> {
    timestamp(nowUtc, "nowUtc"); if (reason.trim() === "") throw new Error("kill switch reason is required");
    this.#systemControl = Object.freeze({ schemaVersion: "paper-system-control-v1", killSwitchEnabled: enabled, updatedAtUtc: nowUtc, reason });
    await this.#store.saveSystemControl(this.#systemControl);
    for (const persisted of await this.#store.listSessions()) if (!this.#sessions.has(persisted.sessionId)) this.#sessions.set(persisted.sessionId, this.#restore(persisted));
    for (const active of this.#sessions.values()) { active.engine.setKillSwitch(enabled, nowUtc, reason); active.persisted = { ...active.persisted, updatedAtUtc: nowUtc }; await this.#save(active); }
    return this.#systemControl;
  }

  systemStatus(): PaperSystemControlV1 { return this.#systemControl; }
  async exportSession(sessionId: string): Promise<PersistedPaperSessionV1> { const active = await this.#required(sessionId); return this.#serialize(active); }

  #validateStart(input: PaperSessionStartV1): void {
    if (input.schemaVersion !== "paper-session-start-v1" || !SAFE_ID.test(input.sessionId)) throw new Error("invalid paper session start request");
    timestamp(input.startedAtUtc, "startedAtUtc");
  }
  #validateControl(control: PaperSystemControlV1): PaperSystemControlV1 {
    if (control.schemaVersion !== "paper-system-control-v1" || control.reason.trim() === "") throw new Error("invalid persisted system control");
    timestamp(control.updatedAtUtc, "updatedAtUtc"); return Object.freeze({ ...control });
  }
  async #required(sessionId: string): Promise<ActiveSession> {
    if (!SAFE_ID.test(sessionId)) throw new Error("invalid sessionId"); const current = this.#sessions.get(sessionId); if (current !== undefined) return current;
    const persisted = await this.#store.loadSession(sessionId); if (persisted === null) throw new Error(`unknown paper session: ${sessionId}`);
    const restored = this.#restore(persisted); this.#sessions.set(sessionId, restored); await this.#reconcileKillSwitch(restored); return restored;
  }
  #restore(value: PersistedPaperSessionV1): ActiveSession {
    if (value.schemaVersion !== "persisted-paper-session-v1" || !SAFE_ID.test(value.sessionId)) throw new Error("invalid persisted paper session");
    timestamp(value.startedAtUtc, "startedAtUtc"); timestamp(value.updatedAtUtc, "updatedAtUtc");
    const { simulation, ...persisted } = value; return { persisted: { ...persisted }, engine: new PaperSimulationService(value.initialCash, value.risk, simulation) };
  }
  #serialize(active: ActiveSession): PersistedPaperSessionV1 { return Object.freeze({ ...active.persisted, simulation: active.engine.exportState() }); }
  async #save(active: ActiveSession): Promise<void> { await this.#store.saveSession(this.#serialize(active)); }
  async #reconcileKillSwitch(active: ActiveSession): Promise<void> {
    if (active.engine.killSwitchEnabled === this.#systemControl.killSwitchEnabled) return;
    active.engine.setKillSwitch(this.#systemControl.killSwitchEnabled, this.#systemControl.updatedAtUtc, this.#systemControl.reason);
    active.persisted = { ...active.persisted, updatedAtUtc: this.#systemControl.updatedAtUtc }; await this.#save(active);
  }
  #view(active: ActiveSession): PaperSessionViewV1 {
    return Object.freeze({
      schemaVersion: "paper-session-view-v1", sessionId: active.persisted.sessionId, status: active.persisted.status,
      adapterId: active.persisted.adapterId, startedAtUtc: active.persisted.startedAtUtc, updatedAtUtc: active.persisted.updatedAtUtc,
      cash: active.engine.cash, openOrderCount: active.engine.listOpenOrders().length, fillCount: active.engine.listFills().length,
      systemKillSwitchEnabled: this.#systemControl.killSwitchEnabled,
    });
  }
}

export class InMemoryPaperSessionStateStore implements PaperSessionStateStore {
  readonly #sessions = new Map<string, PersistedPaperSessionV1>();
  #control: PaperSystemControlV1 | null = null;
  async saveSession(session: PersistedPaperSessionV1): Promise<void> { this.#sessions.set(session.sessionId, structuredClone(session)); }
  async loadSession(sessionId: string): Promise<PersistedPaperSessionV1 | null> { const value = this.#sessions.get(sessionId); return value === undefined ? null : structuredClone(value); }
  async listSessions(): Promise<readonly PersistedPaperSessionV1[]> { return [...this.#sessions.values()].map((value) => structuredClone(value)); }
  async saveSystemControl(control: PaperSystemControlV1): Promise<void> { this.#control = structuredClone(control); }
  async loadSystemControl(): Promise<PaperSystemControlV1 | null> { return this.#control === null ? null : structuredClone(this.#control); }
}

export class FilePaperSessionStateStore implements PaperSessionStateStore {
  readonly #root: string;
  constructor(dataRoot: string) { if (!isAbsolute(dataRoot)) throw new Error("paper session data root must be absolute"); this.#root = resolve(dataRoot, "workbench", "paper-sessions"); }
  async saveSession(session: PersistedPaperSessionV1): Promise<void> { if (!SAFE_ID.test(session.sessionId)) throw new Error("invalid paper sessionId"); await this.#atomic(`${session.sessionId}.json`, session); }
  async loadSession(sessionId: string): Promise<PersistedPaperSessionV1 | null> { if (!SAFE_ID.test(sessionId)) throw new Error("invalid paper sessionId"); return this.#read<PersistedPaperSessionV1>(`${sessionId}.json`); }
  async listSessions(): Promise<readonly PersistedPaperSessionV1[]> { const entries = await readdir(this.#root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error)); const values: PersistedPaperSessionV1[] = []; for (const entry of entries) if (entry.isFile() && entry.name.endsWith(".json") && entry.name !== "system-control.json") { const value = await this.#read<PersistedPaperSessionV1>(entry.name).catch(() => null); if (value?.schemaVersion === "persisted-paper-session-v1") values.push(value); } return Object.freeze(values); }
  saveSystemControl(control: PaperSystemControlV1): Promise<void> { return this.#atomic("system-control.json", control); }
  loadSystemControl(): Promise<PaperSystemControlV1 | null> { return this.#read<PaperSystemControlV1>("system-control.json"); }
  async #atomic(name: string, value: unknown): Promise<void> { await mkdir(this.#root, { recursive: true, mode: 0o700 }); const temporary = join(this.#root, `${name}.${process.pid}.${randomUUID()}.partial`); await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 }); await rename(temporary, join(this.#root, name)); }
  async #read<T>(name: string): Promise<T | null> { try { const bytes = await readFile(join(this.#root, name)); if (bytes.length > 16 * 1024 * 1024) throw new Error("paper session artifact exceeds limit"); return JSON.parse(bytes.toString("utf8")) as T; } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
}
