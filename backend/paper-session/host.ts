import type { PaperMarketSnapshotV1 } from "../paper-simulation/index.js";
import type { KJStrategyContextV1 } from "../../strategies/src/kj-context.js";
import type { CallerManagedPublicMarketAdapter } from "./service.js";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

export type PublicPaperFeedObserver = Readonly<{
  snapshot: (snapshot: PaperMarketSnapshotV1) => void;
  connection: (connected: boolean, observedAtUtc: string, detail: string) => void;
  gap: (marketId: string | null, observedAtUtc: string, detail: string) => void;
  error: (error: unknown, observedAtUtc: string) => void;
  strategyContext?: (context: KJStrategyContextV1) => void;
}>;

/**
 * Read-only public market input. It deliberately has no authentication, wallet,
 * signing, order, cancel, or settlement methods.
 */
export interface PublicPaperMarketFeed {
  readonly feedId: string;
  readonly source: "PUBLIC_MARKET_DATA";
  readonly access: "READ_ONLY";
  start(observer: PublicPaperFeedObserver): Promise<void>;
  stop(): Promise<void>;
}

export type PaperMarketHostLifecycle = "STOPPED" | "STARTING" | "RUNNING" | "STOPPING" | "FAILED";
export type PaperMarketHostConnection = "DISCONNECTED" | "CONNECTED" | "DEGRADED";

export type PaperMarketHostEventV1 = Readonly<{
  kind: "CONNECTION" | "GAP" | "ERROR";
  observedAtUtc: string;
  marketId: string | null;
  detail: string;
}>;

export type PaperMarketHostStatusV1 = Readonly<{
  schemaVersion: "paper-market-host-status-v1";
  hostId: string;
  feedId: string;
  source: "PUBLIC_MARKET_DATA";
  executionMode: "PAPER_ONLY";
  lifecycle: PaperMarketHostLifecycle;
  connection: PaperMarketHostConnection;
  ready: boolean;
  cachedMarketCount: number;
  snapshotCount: number;
  gapCount: number;
  errorCount: number;
  lastSnapshotAtUtc: string | null;
  lastConnectionAtUtc: string | null;
  events: readonly PaperMarketHostEventV1[];
}>;

export type PaperMarketHostOptions = Readonly<{
  hostId: string;
  maximumCachedMarkets?: number;
  maximumHealthEvents?: number;
  maximumSnapshotAgeMs?: number;
  now?: () => string;
  onSnapshot?: (snapshot: PaperMarketSnapshotV1) => void | Promise<void>;
  onStrategyContext?: (context: KJStrategyContextV1) => void;
}>;

