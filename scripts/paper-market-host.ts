import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  FilePaperSessionStateStore,
  FileKJExecutionOutboxStore,
  FileOfficialPaperSettlementStore,
  KJPaperExecutionCoordinator,
  OfficialGammaPaperSettlementCoordinator,
  DefaultPublicGammaResolutionSource,
  PaperMarketHost,
  PaperSessionService,
  createPublicBtcPaperMarketFeed,
  type CallerManagedPublicMarketAdapter,
  type PaperMarketHostStatusV1,
  type PaperSessionStartV1,
  type PublicPaperMarketFeed,
  type PublicGammaResolutionSource,
  kjExecutionProposalFromEvents,
  queryPaperReplay,
} from "../backend/paper-session/index.js";
import type { PaperOrderRequest, PaperToken } from "../backend/paper-simulation/index.js";
import { KJPaperJournal } from "../backend/core/src/storage/kj-paper-journal.js";
import { kjPaperContextFingerprint, type KJPaperEngineConfig, type KJPaperEvent, type PaperRuntimeStrategy } from "../backend/core/src/runtime/kj-paper-engine.js";
import type { KJStrategyContextV1 } from "../strategies/src/kj-context.js";
import type { PublicBtcFiveMinuteMarket } from "../backend/core/src/adapters/market-data/public-sources.js";
import { GammaResolutionPending } from "../backend/core/src/adapters/settlement/gamma-resolution.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const SAFE_REQUEST_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
export const DESKTOP_KJ_ACCOUNTS = Object.freeze({
  J_FEE_AWARE: "desktop-kj-j",
  K_DUAL_VOL: "desktop-kj-k",
  L_ADAPTIVE_EXECUTION_V2: "desktop-l-v2",
});
export const DESKTOP_KJ_INITIAL_CASH = "10000";
export const DESKTOP_KJ_RISK = Object.freeze({
  schemaVersion: "paper-risk-config-v1" as const, maximumQuoteAgeMs: 15_000, minimumNetEdge: "0.05",
  maximumOrderNotional: "400", maximumMarketExposure: "400", maximumTotalExposure: "4000",
});
type PaperRunnerConfig = Readonly<{
  strategyId: PaperRuntimeStrategy;
  strategyVersion: string;
  initialCash: string;
  maximumPosition: string;
  minimumNetEdge: string;
  strategyParameters: Readonly<Record<string, string | number | boolean>>;
}>;
type HostTimer = ReturnType<typeof setTimeout>;
export type PaperHostRuntimeOptions = Readonly<{
  feedFactory?: (slug: string) => PublicPaperMarketFeed;
  gammaSource?: PublicGammaResolutionSource;
  nowMs?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => HostTimer;
  clearTimer?: (timer: HostTimer) => void;
  settlementRetryDelaysMs?: readonly number[];
}>;

export type PaperHostIpcRequestV1 = Readonly<{
  schemaVersion: "paper-host-ipc-request-v1";
  requestId: string;
  command: "host-status" | "get-paper-market-runtime" | "start-public-feed" | "stop-public-feed" | "get-paper-strategy-runtime" | "get-paper-replay" | "list-paper-sessions" | "start-paper-session" | "get-paper-session-status" | "stop-paper-session" | "resume-paper-session" | "get-paper-session-detail" | "submit-paper-order" | "cancel-paper-order" | "reprice-paper-order" | "expire-paper-orders" | "settle-paper-market" | "set-paper-kill-switch" | "get-paper-system-control";
  payload: Readonly<Record<string, unknown>>;
}>;

export type PaperHostIpcResponseV1 = Readonly<{
  schemaVersion: "paper-host-ipc-response-v1";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: Readonly<{ code: string; message: string }>;
}>;

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
  return value;
}
function utcNow(): string { return new Date().toISOString(); }
function unavailableAdapter(): CallerManagedPublicMarketAdapter {
  return Object.freeze({ adapterId: "desktop-public-market-adapter", source: "PUBLIC_MARKET_DATA", lifecycle: "CALLER_MANAGED", isReady: () => false, latest: () => null });
}

