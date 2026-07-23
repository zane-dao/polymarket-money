import type { PaperMarketSnapshotV1 } from "../paper-simulation/index.js";
import type { PublicPaperFeedObserver, PublicPaperMarketFeed } from "./host.js";
import { PublicBinanceSpotFeed, type BinanceSpotObservationV1, type PublicBinanceSpotSource } from "./public-binance-feed.js";
import { PublicClobPaperMarketFeed, type PublicClobStrategyObservationV1, type PublicClobStrategySource } from "./public-clob-feed.js";
import { ReceiveClock, type ReceiveStamp } from "../core/src/domain/receive-time.js";
import { Money } from "../core/src/domain/money.js";
import { createKJStrategyContext } from "../../strategies/src/kj-context.js";

export class PublicBtcPaperMarketFeed implements PublicPaperMarketFeed {
  readonly feedId: string;
  readonly source = "PUBLIC_MARKET_DATA" as const;
  readonly access = "READ_ONLY" as const;
  readonly #clob: PublicClobStrategySource;
  readonly #binance: PublicBinanceSpotSource;
  readonly #maximumSignalAgeMs: number;
  readonly #now: () => string;
  #observer: PublicPaperFeedObserver | null = null;
  #clobConnected = false;
  #binanceConnected = false;
  #lastPublishedConnection = false;
  #snapshot: PaperMarketSnapshotV1 | null = null;
  #book: Readonly<{ value: PublicClobStrategyObservationV1; stamp: ReceiveStamp }> | null = null;
  #signal: Readonly<{ value: BinanceSpotObservationV1; stamp: ReceiveStamp }> | null = null;
  #lastPublishedBookFingerprint: string | null = null;
  readonly #clock: ReceiveClock;

