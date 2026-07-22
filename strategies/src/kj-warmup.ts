import { canonicalDecimalString } from "../../backend/core/src/adapters/market-data/parsers.js";
import { Money } from "../../backend/core/src/domain/money.js";
import { validateReceiveStamp, type ReceiveStamp } from "../../backend/core/src/domain/receive-time.js";
import type { KJPriceEvidenceInput } from "./kj-context.js";

export const KJ_PAPER_WARMUP_SIGNAL_VERSION = "kj-paper-warmup-signal-v1" as const;

export interface KJPaperWarmupSignalV1 {
  readonly schemaVersion: typeof KJ_PAPER_WARMUP_SIGNAL_VERSION;
  readonly signal: Readonly<KJPriceEvidenceInput>;
}

function utc(value: string, field: string): number {
  if (!value.endsWith("Z") || !Number.isFinite(Date.parse(value))) throw new Error(`${field} must be explicit UTC`);
  return Date.parse(value);
}

function text(value: string, field: string): string {
  if (value.trim() === "") throw new Error(`${field} must be non-empty`);
  return value;
}

function positive(value: string, field: string): string {
  const canonical = canonicalDecimalString(value);
  if (!Money.from(canonical).isPositive()) throw new Error(`${field} must be positive`);
  return canonical;
}

function freeze(signal: KJPriceEvidenceInput): KJPaperWarmupSignalV1 {
  const stamp = validateReceiveStamp(signal.receiveStamp);
  const receive = utc(signal.receiveTime, "signal.receiveTime");
  if (stamp.localWallReceiveTime !== signal.receiveTime) throw new Error("signal receiveTime disagrees with its ReceiveStamp");
  for (const [name, value] of [["sourceTime", signal.sourceTime], ["serverTime", signal.serverTime]] as const) {
    if (value !== null && utc(value, `signal.${name}`) > receive) throw new Error(`signal.${name} is from the future`);
  }
  if (signal.provider !== "BINANCE_SPOT" && signal.provider !== "POLYMARKET_RTDS_BINANCE" && signal.provider !== "POLYMARKET_RTDS_CHAINLINK") {
    throw new Error("signal provider is unsupported");
  }
  return Object.freeze({
    schemaVersion: KJ_PAPER_WARMUP_SIGNAL_VERSION,
    signal: Object.freeze({
      provider: signal.provider,
      price: positive(signal.price, "signal.price"),
      sourceTime: signal.sourceTime,
      serverTime: signal.serverTime,
      receiveTime: signal.receiveTime,
      receiveStamp: stamp as ReceiveStamp,
      connectionId: text(signal.connectionId, "signal.connectionId"),
      inputHash: text(signal.inputHash, "signal.inputHash"),
    }),
  });
}

export function createKJPaperWarmupSignal(input: KJPriceEvidenceInput): KJPaperWarmupSignalV1 {
  return freeze(input);
}

export function validateKJPaperWarmupSignal(value: unknown): KJPaperWarmupSignalV1 {
  try {
    const candidate = value as KJPaperWarmupSignalV1;
    if (candidate.schemaVersion !== KJ_PAPER_WARMUP_SIGNAL_VERSION || candidate.signal === undefined) {
      throw new Error("warmup schema is unsupported");
    }
    return freeze(candidate.signal);
  } catch (error) {
    throw new Error(`invalid persisted K/J warmup signal: ${error instanceof Error ? error.message : String(error)}`);
  }
}