export class PaperHostRuntime {
  readonly #store: FilePaperSessionStateStore;
  readonly #dataRoot: string;
  #host: PaperMarketHost | null = null;
  #paper: PaperSessionService;
  #journal: KJPaperJournal | null = null;
  #journalFileName: string | null = null;
  #strategyTail: Promise<void> = Promise.resolve();
  #pendingStrategyContext: KJStrategyContextV1 | null = null;
  #strategyDrainRunning = false;
  #coalescedStrategyContextCount = 0;
  #orderLifecycleTail: Promise<void> = Promise.resolve();
  #expiryTimer: ReturnType<typeof setInterval> | null = null;
  #strategyError: string | null = null;
  #settlementError: string | null = null;
  #strategyLifecycle: "STOPPED" | "RUNNING" = "STOPPED";
  #latestContext: KJStrategyContextV1 | null = null;
  #coordinator: KJPaperExecutionCoordinator | null = null;
  #officialSettlementCoordinator: OfficialGammaPaperSettlementCoordinator | null = null;
  #strategyEventCursor = 0;
  readonly #intents = new Map<string, KJPaperEvent>();
  readonly #intentObservedNs = new Map<string, bigint>();
  readonly #inputToDecisionMs: number[] = [];
  readonly #strategyComputationMs: number[] = [];
  readonly #decisionToPaperLockMs: number[] = [];
  readonly #feesByContext = new Map<string, KJStrategyContextV1>();
  readonly #feedFactory: (slug: string) => PublicPaperMarketFeed;
  readonly #gammaSource: PublicGammaResolutionSource;
  readonly #nowMs: () => number;
  readonly #setTimer: (callback: () => void, delayMs: number) => HostTimer;
  readonly #clearTimer: (timer: HostTimer) => void;
  readonly #settlementRetryDelaysMs: readonly number[];
  readonly #settlementMarkets = new Map<string, PublicBtcFiveMinuteMarket>();
  readonly #settlementTimers = new Map<string, HostTimer>();
  readonly #settlementAttempts = new Map<string, number>();
  #settlementGeneration = 0;
  #settlementTail: Promise<void> = Promise.resolve();
  #publicNetworkApproved = false;
  #runner: PaperRunnerConfig | null = null;
  #accounts: Readonly<Record<PaperRuntimeStrategy, string>> = DESKTOP_KJ_ACCOUNTS;

