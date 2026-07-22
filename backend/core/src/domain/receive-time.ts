export const RECEIVE_STAMP_VERSION = "receive-stamp-v1" as const;

export interface ReceiveStamp {
  readonly schemaVersion: typeof RECEIVE_STAMP_VERSION;
  readonly clockDomain: string;
  readonly localWallReceiveTime: string;
  readonly localMonotonicReceiveNs: string;
  readonly localReceiveOrdinal: string;
}

export interface ReceiveClockOptions {
  readonly clockDomain: string;
  readonly wallNow?: () => string;
  readonly monotonicNowNs?: () => bigint;
}

const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const UNSIGNED_INTEGER = /^(?:0|[1-9]\d*)$/u;
const POSITIVE_INTEGER = /^[1-9]\d*$/u;

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be non-empty`);
  return value;
}

function wallTime(value: unknown): string {
  const text = nonEmpty(value, "localWallReceiveTime");
  const epoch = Date.parse(text);
  if (!UTC_ISO.test(text) || !Number.isFinite(epoch) || new Date(epoch).toISOString() !== text) {
    throw new Error("localWallReceiveTime must be canonical UTC milliseconds");
  }
  return text;
}

function integerText(value: unknown, field: string, positive: boolean): string {
  const text = nonEmpty(value, field);
  if (!(positive ? POSITIVE_INTEGER : UNSIGNED_INTEGER).test(text)) {
    throw new Error(`${field} must be a canonical ${positive ? "positive" : "non-negative"} integer string`);
  }
  return text;
}

export function validateReceiveStamp(value: ReceiveStamp): ReceiveStamp {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ReceiveStamp must be an object");
  }
  if (value.schemaVersion !== RECEIVE_STAMP_VERSION) throw new Error("unsupported ReceiveStamp version");
  return Object.freeze({
    schemaVersion: RECEIVE_STAMP_VERSION,
    clockDomain: nonEmpty(value.clockDomain, "clockDomain"),
    localWallReceiveTime: wallTime(value.localWallReceiveTime),
    localMonotonicReceiveNs: integerText(value.localMonotonicReceiveNs, "localMonotonicReceiveNs", false),
    localReceiveOrdinal: integerText(value.localReceiveOrdinal, "localReceiveOrdinal", true),
  });
}

/** Compare only stamps produced inside the same process clock domain. */
export function compareReceiveStamps(leftValue: ReceiveStamp, rightValue: ReceiveStamp): -1 | 0 | 1 {
  const left = validateReceiveStamp(leftValue);
  const right = validateReceiveStamp(rightValue);
  if (left.clockDomain !== right.clockDomain) throw new Error("ReceiveStamp clock domains are not comparable");
  const leftNs = BigInt(left.localMonotonicReceiveNs);
  const rightNs = BigInt(right.localMonotonicReceiveNs);
  if (leftNs !== rightNs) return leftNs < rightNs ? -1 : 1;
  const leftOrdinal = BigInt(left.localReceiveOrdinal);
  const rightOrdinal = BigInt(right.localReceiveOrdinal);
  return leftOrdinal === rightOrdinal ? 0 : leftOrdinal < rightOrdinal ? -1 : 1;
}

export function receiveStampAtOrBefore(candidate: ReceiveStamp, watermark: ReceiveStamp): boolean {
  return compareReceiveStamps(candidate, watermark) <= 0;
}

export class ReceiveClock {
  readonly #clockDomain: string;
  readonly #wallNow: () => string;
  readonly #monotonicNowNs: () => bigint;
  #ordinal = 0n;
  #lastMonotonicNs: bigint | null = null;

  constructor(options: ReceiveClockOptions) {
    this.#clockDomain = nonEmpty(options.clockDomain, "clockDomain");
    this.#wallNow = options.wallNow ?? (() => new Date().toISOString());
    this.#monotonicNowNs = options.monotonicNowNs ?? (() => process.hrtime.bigint());
  }

  capture(): ReceiveStamp {
    const monotonic = this.#monotonicNowNs();
    if (monotonic < 0n) throw new Error("monotonic receive time must not be negative");
    if (this.#lastMonotonicNs !== null && monotonic < this.#lastMonotonicNs) {
      throw new Error("monotonic receive clock reversed");
    }
    this.#lastMonotonicNs = monotonic;
    this.#ordinal += 1n;
    return validateReceiveStamp({
      schemaVersion: RECEIVE_STAMP_VERSION,
      clockDomain: this.#clockDomain,
      localWallReceiveTime: this.#wallNow(),
      localMonotonicReceiveNs: monotonic.toString(),
      localReceiveOrdinal: this.#ordinal.toString(),
    });
  }
}