function timestamp(value: string, field: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${field} must be a UTC ISO 8601 timestamp`);
  }
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
  return value;
}

function detail(value: string): string {
  const normalized = value.trim().replaceAll(/\s+/gu, " ");
  return (normalized === "" ? "UNSPECIFIED" : normalized).slice(0, 512);
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return typeof error === "string" ? error : "unknown public market feed error";
}

function snapshotCopy(value: PaperMarketSnapshotV1): PaperMarketSnapshotV1 {
  if (value.schemaVersion !== "paper-market-snapshot-v1" || !SAFE_ID.test(value.marketId)) {
    throw new Error("invalid paper market snapshot identity");
  }
  timestamp(value.observedAtUtc, "snapshot.observedAtUtc");
  timestamp(value.receivedAtUtc, "snapshot.receivedAtUtc");
  if (Date.parse(value.receivedAtUtc) < Date.parse(value.observedAtUtc)) {
    throw new Error("snapshot.receivedAtUtc must not precede observedAtUtc");
  }
  return Object.freeze({
    ...value,
    yesAsks: Object.freeze(value.yesAsks.map((level) => Object.freeze({ ...level }))),
    noAsks: Object.freeze(value.noAsks.map((level) => Object.freeze({ ...level }))),
  });
}

/**
 * Caller-owned, in-process Paper market host. The caller decides if/when a
 * concrete public feed is started. Constructing the host performs no I/O.
 */
export class PaperMarketHost implements CallerManagedPublicMarketAdapter {
  readonly adapterId: string;
  readonly source = "PUBLIC_MARKET_DATA" as const;
  readonly lifecycle = "CALLER_MANAGED" as const;
  readonly #feed: PublicPaperMarketFeed;
  readonly #maximumCachedMarkets: number;
  readonly #maximumHealthEvents: number;
  readonly #maximumSnapshotAgeMs: number;
  readonly #now: () => string;
  readonly #onStrategyContext: ((context: KJStrategyContextV1) => void) | undefined;
  readonly #onSnapshot: ((snapshot: PaperMarketSnapshotV1) => void | Promise<void>) | undefined;
  readonly #snapshots = new Map<string, PaperMarketSnapshotV1>();
  readonly #events: PaperMarketHostEventV1[] = [];
  #hostLifecycle: PaperMarketHostLifecycle = "STOPPED";
  #connection: PaperMarketHostConnection = "DISCONNECTED";
  #snapshotCount = 0;
  #gapCount = 0;
  #errorCount = 0;
  #lastSnapshotAtUtc: string | null = null;
  #lastConnectionAtUtc: string | null = null;
  #generation = 0;

  constructor(feed: PublicPaperMarketFeed, options: PaperMarketHostOptions) {
    if (!SAFE_ID.test(feed.feedId) || feed.source !== "PUBLIC_MARKET_DATA" || feed.access !== "READ_ONLY") {
      throw new Error("a read-only public market feed is required");
    }
    if (!SAFE_ID.test(options.hostId)) throw new Error("invalid paper market hostId");
    this.#feed = feed;
    this.adapterId = options.hostId;
    this.#maximumCachedMarkets = positiveInteger(options.maximumCachedMarkets ?? 256, "maximumCachedMarkets");
    this.#maximumHealthEvents = positiveInteger(options.maximumHealthEvents ?? 100, "maximumHealthEvents");
    this.#maximumSnapshotAgeMs = positiveInteger(options.maximumSnapshotAgeMs ?? 15_000, "maximumSnapshotAgeMs");
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#onSnapshot = options.onSnapshot;
    this.#onStrategyContext = options.onStrategyContext;
  }

  async start(): Promise<PaperMarketHostStatusV1> {
    if (this.#hostLifecycle !== "STOPPED" && this.#hostLifecycle !== "FAILED") {
      throw new Error(`paper market host cannot start while ${this.#hostLifecycle}`);
    }
    const generation = ++this.#generation;
    this.#hostLifecycle = "STARTING";
    this.#connection = "DISCONNECTED";
    const active = (): boolean => generation === this.#generation
      && (this.#hostLifecycle === "STARTING" || this.#hostLifecycle === "RUNNING");
    const observer: PublicPaperFeedObserver = Object.freeze({
      snapshot: (snapshot) => { if (active()) this.#acceptSnapshot(snapshot); },
      connection: (connected, observedAtUtc, eventDetail) => {
        if (active()) this.#recordConnection(connected, observedAtUtc, eventDetail);
      },
      gap: (marketId, observedAtUtc, eventDetail) => {
        if (active()) this.#recordGap(marketId, observedAtUtc, eventDetail);
      },
      error: (error, observedAtUtc) => {
        if (active()) this.#recordError(error, observedAtUtc);
      },
      strategyContext: (context) => {
        if (!active() || this.#onStrategyContext === undefined) return;
        try { this.#onStrategyContext(context); } catch (error: unknown) { this.#recordError(error, this.#now()); }
      },
    });
    try {
      await this.#feed.start(observer);
      if (generation === this.#generation && this.#hostLifecycle === "STARTING") this.#hostLifecycle = "RUNNING";
      return this.status();
    } catch (error: unknown) {
      if (generation === this.#generation) {
        this.#hostLifecycle = "FAILED";
        this.#connection = "DEGRADED";
        this.#recordError(error, new Date().toISOString());
      }
      throw error;
    }
  }

  async stop(): Promise<PaperMarketHostStatusV1> {
    if (this.#hostLifecycle === "STOPPED") return this.status();
    ++this.#generation;
    this.#hostLifecycle = "STOPPING";
    try {
      await this.#feed.stop();
      this.#hostLifecycle = "STOPPED";
      this.#connection = "DISCONNECTED";
      return this.status();
    } catch (error: unknown) {
      this.#hostLifecycle = "FAILED";
      this.#connection = "DEGRADED";
      this.#recordError(error, new Date().toISOString());
      throw error;
    }
  }

  isReady(): boolean {
    return this.#hostLifecycle === "RUNNING" && this.#connection === "CONNECTED" && [...this.#snapshots.values()].some((snapshot) => this.#fresh(snapshot));
  }

  latest(marketId: string): PaperMarketSnapshotV1 | null {
    if (!SAFE_ID.test(marketId)) return null;
    const snapshot = this.#snapshots.get(marketId);
    return snapshot !== undefined && this.#fresh(snapshot) ? snapshot : null;
  }

  status(): PaperMarketHostStatusV1 {
    return Object.freeze({
      schemaVersion: "paper-market-host-status-v1",
      hostId: this.adapterId,
      feedId: this.#feed.feedId,
      source: this.source,
      executionMode: "PAPER_ONLY",
      lifecycle: this.#hostLifecycle,
      connection: this.#connection,
      ready: this.isReady(),
      cachedMarketCount: this.#snapshots.size,
      snapshotCount: this.#snapshotCount,
      gapCount: this.#gapCount,
      errorCount: this.#errorCount,
      lastSnapshotAtUtc: this.#lastSnapshotAtUtc,
      lastConnectionAtUtc: this.#lastConnectionAtUtc,
      events: Object.freeze(this.#events.map((event) => Object.freeze({ ...event }))),
    });
  }

  #acceptSnapshot(value: PaperMarketSnapshotV1): void {
    try {
      const snapshot = snapshotCopy(value);
      this.#snapshots.delete(snapshot.marketId);
      this.#snapshots.set(snapshot.marketId, snapshot);
      while (this.#snapshots.size > this.#maximumCachedMarkets) {
        const oldest = this.#snapshots.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.#snapshots.delete(oldest);
      }
      this.#snapshotCount += 1;
      this.#lastSnapshotAtUtc = snapshot.receivedAtUtc;
      if (this.#onSnapshot !== undefined) {
        Promise.resolve(this.#onSnapshot(snapshot)).catch((error: unknown) => this.#recordError(error, this.#now()));
      }
    } catch (error: unknown) {
      this.#recordError(error, new Date().toISOString());
    }
  }

  #fresh(snapshot: PaperMarketSnapshotV1): boolean {
    const now = Date.parse(this.#now());
    const received = Date.parse(snapshot.receivedAtUtc);
    return Number.isFinite(now) && now >= received && now - received <= this.#maximumSnapshotAgeMs;
  }

  #recordConnection(connected: boolean, observedAtUtc: string, eventDetail: string): void {
    timestamp(observedAtUtc, "connection.observedAtUtc");
    this.#connection = connected ? "CONNECTED" : "DISCONNECTED";
    this.#lastConnectionAtUtc = observedAtUtc;
    this.#pushEvent("CONNECTION", null, observedAtUtc, eventDetail);
  }

  #recordGap(marketId: string | null, observedAtUtc: string, eventDetail: string): void {
    timestamp(observedAtUtc, "gap.observedAtUtc");
    if (marketId !== null && !SAFE_ID.test(marketId)) throw new Error("invalid gap marketId");
    this.#gapCount += 1;
    this.#connection = "DEGRADED";
    this.#pushEvent("GAP", marketId, observedAtUtc, eventDetail);
  }

  #recordError(error: unknown, observedAtUtc: string): void {
    timestamp(observedAtUtc, "error.observedAtUtc");
    this.#errorCount += 1;
    this.#connection = "DEGRADED";
    this.#pushEvent("ERROR", null, observedAtUtc, errorDetail(error));
  }

  #pushEvent(kind: PaperMarketHostEventV1["kind"], marketId: string | null, observedAtUtc: string, eventDetail: string): void {
    this.#events.push(Object.freeze({ kind, observedAtUtc, marketId, detail: detail(eventDetail) }));
    while (this.#events.length > this.#maximumHealthEvents) this.#events.shift();
  }
}
