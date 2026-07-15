import {
  canonicalDecimalString,
  compareDecimalStrings,
  type DecimalLevel,
  type ParsedClobMarketMessage,
} from "./parsers.js";

export enum BookState {
  WAITING_FOR_SNAPSHOT = "WAITING_FOR_SNAPSHOT",
  ACTIVE_UNVERIFIED = "ACTIVE_UNVERIFIED",
  STALE = "STALE",
  DISCONNECTED = "DISCONNECTED",
  RESET_REQUIRED = "RESET_REQUIRED",
}

export interface PublicOrderBookOptions {
  readonly expectedConditionId: string;
  readonly expectedAssetIds: readonly string[];
  readonly staleAfterMilliseconds: number;
}

interface MutableBook {
  readonly bids: Map<string, string>;
  readonly asks: Map<string, string>;
  sourceHash: string | null;
}

function nonEmpty(value: string, field: string): string {
  if (value.trim() === "") throw new Error(`${field} must not be empty`);
  return value;
}

function utcMilliseconds(value: string, field: string): number {
  if (!value.endsWith("Z")) throw new Error(`${field} must be an explicit UTC timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be a valid UTC timestamp`);
  return parsed;
}

function decimalMap(levels: readonly DecimalLevel[], field: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const level of levels) {
    const price = canonicalDecimalString(level.price);
    if (result.has(price)) throw new Error(`${field} contains duplicate price ${price}`);
    result.set(price, level.size);
  }
  return result;
}

function extreme(prices: Iterable<string>, side: "bid" | "ask"): string | null {
  const values = [...prices];
  if (values.length === 0) return null;
  return values.reduce((best, candidate) => {
    const comparison = compareDecimalStrings(candidate, best);
    return side === "bid" ? (comparison > 0 ? candidate : best) : comparison < 0 ? candidate : best;
  });
}

function crossed(book: MutableBook): boolean {
  const bestBid = extreme(book.bids.keys(), "bid");
  const bestAsk = extreme(book.asks.keys(), "ask");
  return bestBid !== null && bestAsk !== null && compareDecimalStrings(bestBid, bestAsk) > 0;
}

/**
 * Public CLOB state is intentionally called unverified: the official feed has
 * no documented sequence/offset from which gap-free continuity can be proven.
 */
export class PublicOrderBook {
  #state: BookState = BookState.DISCONNECTED;
  #connectionId: string | null = null;
  readonly #expectedConditionId: string;
  readonly #expectedAssetIds: ReadonlySet<string>;
  readonly #staleAfterMilliseconds: number;
  readonly #books = new Map<string, MutableBook>();
  readonly #qualityEvents: string[] = [];
  readonly #lastProviderTimestampByAsset = new Map<string, bigint>();
  #lastReceiveMilliseconds: number | null = null;

  constructor(options: PublicOrderBookOptions) {
    this.#expectedConditionId = nonEmpty(options.expectedConditionId, "expectedConditionId");
    if (options.expectedAssetIds.length === 0) throw new Error("expectedAssetIds must not be empty");
    const assets = options.expectedAssetIds.map((assetId, index) =>
      nonEmpty(assetId, `expectedAssetIds[${index}]`),
    );
    if (new Set(assets).size !== assets.length) throw new Error("expectedAssetIds must be unique");
    if (!Number.isSafeInteger(options.staleAfterMilliseconds) || options.staleAfterMilliseconds <= 0) {
      throw new Error("staleAfterMilliseconds must be a positive integer");
    }
    this.#expectedAssetIds = new Set(assets);
    this.#staleAfterMilliseconds = options.staleAfterMilliseconds;
  }

  get state(): BookState {
    return this.#state;
  }

  get continuity(): "UNVERIFIED" {
    return "UNVERIFIED";
  }