  constructor(feedId: string, clob: PublicClobStrategySource, binance: PublicBinanceSpotSource, options: { maximumSignalAgeMs?: number; now?: () => string; receiveClock?: ReceiveClock } = {}) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(feedId)) throw new Error("invalid combined public feedId");
    if (clob.source !== "PUBLIC_MARKET_DATA" || clob.access !== "READ_ONLY" || binance.source !== "PUBLIC_BINANCE_SPOT" || binance.access !== "READ_ONLY") throw new Error("combined feed requires read-only public sources");
    this.feedId = feedId; this.#clob = clob; this.#binance = binance; this.#maximumSignalAgeMs = options.maximumSignalAgeMs ?? 5_000; this.#now = options.now ?? (() => new Date().toISOString());
    this.#clock = options.receiveClock ?? new ReceiveClock({ clockDomain: `paper-btc-${feedId}`, wallNow: this.#now });
  }

  async start(observer: PublicPaperFeedObserver): Promise<void> {
    if (this.#observer !== null) throw new Error("combined public BTC feed is already started");
    this.#observer = observer; this.#snapshot = null; this.#book = null; this.#signal = null; this.#clobConnected = false; this.#binanceConnected = false; this.#lastPublishedConnection = false; this.#lastPublishedBookFingerprint = null;
    try {
      await Promise.all([
        this.#clob.start({
          snapshot: (snapshot) => { this.#snapshot = snapshot; const value=this.#clob.latestStrategyObservation(); if(value!==null)this.#book=Object.freeze({value,stamp:this.#clock.capture()}); this.#publishBookChange(); },
          connection: (connected, at, detail) => { this.#clobConnected = connected; this.#connection(at, `CLOB: ${detail}`); },
          gap: (marketId, at, detail) => observer.gap(marketId, at, `CLOB: ${detail}`),
          error: (error, at) => observer.error(error, at),
        }),
        this.#binance.start({
          ticker: (value) => { this.#signal=Object.freeze({value,stamp:this.#clock.capture()}); },
          connection: (connected, at, detail) => { this.#binanceConnected = connected; this.#connection(at, `BINANCE: ${detail}`); },
          error: (error, at) => observer.error(error, at),
        }),
      ]);
    } catch (error) { await this.stop(); throw error; }
  }

  async stop(): Promise<void> {
    const observer = this.#observer; this.#observer = null;
    await Promise.allSettled([this.#clob.stop(), this.#binance.stop()]);
    this.#snapshot = null; this.#book = null; this.#signal = null; this.#clobConnected = false; this.#binanceConnected = false;
    if (observer !== null && this.#lastPublishedConnection) observer.connection(false, this.#now(), "combined public BTC feed stopped");
    this.#lastPublishedConnection = false; this.#lastPublishedBookFingerprint = null;
  }

  latestBinance(): BinanceSpotObservationV1 | null { const value = this.#binance.latest(); return value !== null && this.#signalFresh(value) ? value : null; }
  #signalFresh(value: BinanceSpotObservationV1): boolean { const age = Date.parse(this.#now()) - Date.parse(value.receivedAtUtc); return Number.isFinite(age) && age >= 0 && age <= this.#maximumSignalAgeMs; }
  #publishBookChange(): void {
    const snapshot = this.#snapshot; const book=this.#book; const signal=this.#signal;
    if (snapshot === null || book===null || signal===null || !this.#clobConnected || !this.#binanceConnected || this.latestBinance()===null)return;
    const fingerprint = [
      book.value.market.marketId,
      book.value.up.bid, book.value.up.ask, book.value.up.bidSize, book.value.up.askSize,
      book.value.down.bid, book.value.down.ask, book.value.down.bidSize, book.value.down.askSize,
    ].join("\0");
    if (fingerprint === this.#lastPublishedBookFingerprint) return;
    this.#lastPublishedBookFingerprint=fingerprint;
    const now=this.#now();
    this.#observer?.snapshot(snapshot);
    const midpoint=Money.from(signal.value.bid).plus(Money.from(signal.value.ask)).dividedBy(Money.from("2")).toCanonical();
    const result=createKJStrategyContext({decisionTime:now,market:book.value.market,book:{state:book.value.state,continuity:book.value.continuity,up:book.value.up,down:book.value.down,receiveStamp:book.stamp},signal:{provider:"BINANCE_SPOT",price:midpoint,sourceTime:signal.value.sourceTime,serverTime:signal.value.serverTime,receiveTime:signal.stamp.localWallReceiveTime,receiveStamp:signal.stamp,connectionId:signal.value.connectionId,inputHash:signal.value.inputHash}});
    if(result.ready)this.#observer?.strategyContext?.(result.context); else this.#observer?.gap(book.value.market.marketId,now,result.reason);
  }
  #connection(at: string, detail: string): void { const connected = this.#clobConnected && this.#binanceConnected; if (connected !== this.#lastPublishedConnection) { this.#lastPublishedConnection = connected; this.#observer?.connection(connected, at, detail); } }
}

export type PublicBtcFeedFactory = (slug: string) => PublicPaperMarketFeed;
export type RotationTimer = ReturnType<typeof setTimeout>;
export type PublicBtcRotationOptions = Readonly<{
  nowMs?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => RotationTimer;
  clearTimer?: (timer: RotationTimer) => void;
  retryDelaysMs?: readonly number[];
}>;

const FIVE_MINUTES_SECONDS = 300;

/**
 * Owns exactly one concrete BTC five-minute feed at a time. Construction is
 * inert. Rotation invalidates the old observer generation before stopping the
 * old feed, so late WebSocket callbacks cannot contaminate the next market.
 */
export class RotatingPublicBtcPaperMarketFeed implements PublicPaperMarketFeed {
  readonly feedId: string;
  readonly source = "PUBLIC_MARKET_DATA" as const;
  readonly access = "READ_ONLY" as const;
  readonly #initialEpoch: number;
  readonly #factory: PublicBtcFeedFactory;
  readonly #nowMs: () => number;
  readonly #setTimer: (callback: () => void, delayMs: number) => RotationTimer;
  readonly #clearTimer: (timer: RotationTimer) => void;
  readonly #retryDelaysMs: readonly number[];
  #observer: PublicPaperFeedObserver | null = null;
  #active: PublicPaperMarketFeed | null = null;
  #timer: RotationTimer | null = null;
  #generation = 0;
  #retryIndex = 0;

  constructor(initialSlug: string, factory: PublicBtcFeedFactory, options: PublicBtcRotationOptions = {}) {
    this.#initialEpoch = parseBtcFiveMinuteSlug(initialSlug);
    this.feedId = `public-btc-rotating-${this.#initialEpoch}`;
    this.#factory = factory;
    this.#nowMs = options.nowMs ?? Date.now;
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    const delays = options.retryDelaysMs ?? [1_000, 5_000, 15_000];
    if (delays.some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new Error("rotation retry delays must be positive integers");
    this.#retryDelaysMs = Object.freeze([...delays]);
  }

  async start(observer: PublicPaperFeedObserver): Promise<void> {
    if (this.#observer !== null) throw new Error("rotating public BTC feed is already started");
    if (!Number.isFinite(this.#nowMs())) throw new Error("rotation clock is invalid");
    this.#observer = observer; this.#retryIndex = 0;
    await this.#activate(this.#epochAt(this.#nowMs()));
  }

  async stop(): Promise<void> {
    ++this.#generation;
    const observer = this.#observer; this.#observer = null;
    if (this.#timer !== null) { this.#clearTimer(this.#timer); this.#timer = null; }
    const active = this.#active; this.#active = null;
    if (active !== null) await active.stop();
    if (observer !== null) observer.connection(false, this.#nowUtc(), "BTC five-minute rotation explicitly stopped");
  }

  async #activate(epoch: number): Promise<void> {
    if (this.#observer === null) return;
    const generation = ++this.#generation;
    if (this.#timer !== null) { this.#clearTimer(this.#timer); this.#timer = null; }
    const previous = this.#active; this.#active = null;
    if (previous !== null) {
      try { await previous.stop(); }
      catch (error: unknown) { if (this.#current(generation)) this.#observer?.error(error, this.#nowUtc()); }
    }
    if (!this.#current(generation)) return;
    const slug = `btc-updown-5m-${epoch}`;
    let feed: PublicPaperMarketFeed | null = null;
    try {
      feed = this.#factory(slug);
      if (feed.source !== "PUBLIC_MARKET_DATA" || feed.access !== "READ_ONLY") throw new Error("rotation factory must return a read-only public feed");
      this.#active = feed;
      await feed.start(this.#guardedObserver(generation, slug));
      if (!this.#current(generation)) { await feed.stop(); return; }
      this.#retryIndex = 0;
      this.#scheduleBoundary(epoch);
    } catch (error: unknown) {
      if (!this.#current(generation)) return;
      this.#active = null;
      if (feed !== null) {
        try { await feed.stop(); } catch (stopError: unknown) { this.#observer?.error(stopError, this.#nowUtc()); }
      }
      this.#observer?.connection(false, this.#nowUtc(), `rotation degraded for ${slug}`);
      this.#observer?.error(error, this.#nowUtc());
      this.#scheduleRetryOrBoundary(epoch);
    }
  }

  #guardedObserver(generation: number, slug: string): PublicPaperFeedObserver {
    const active = (): boolean => this.#current(generation);
    return Object.freeze({
      snapshot: (value) => { if (active()) this.#observer?.snapshot(value); },
      connection: (connected, at, detail) => { if (active()) this.#observer?.connection(connected, at, `${slug}: ${detail}`); },
      gap: (marketId, at, detail) => { if (active()) this.#observer?.gap(marketId, at, `${slug}: ${detail}`); },
      error: (error, at) => { if (active()) this.#observer?.error(error, at); },
      strategyContext: (context) => { if (active()) this.#observer?.strategyContext?.(context); },
    });
  }

  #scheduleBoundary(epoch: number): void {
    const nextEpoch = Math.max(epoch + FIVE_MINUTES_SECONDS, this.#epochAt(this.#nowMs()) + FIVE_MINUTES_SECONDS);
    this.#schedule(Math.max(0, nextEpoch * 1_000 - this.#nowMs()), () => this.#activate(nextEpoch));
  }

  #scheduleRetryOrBoundary(failedEpoch: number): void {
    const delay = this.#retryDelaysMs[this.#retryIndex];
    if (delay !== undefined) {
      this.#retryIndex += 1;
      this.#schedule(delay, () => this.#activate(this.#epochAt(this.#nowMs())));
      return;
    }
    this.#retryIndex = 0;
    this.#scheduleBoundary(Math.max(failedEpoch, this.#epochAt(this.#nowMs())));
  }

  #schedule(delayMs: number, operation: () => Promise<void>): void {
    if (this.#observer === null) return;
    this.#timer = this.#setTimer(() => { this.#timer = null; void operation().catch((error: unknown) => this.#observer?.error(error, this.#nowUtc())); }, delayMs);
  }

  #epochAt(nowMs: number): number {
    const nowSeconds = Math.floor(nowMs / 1_000);
    if (nowSeconds <= this.#initialEpoch) return this.#initialEpoch;
    return this.#initialEpoch + Math.floor((nowSeconds - this.#initialEpoch) / FIVE_MINUTES_SECONDS) * FIVE_MINUTES_SECONDS;
  }
  #current(generation: number): boolean { return this.#observer !== null && generation === this.#generation; }
  #nowUtc(): string { return new Date(this.#nowMs()).toISOString(); }
}

export function parseBtcFiveMinuteSlug(slug: string): number {
  const match = /^btc-updown-5m-([1-9][0-9]{9})$/u.exec(slug);
  const epoch = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(epoch) || epoch % FIVE_MINUTES_SECONDS !== 0) throw new Error("BTC five-minute slug must contain an aligned epoch");
  return epoch;
}

function createSinglePublicBtcPaperMarketFeed(slug: string): PublicBtcPaperMarketFeed {
  return new PublicBtcPaperMarketFeed(
    `public-btc-${slug}`,
    new PublicClobPaperMarketFeed({ slug, useWebSocket: true }),
    new PublicBinanceSpotFeed(undefined, { useWebSocket: true }),
  );
}

export function createPublicBtcPaperMarketFeed(slug: string): RotatingPublicBtcPaperMarketFeed {
  return new RotatingPublicBtcPaperMarketFeed(slug, createSinglePublicBtcPaperMarketFeed);
}