  constructor(dataRoot: string, adapter: CallerManagedPublicMarketAdapter = unavailableAdapter(), options: PaperHostRuntimeOptions = {}) {
    this.#dataRoot = dataRoot;
    this.#store = new FilePaperSessionStateStore(dataRoot);
    this.#paper = new PaperSessionService(adapter, this.#store);
    this.#feedFactory = options.feedFactory ?? createPublicBtcPaperMarketFeed;
    this.#gammaSource = options.gammaSource ?? new DefaultPublicGammaResolutionSource();
    this.#nowMs = options.nowMs ?? Date.now;
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    const retries = options.settlementRetryDelaysMs ?? [5_000, 15_000, 30_000, 60_000];
    if (retries.some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new Error("settlement retry delays must be positive integers");
    this.#settlementRetryDelaysMs = Object.freeze([...retries]);
  }

  async initialize(): Promise<void> {
    await this.#paper.initialize();
    if (this.#expiryTimer === null) {
      this.#expiryTimer = setInterval(() => {
        this.#orderLifecycleTail = this.#orderLifecycleTail
          .then(() => this.#paper.processClock(new Date(this.#nowMs()).toISOString()))
          .then(() => undefined)
          .catch((error: unknown) => { this.#strategyError = error instanceof Error ? error.message : "paper GTD expiry failed"; });
      }, 1_000);
      this.#expiryTimer.unref();
    }
  }

  async execute(request: PaperHostIpcRequestV1): Promise<unknown> {
    const payload = object(request.payload, "payload");
    switch (request.command) {
      case "host-status": return this.#status();
      case "get-paper-market-runtime": return this.#marketRuntime();
      case "get-paper-strategy-runtime":
        await this.#awaitStrategyIdle();
        return this.#strategyStatus();
      case "get-paper-replay":
        await this.#awaitStrategyIdle();
        return queryPaperReplay(this.#dataRoot, this.#paper, Number(payload.page), Number(payload.pageSize), this.#journal === null || this.#journalFileName === null ? null : { fileName: this.#journalFileName, journal: this.#journal });
      case "start-public-feed": {
        if (payload.explicitNetworkApproval !== true) throw new Error("explicit network approval is required");
        if (this.#host !== null) throw new Error("public Paper market host is already configured");
        const runnerInput = payload.runner === undefined ? null : object(payload.runner, "runner");
        if (runnerInput !== null) {
          const strategyId = text(runnerInput.strategyId, "runner.strategyId");
          if (strategyId !== "J_FEE_AWARE" && strategyId !== "K_DUAL_VOL" && strategyId !== "L_ADAPTIVE_EXECUTION_V2") {
            throw new Error("selected strategy is not Paper-ready");
          }
          const decimal = (value: unknown, field: string, allowZero = false): string => {
            const result = text(value, field);
            if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(result) || (allowZero ? Number(result) < 0 : Number(result) <= 0)) throw new Error(`${field} is invalid`);
            return result;
          };
          const strategyParameters = runnerInput.strategyParameters === undefined
            ? Object.freeze({})
            : Object.freeze({ ...object(runnerInput.strategyParameters, "runner.strategyParameters") }) as Readonly<Record<string, string | number | boolean>>;
          this.#runner = Object.freeze({ strategyId, strategyVersion: text(runnerInput.strategyVersion, "runner.strategyVersion"), initialCash: decimal(runnerInput.initialCash, "runner.initialCash"), maximumPosition: decimal(runnerInput.maximumPosition, "runner.maximumPosition"), minimumNetEdge: decimal(runnerInput.minimumNetEdge, "runner.minimumNetEdge", true), strategyParameters });
          const runIdentity = `${strategyId.toLowerCase().replaceAll("_", "-")}-${this.#nowMs()}-${randomUUID().slice(0, 8)}`;
          this.#accounts = Object.freeze({
            J_FEE_AWARE: `${runIdentity}-j`,
            K_DUAL_VOL: `${runIdentity}-k`,
            L_ADAPTIVE_EXECUTION_V2: `${runIdentity}-l`,
          });
        }
        const slug = payload.slug === undefined
          ? `btc-updown-5m-${Math.floor(this.#nowMs() / 300_000) * 300}`
          : text(payload.slug, "slug");
        const feed = this.#feedFactory(slug);
        const directory = join(this.#dataRoot, "workbench", "paper-host");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const runner = this.#runner;
        const versionParameter = (name: string, fallback: string): string => {
          const value = runner?.strategyParameters[name];
          return typeof value === "number" && Number.isFinite(value) ? String(value) : fallback;
        };
        const engineConfig: Partial<KJPaperEngineConfig> = runner === null ? {} : {
          activeStrategies: [runner.strategyId],
          initialCash: runner.initialCash,
          edgeThreshold: versionParameter("edgeThreshold", "0.05"),
          maxEdge: versionParameter("maxSignalEdge", versionParameter("maxEdge", "0.25")),
          maximumStakeAmount: runner.maximumPosition,
          bookParticipation: versionParameter("bookParticipation", "0.5"),
        };
        const safeVersion = runner?.strategyVersion.replace(/[^a-zA-Z0-9._-]/gu, "-");
        const journalFileName = runner === null
          ? `${slug}.kj-input-journal.jsonl`
          : `${slug}.${runner.strategyId.toLowerCase()}.${safeVersion}.${this.#nowMs()}.kj-input-journal.jsonl`;
        const journal = await KJPaperJournal.open(join(directory, journalFileName), engineConfig);
        this.#journal = journal;
        this.#journalFileName = journalFileName;
        this.#strategyError = null;
        this.#settlementError = null;
        this.#latestContext = null;
        this.#clearSettlementTimers(); this.#publicNetworkApproved = true;
        this.#coordinator = null; this.#officialSettlementCoordinator = null; this.#strategyEventCursor = 0; this.#intents.clear(); this.#intentObservedNs.clear(); this.#inputToDecisionMs.length=0; this.#strategyComputationMs.length=0; this.#decisionToPaperLockMs.length=0; this.#pendingStrategyContext=null; this.#strategyDrainRunning=false; this.#coalescedStrategyContextCount=0; this.#feesByContext.clear(); this.#settlementMarkets.clear(); this.#settlementAttempts.clear();
        const host = new PaperMarketHost(feed, {
          hostId: "desktop-kj-public-market",
          now: () => new Date(this.#nowMs()).toISOString(),
          onSnapshot: (snapshot) => {
            this.#orderLifecycleTail = this.#orderLifecycleTail
              .catch(() => undefined)
              .then(() => this.#paper.processSnapshot(snapshot, snapshot.receivedAtUtc))
              .then(() => undefined)
              .catch((error: unknown) => {
                this.#strategyError = error instanceof Error ? error.message : "paper snapshot lifecycle failed";
                throw error;
              });
            return this.#orderLifecycleTail;
          },
          onStrategyContext: (context) => {
            this.#latestContext = context;
            if (this.#pendingStrategyContext !== null) this.#coalescedStrategyContextCount += 1;
            this.#pendingStrategyContext = context;
            this.#scheduleStrategyDrain(journal);
          },
        });
        try {
          await host.start();
        } catch (error) {
          await journal.close();
          this.#journal = null;
          this.#journalFileName = null;
          throw error;
        }
        try {
          this.#host = host;
          this.#strategyLifecycle = "RUNNING";
          this.#paper = new PaperSessionService(host, this.#store);
          await this.#paper.initialize();
          await this.#waitForHostReady(host);
          await this.#ensureCanonicalSessions();
          const coordinator = new KJPaperExecutionCoordinator(this.#paper, new FileKJExecutionOutboxStore(this.#dataRoot), this.#accounts);
          await coordinator.initialize();
          this.#coordinator = coordinator;
          const official = new OfficialGammaPaperSettlementCoordinator(this.#paper, new FileOfficialPaperSettlementStore(this.#dataRoot), this.#accounts, this.#gammaSource);
          await official.initialize(); this.#officialSettlementCoordinator = official;
          for (const context of journal.contexts()) { this.#rememberContextFee(context); this.#rememberSettlementMarket(context); }
          await this.#awaitStrategyIdle();
          await this.#coordinateNewEvents(journal);
          return host.status();
        } catch (error) {
          await host.stop().catch(() => undefined);
          await this.#coordinator?.close().catch(() => undefined);
          await journal.close().catch(() => undefined);
          this.#clearSettlementTimers(); this.#publicNetworkApproved = false;
          this.#host = null; this.#journal = null; this.#journalFileName = null; this.#coordinator = null; this.#officialSettlementCoordinator = null; this.#strategyLifecycle = "STOPPED";
          throw error;
        }
      }
      case "stop-public-feed": {
        if (this.#host === null) return this.#status();
        this.#clearSettlementTimers(); this.#publicNetworkApproved = false;
        const activeHost = this.#host;
        const status = await activeHost.stop();
        await Promise.all([this.#awaitStrategyIdle(), this.#settlementTail, this.#orderLifecycleTail]);
        await this.#coordinator?.close();
        for (const accountId of Object.values(this.#accounts)) {
          const session = (await this.#paper.list()).find((item) => item.sessionId === accountId);
          if (session?.status === "RUNNING") await this.#paper.stop(accountId, utcNow());
        }
        if (this.#journal !== null) await this.#journal.close();
        this.#host = null; this.#coordinator = null; this.#officialSettlementCoordinator = null;
        this.#strategyLifecycle = "STOPPED";
        return status;
      }
      case "list-paper-sessions": return this.#paper.list();
      case "start-paper-session": return this.#paper.start(object(payload.request, "request") as PaperSessionStartV1);
      case "get-paper-session-status": return this.#paper.status(text(payload.sessionId, "sessionId"));
      case "stop-paper-session": return this.#paper.stop(text(payload.sessionId, "sessionId"), utcNow());
      case "resume-paper-session": return this.#paper.resume(text(payload.sessionId, "sessionId"), utcNow());
      case "get-paper-session-detail": return this.#paper.detail(text(payload.sessionId, "sessionId"));
      case "submit-paper-order": return this.#paper.submitOrder(text(payload.sessionId, "sessionId"), object(payload.request, "request") as PaperOrderRequest, utcNow());
      case "cancel-paper-order": return this.#paper.cancelOrder(text(payload.sessionId, "sessionId"), text(payload.orderId, "orderId"), utcNow(), text(payload.reason, "reason"));
      case "reprice-paper-order": return this.#paper.repriceOrder(text(payload.sessionId, "sessionId"), text(payload.orderId, "orderId"), object(payload.replacement, "replacement") as PaperOrderRequest, utcNow());
      case "expire-paper-orders": return this.#paper.expireOrders(text(payload.sessionId, "sessionId"), utcNow());
      case "settle-paper-market": { if (payload.evidenceMode !== "MANUAL_PAPER_TEST" || (payload.winningToken !== "YES" && payload.winningToken !== "NO")) throw new Error("manual Paper settlement evidence is invalid"); return this.#paper.settleMarket(text(payload.sessionId, "sessionId"), text(payload.marketId, "marketId"), payload.winningToken as PaperToken, utcNow()); }
      case "get-paper-system-control": return this.#paper.systemStatus();
      case "set-paper-kill-switch": {
        if (typeof payload.enabled !== "boolean") throw new Error("enabled must be boolean");
        return this.#paper.setSystemKillSwitch(payload.enabled, utcNow(), text(payload.reason, "reason"));
      }
    }
  }

  async close(): Promise<void> {
    try {
      if (this.#expiryTimer !== null) { clearInterval(this.#expiryTimer); this.#expiryTimer = null; }
      this.#clearSettlementTimers(); this.#publicNetworkApproved = false;
      if (this.#host !== null) await this.#host.stop();
      await Promise.all([this.#awaitStrategyIdle(), this.#settlementTail, this.#orderLifecycleTail]);
      await this.#coordinator?.close();
    } finally {
      this.#strategyLifecycle = "STOPPED";
      if (this.#journal !== null) {
        await this.#journal.close();
        this.#journal = null;
        this.#journalFileName = null;
      }
    }
  }

  async #waitForHostReady(host: PaperMarketHost): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!host.isReady() && Date.now() < deadline) {
      await new Promise<void>((resolveReady) => setTimeout(resolveReady, 100));
    }
    if (!host.isReady()) {
      const status = host.status();
      const last = status.events.at(-1)?.detail ?? "no public snapshot arrived";
      throw new Error(`public market feed did not become ready: ${last}`);
    }
  }

  async #strategyStatus(): Promise<Readonly<Record<string, unknown>>> {
    const journal = this.#journal;
    if (journal === null) return offlineStrategyStatus(this.#strategyError);
    const events = journal.engine.events();
    const visibleStrategies = this.#runner === null ? (["J_FEE_AWARE", "K_DUAL_VOL"] as const) : [this.#runner.strategyId];
    const canonicalAccounts = await Promise.all(visibleStrategies.map(async (strategy) => Object.freeze({ strategy, session: await this.#paper.status(this.#accounts[strategy]) })));
    return Object.freeze({
      schemaVersion: "paper-strategy-runtime-v2",
      status: this.#strategyError === null && this.#settlementError === null ? this.#strategyLifecycle : "DEGRADED",
      executionAuthority: "PAPER_SESSION",
      planner: Object.freeze({ engineVersion: "kj-paper-engine-v2", journalRecordCount: journal.recordCount, recoveredInputCount: journal.recoveredInputCount, lastRecordHash: journal.lastRecordHash, coalescedInputCount:this.#coalescedStrategyContextCount, error: this.#strategyError ?? this.#settlementError, latency:Object.freeze({strategyComputation:this.#latencySummary(this.#strategyComputationMs),inputToDecision:this.#latencySummary(this.#inputToDecisionMs),decisionToPaperLock:this.#latencySummary(this.#decisionToPaperLockMs),semantics:"PROCESS_MONOTONIC_MS"}) }),
      canonicalAccounts: Object.freeze(canonicalAccounts),
      executionLinks: Object.freeze((this.#coordinator?.links() ?? []).filter((link) => this.#runner === null || link.strategy === this.#runner.strategyId)),
      shadow: Object.freeze({ nonAuthoritative: true, snapshot: journal.engine.snapshot(), events: Object.freeze(events.slice(Math.max(0, events.length - 500))) }),
    });
  }

  async #ensureCanonicalSessions(): Promise<void> {
    const existing = new Map((await this.#paper.list()).map((session) => [session.sessionId, session]));
    const strategies: readonly PaperRuntimeStrategy[] = this.#runner === null
      ? ["J_FEE_AWARE", "K_DUAL_VOL"]
      : ["J_FEE_AWARE", "K_DUAL_VOL", "L_ADAPTIVE_EXECUTION_V2"];
    for (const strategy of strategies) {
      const sessionId = this.#accounts[strategy]; const current = existing.get(sessionId);
      const runner = this.#runner;
      const risk = runner === null ? DESKTOP_KJ_RISK : Object.freeze({ ...DESKTOP_KJ_RISK, minimumNetEdge: runner.minimumNetEdge, maximumOrderNotional: runner.maximumPosition, maximumMarketExposure: runner.maximumPosition, maximumTotalExposure: runner.maximumPosition });
      if (current === undefined) await this.#paper.start({ schemaVersion: "paper-session-start-v1", sessionId, initialCash: runner?.initialCash ?? DESKTOP_KJ_INITIAL_CASH, risk, startedAtUtc: utcNow() });
      else if (current.status === "STOPPED") await this.#paper.resume(sessionId, utcNow());
    }
  }

  #rememberContextFee(context: KJStrategyContextV1): void { this.#feesByContext.set(kjPaperContextFingerprint(context), context); }

  #rememberSettlementMarket(context: KJStrategyContextV1): void {
    if (this.#settlementMarkets.has(context.market.marketId)) return;
    const market: PublicBtcFiveMinuteMarket = Object.freeze({
      ...context.market, active: true, closed: false, acceptingOrders: true, collectible: true,
      takerFeeRate: context.feeEvidence.rate, rawPayload: "{}",
    });
    this.#settlementMarkets.set(market.marketId, market);
    if (this.#officialSettlementCoordinator?.links().some((link) => link.identity === market.marketId && link.state === "APPLIED") !== true) this.#scheduleSettlement(market, 0);
  }

  #scheduleSettlement(market: PublicBtcFiveMinuteMarket, retryIndex: number): void {
    if (!this.#publicNetworkApproved || this.#strategyLifecycle !== "RUNNING" || this.#settlementTimers.has(market.marketId)) return;
    const generation = this.#settlementGeneration;
    const retryDelay = retryIndex === 0 ? Math.max(1, Date.parse(market.intervalEnd) + 1 - this.#nowMs()) : this.#settlementRetryDelaysMs[retryIndex - 1];
    if (retryDelay === undefined) return;
    const timer = this.#setTimer(() => {
      this.#settlementTimers.delete(market.marketId);
      this.#settlementTail = this.#settlementTail.then(() => this.#attemptOfficialSettlement(market, retryIndex, generation));
    }, retryDelay);
    this.#settlementTimers.set(market.marketId, timer);
  }

  async #attemptOfficialSettlement(market: PublicBtcFiveMinuteMarket, retryIndex: number, generation: number): Promise<void> {
    if (generation !== this.#settlementGeneration || !this.#publicNetworkApproved || this.#strategyLifecycle !== "RUNNING") return;
    this.#settlementAttempts.set(market.marketId, retryIndex + 1);
    try {
      const response = await this.#gammaSource.fetch(market.slug);
      if (generation !== this.#settlementGeneration || !this.#publicNetworkApproved || this.#strategyLifecycle !== "RUNNING") return;
      await this.#officialSettlementCoordinator?.applyGamma({ expectedMarket: market, ...response });
      this.#settlementAttempts.delete(market.marketId);
      this.#settlementError = null;
    } catch (error: unknown) {
      if (generation !== this.#settlementGeneration || !this.#publicNetworkApproved || this.#strategyLifecycle !== "RUNNING") return;
      if (!(error instanceof GammaResolutionPending)) {
        this.#settlementError = error instanceof Error ? `official settlement ${market.marketId}: ${error.message}` : `official settlement ${market.marketId} failed`;
      }
      this.#scheduleSettlement(market, retryIndex + 1);
    }
  }

  #clearSettlementTimers(): void {
    this.#settlementGeneration += 1;
    for (const timer of this.#settlementTimers.values()) this.#clearTimer(timer);
    this.#settlementTimers.clear();
  }

  async #coordinateNewEvents(journal: KJPaperJournal): Promise<void> {
    const coordinator = this.#coordinator; if (coordinator === null) return;
    const events = journal.engine.events();
    while (this.#strategyEventCursor < events.length) {
      const event = events[this.#strategyEventCursor]!;
      if (event.strategy !== null && this.#runner !== null && event.strategy !== this.#runner.strategyId) { this.#strategyEventCursor += 1; continue; }
      if (event.eventType === "INTENT") { const intentId = event.details.intentId; if (typeof intentId === "string") { this.#intents.set(intentId, event); this.#intentObservedNs.set(intentId,process.hrtime.bigint()); } this.#strategyEventCursor += 1; continue; }
      if (event.eventType !== "FILL") { this.#strategyEventCursor += 1; continue; }
      const intentId = event.details.intentId; if (typeof intentId !== "string") throw new Error("K/J FILL lacks intentId");
      const intent = this.#intents.get(intentId); if (intent === undefined) throw new Error("K/J FILL lacks its INTENT event");
      const contextHash = intent.details.contextHash; if (typeof contextHash !== "string") throw new Error("K/J INTENT lacks contextHash");
      const context = this.#feesByContext.get(contextHash); if (context === undefined) throw new Error("K/J proposal lacks recovered fee context");
      await coordinator.coordinate(kjExecutionProposalFromEvents(intent, event, Object.freeze({
        schemaVersion: "paper-fee-evidence-v1", model: "POLYMARKET_TAKER_CURVE_V1",
        conditionId: context.market.conditionId, rate: context.feeEvidence.rate,
        effectiveFromUtc: new Date(Date.parse(context.market.intervalStart)).toISOString(), effectiveToUtc: new Date(Date.parse(context.market.intervalEnd)).toISOString(),
        evidenceStatus: "UNVERIFIED", evidenceReference: context.feeEvidence.reference,
      })));
      const intentNs=this.#intentObservedNs.get(intentId);
      if(intentNs!==undefined){this.#recordLatency(this.#decisionToPaperLockMs,Number(process.hrtime.bigint()-intentNs)/1_000_000);this.#intentObservedNs.delete(intentId);}
      this.#strategyEventCursor += 1;
    }
  }

  #scheduleStrategyDrain(journal: KJPaperJournal): void {
    if (this.#strategyDrainRunning) return;
    this.#strategyDrainRunning = true;
    this.#strategyTail = this.#drainStrategyContexts(journal)
      .catch((error: unknown) => {
        this.#strategyError = error instanceof Error ? error.message : "strategy journal append failed";
      })
      .finally(() => {
        this.#strategyDrainRunning = false;
        if (this.#pendingStrategyContext !== null) this.#scheduleStrategyDrain(journal);
      });
  }

  async #awaitStrategyIdle(): Promise<void> {
    while (this.#strategyDrainRunning || this.#pendingStrategyContext !== null) {
      await this.#strategyTail;
    }
  }

  async #drainStrategyContexts(journal:KJPaperJournal):Promise<void>{
    while(this.#pendingStrategyContext!==null){
      const context=this.#pendingStrategyContext;
      this.#pendingStrategyContext=null;
      const beforeEventCount=journal.engine.events().length;
      await journal.appendContextBuffered(context);
      const completedNs=process.hrtime.bigint(),inputNs=BigInt(context.inputWatermark.localMonotonicReceiveNs);
      const newEvents=journal.engine.events().slice(beforeEventCount);
      const decided=newEvents.some((event)=>event.eventType==="DECISION");
      if(decided){
        if(completedNs>=inputNs)this.#recordLatency(this.#inputToDecisionMs,Number(completedNs-inputNs)/1_000_000);
        const computationMs=journal.lastContextComputationMilliseconds;
        if(computationMs!==null)this.#recordLatency(this.#strategyComputationMs,computationMs);
      }
      this.#rememberContextFee(context);
      this.#rememberSettlementMarket(context);
      if(this.#coordinator!==null){
        if(newEvents.some((event)=>event.eventType==="FILL"))await journal.flush();
        await this.#coordinateNewEvents(journal);
      }
    }
  }

  #recordLatency(target:number[],value:number):void{if(!Number.isFinite(value)||value<0)return;target.push(value);if(target.length>1_000)target.splice(0,target.length-1_000);}
  #latencySummary(values:readonly number[]):Readonly<Record<string,number|null>>{if(values.length===0)return Object.freeze({count:0,p50Ms:null,p95Ms:null,maxMs:null});const sorted=[...values].sort((a,b)=>a-b);const pick=(fraction:number)=>sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*fraction)-1)]!;return Object.freeze({count:sorted.length,p50Ms:Number(pick(.5).toFixed(3)),p95Ms:Number(pick(.95).toFixed(3)),maxMs:Number(sorted.at(-1)!.toFixed(3))});}

  #status(): PaperMarketHostStatusV1 | Readonly<Record<string, unknown>> {
    return this.#host?.status() ?? Object.freeze({
      schemaVersion: "paper-market-host-status-v1", hostId: "desktop-paper-host", feedId: "unconfigured",
      source: "PUBLIC_MARKET_DATA", executionMode: "PAPER_ONLY", lifecycle: "STOPPED", connection: "DISCONNECTED",
      ready: false, cachedMarketCount: 0, snapshotCount: 0, gapCount: 0, errorCount: 0,
      lastSnapshotAtUtc: null, lastConnectionAtUtc: null, events: Object.freeze([]),
    });
  }

  #marketRuntime(): Readonly<Record<string, unknown>> {
    const context = this.#latestContext;
    const host = this.#host?.status();
    const checkedAtUtc = utcNow();
    if (context === null) return Object.freeze({ schemaVersion: "paper-market-runtime-v1", status: host?.lifecycle === "RUNNING" ? "WAITING" : "STOPPED", checkedAtUtc, market: null });
    const age = (value: string): number | null => { const result = Date.parse(checkedAtUtc) - Date.parse(value); return Number.isSafeInteger(result) && result >= 0 ? result : null; };
    return Object.freeze({
      schemaVersion: "paper-market-runtime-v1",
      status: host?.lifecycle !== "RUNNING" ? "STOPPED" : host.ready ? "READY" : "DEGRADED",
      checkedAtUtc,
      market: Object.freeze({
        marketId: context.market.marketId, conditionId: context.market.conditionId, slug: context.market.slug,
        intervalStart: context.market.intervalStart, intervalEnd: context.market.intervalEnd, decisionTime: context.decisionTime,
        continuity: context.book.continuity, bookAgeMs: age(context.book.receiveStamp.localWallReceiveTime), signalAgeMs: age(context.signal.receiveTime),
        up: Object.freeze({ ...context.book.up }), down: Object.freeze({ ...context.book.down }),
        signal: Object.freeze({ provider: context.signal.provider, price: context.signal.price, sourceTime: context.signal.sourceTime, serverTime: context.signal.serverTime, receiveTime: context.signal.receiveTime }),
        feeEvidence: Object.freeze({ schemaVersion:"paper-fee-evidence-v1", model:"POLYMARKET_TAKER_CURVE_V1", conditionId:context.market.conditionId, rate:context.feeEvidence.rate, effectiveFromUtc:new Date(Date.parse(context.market.intervalStart)).toISOString(), effectiveToUtc:new Date(Date.parse(context.market.intervalEnd)).toISOString(), evidenceStatus:"UNVERIFIED", evidenceReference:context.feeEvidence.reference }),
      }),
    });
  }
}

export function offlineStrategyStatus(error: string | null = null): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: "paper-strategy-runtime-v2",
    status: error === null ? "STOPPED" : "DEGRADED",
    executionAuthority: "PAPER_SESSION",
    planner: Object.freeze({ engineVersion: "kj-paper-engine-v2", journalRecordCount: 0, recoveredInputCount: 0, lastRecordHash: null, coalescedInputCount:0, error, latency:Object.freeze({strategyComputation:Object.freeze({count:0,p50Ms:null,p95Ms:null,maxMs:null}),inputToDecision:Object.freeze({count:0,p50Ms:null,p95Ms:null,maxMs:null}),decisionToPaperLock:Object.freeze({count:0,p50Ms:null,p95Ms:null,maxMs:null}),semantics:"PROCESS_MONOTONIC_MS"}) }),
    canonicalAccounts: Object.freeze([]), executionLinks: Object.freeze([]),
    shadow: Object.freeze({ nonAuthoritative: true, snapshot: null, events: Object.freeze([]) }),
  });
}

export function parsePaperHostRequest(line: string): PaperHostIpcRequestV1 {
  if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) throw new Error("Paper host IPC request exceeds limit");
  const input = object(JSON.parse(line) as unknown, "request");
  const keys = Object.keys(input).sort();
  if (keys.join(",") !== "command,payload,requestId,schemaVersion") throw new Error("Paper host IPC request fields are invalid");
  if (input.schemaVersion !== "paper-host-ipc-request-v1" || !SAFE_REQUEST_ID.test(String(input.requestId))) throw new Error("Paper host IPC request identity is invalid");
  const commands = ["host-status", "get-paper-market-runtime", "start-public-feed", "stop-public-feed", "get-paper-strategy-runtime", "get-paper-replay", "list-paper-sessions", "start-paper-session", "get-paper-session-status", "stop-paper-session", "resume-paper-session", "get-paper-session-detail", "submit-paper-order", "cancel-paper-order", "reprice-paper-order", "expire-paper-orders", "settle-paper-market", "set-paper-kill-switch", "get-paper-system-control"] as const;
  if (!commands.includes(input.command as never)) throw new Error("unsupported Paper host IPC command");
  return Object.freeze({ schemaVersion: "paper-host-ipc-request-v1", requestId: String(input.requestId), command: input.command as PaperHostIpcRequestV1["command"], payload: Object.freeze(object(input.payload, "payload")) });
}

function response(requestId: string, ok: boolean, value: unknown): PaperHostIpcResponseV1 {
  return ok
    ? Object.freeze({ schemaVersion: "paper-host-ipc-response-v1", requestId, ok, result: value })
    : Object.freeze({ schemaVersion: "paper-host-ipc-response-v1", requestId, ok, error: Object.freeze({ code: "PAPER_HOST_REQUEST_REJECTED", message: value instanceof Error ? value.message.slice(0, 500) : "Paper host request failed" }) });
}

if (process.argv[1]?.endsWith("paper-market-host.js")) {
  const dataRoot = process.env.POLYMARKET_DATA_ROOT;
  if (dataRoot === undefined || !dataRoot.startsWith("/")) throw new Error("POLYMARKET_DATA_ROOT must be an absolute path");
  const runtime = new PaperHostRuntime(dataRoot);
  await runtime.initialize();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let requestId = "invalid-request";
    try {
      const request = parsePaperHostRequest(line); requestId = request.requestId;
      writeSync(1, `${JSON.stringify(response(requestId, true, await runtime.execute(request)))}\n`);
    } catch (error: unknown) {
      writeSync(1, `${JSON.stringify(response(requestId, false, error))}\n`);
    }
  }
  await runtime.close();
}