  get qualityEvents(): readonly string[] {
    return Object.freeze([...this.#qualityEvents]);
  }

  get allExpectedAssetsReady(): boolean {
    return this.#allExpectedAssetsReady();
  }

  connected(connectionId: string, connectedAt: string): void {
    this.#connectionId = nonEmpty(connectionId, "connectionId");
    this.#books.clear();
    this.#lastProviderTimestampByAsset.clear();
    this.#lastReceiveMilliseconds = utcMilliseconds(connectedAt, "connectedAt");
    this.#state = BookState.WAITING_FOR_SNAPSHOT;
  }

  disconnected(): void {
    this.#books.clear();
    this.#connectionId = null;
    this.#lastProviderTimestampByAsset.clear();
    this.#lastReceiveMilliseconds = null;
    this.#state = BookState.DISCONNECTED;
  }

  markStale(): void {
    this.#books.clear();
    this.#lastProviderTimestampByAsset.clear();
    this.#state = BookState.STALE;
  }

  markStaleIfExpired(now: string): boolean {
    if (this.#state !== BookState.WAITING_FOR_SNAPSHOT && this.#state !== BookState.ACTIVE_UNVERIFIED) {
      return false;
    }
    const nowMilliseconds = utcMilliseconds(now, "now");
    if (this.#lastReceiveMilliseconds === null) return false;
    if (nowMilliseconds < this.#lastReceiveMilliseconds) {
      this.#qualityEvents.push("LOCAL_RECEIVE_TIMESTAMP_REVERSED");
      return false;
    }
    if (nowMilliseconds - this.#lastReceiveMilliseconds < this.#staleAfterMilliseconds) return false;
    this.markStale();
    return true;
  }

  applySnapshot(message: ParsedClobMarketMessage, connectionId: string, receiveTime: string): void {
    this.#requireConnection(connectionId);
    if (
      message.parserStatus !== "parsed" ||
      message.eventType !== "book" ||
      message.assetId === null ||
      message.bids === null ||
      message.asks === null
    ) {
      this.#failReset("a valid full book snapshot is required");
    }
    this.#requireExpectedMessage(message.conditionId, message.assetId);
    const nextBook: MutableBook = {
      bids: decimalMap(message.bids, "bids"),
      asks: decimalMap(message.asks, "asks"),
      sourceHash: message.sourceHash,
    };
    if (crossed(nextBook)) {
      this.#qualityEvents.push(`CROSSED_BOOK:${message.assetId}`);
      this.#failReset(`crossed snapshot for ${message.assetId}`);
    }
    this.#observeReceiveTime(receiveTime);
    this.#observeProviderTimestamp(message.assetId, message.providerTimestampRaw);
    this.#books.set(message.assetId, nextBook);
    this.#state = this.#allExpectedAssetsReady()
      ? BookState.ACTIVE_UNVERIFIED
      : BookState.WAITING_FOR_SNAPSHOT;
  }

  applyPriceChange(message: ParsedClobMarketMessage, connectionId: string, receiveTime: string): void {
    this.#requireConnection(connectionId);
    if (this.#state !== BookState.ACTIVE_UNVERIFIED && this.#state !== BookState.WAITING_FOR_SNAPSHOT) {
      this.#failReset("price change cannot be applied without a fresh connection baseline");
    }
    if (message.parserStatus !== "parsed" || message.eventType !== "price_change" || message.priceChanges === null) {
      this.#failReset("invalid price_change event");
    }
    if (message.conditionId !== this.#expectedConditionId) {
      this.#failReset("price_change condition does not match the expected market");
    }
    const affectedAssets = new Set(message.priceChanges.map((change) => change.assetId));
    for (const assetId of affectedAssets) {
      if (!this.#expectedAssetIds.has(assetId)) this.#failReset(`unexpected asset ${assetId}`);
      if (!this.#books.has(assetId)) this.#failReset(`price change for ${assetId} arrived before its snapshot`);
    }

    const staged = new Map<string, MutableBook>();
    for (const assetId of affectedAssets) {
      const current = this.#books.get(assetId);
      if (current === undefined) this.#failReset(`book for ${assetId} disappeared`);
      staged.set(assetId, {
        bids: new Map(current.bids),
        asks: new Map(current.asks),
        sourceHash: current.sourceHash,
      });
    }
    for (const change of message.priceChanges) {
      const book = staged.get(change.assetId);
      if (book === undefined) this.#failReset("book disappeared during atomic update");
      const side = change.side === "BUY" ? book.bids : book.asks;
      const price = canonicalDecimalString(change.price);
      if (change.deleteLevel) side.delete(price);
      else side.set(price, change.size);
      book.sourceHash = change.sourceHash;
    }
    for (const [assetId, book] of staged) {
      if (crossed(book)) {
        this.#qualityEvents.push(`CROSSED_BOOK:${assetId}`);
        this.#failReset(`price_change would cross book ${assetId}`);
      }
    }

    this.#observeReceiveTime(receiveTime);
    for (const assetId of affectedAssets) this.#observeProviderTimestamp(assetId, message.providerTimestampRaw);
    for (const [assetId, book] of staged) this.#books.set(assetId, book);
    this.#state = this.#allExpectedAssetsReady()
      ? BookState.ACTIVE_UNVERIFIED
      : BookState.WAITING_FOR_SNAPSHOT;
  }

  bestBid(assetId: string): string | null {
    return this.#extreme(assetId, "bid");
  }

  bestAsk(assetId: string): string | null {
    return this.#extreme(assetId, "ask");
  }

  #requireConnection(connectionId: string): void {
    if (this.#connectionId === null || connectionId !== this.#connectionId) {
      this.#failReset("event belongs to a stale or unknown connection");
    }
  }

  #requireExpectedMessage(conditionId: string | null, assetId: string): void {
    if (conditionId !== this.#expectedConditionId) {
      this.#failReset("snapshot condition does not match the expected market");
    }
    if (!this.#expectedAssetIds.has(assetId)) this.#failReset(`unexpected asset ${assetId}`);
  }

  #observeProviderTimestamp(assetId: string, raw: string | null): void {
    if (raw === null || !/^[0-9]+$/.test(raw)) return;
    const current = BigInt(raw);
    const previous = this.#lastProviderTimestampByAsset.get(assetId);
    if (previous !== undefined && current < previous) {
      this.#qualityEvents.push(`CLOB_PROVIDER_TIMESTAMP_REVERSED:${assetId}`);
    }
    this.#lastProviderTimestampByAsset.set(assetId, current);
  }

  #observeReceiveTime(receiveTime: string): void {
    const current = utcMilliseconds(receiveTime, "receiveTime");
    if (this.#lastReceiveMilliseconds !== null && current < this.#lastReceiveMilliseconds) {
      this.#qualityEvents.push("LOCAL_RECEIVE_TIMESTAMP_REVERSED");
      return;
    }
    this.#lastReceiveMilliseconds = current;
  }

  #allExpectedAssetsReady(): boolean {
    return [...this.#expectedAssetIds].every((assetId) => this.#books.has(assetId));
  }

  #extreme(assetId: string, side: "bid" | "ask"): string | null {
    if (this.#state !== BookState.ACTIVE_UNVERIFIED || !this.#expectedAssetIds.has(assetId)) return null;
    const book = this.#books.get(assetId);
    if (book === undefined) return null;
    return extreme(side === "bid" ? book.bids.keys() : book.asks.keys(), side);
  }

  #failReset(message: string): never {
    this.#state = BookState.RESET_REQUIRED;
    throw new Error(message);
  }
}
