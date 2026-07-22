import type { PublicBtcFiveMinuteMarket } from "../adapters/market-data/public-sources.js";

export const KJ_SETTLEMENT_RECOVERY_VERSION = "kj-settlement-recovery-v1" as const;

function utc(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!value.endsWith("Z") || !Number.isFinite(parsed)) {
    throw new Error(`${field} must be explicit UTC`);
  }
  return parsed;
}

export function selectKJSettlementRecoveryMarkets(
  markets: readonly PublicBtcFiveMinuteMarket[],
  startAt: string,
  startBefore: string,
  now: string,
): readonly PublicBtcFiveMinuteMarket[] {
  const lower = utc(startAt, "startAt");
  const upper = utc(startBefore, "startBefore");
  const observed = utc(now, "now");
  if (lower >= upper) throw new Error("settlement recovery window must be non-empty");
  return Object.freeze(markets.filter((market) => {
    const start = utc(market.intervalStart, "market intervalStart");
    const end = utc(market.intervalEnd, "market intervalEnd");
    return start >= lower && start < upper && end < observed;
  }).sort((left, right) => left.intervalStart.localeCompare(right.intervalStart)));
}
