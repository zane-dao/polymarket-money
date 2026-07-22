import { createHash } from "node:crypto";

import {
  validatePublicBtcFiveMinuteMarket,
  type PublicBtcFiveMinuteMarket,
} from "../market-data/public-sources.js";
import { Money } from "../../domain/money.js";
import type { KJOfficialSettlement } from "../../runtime/kj-paper-engine.js";

export const GAMMA_RESOLUTION_ADAPTER_VERSION = "gamma-resolution-adapter-v1" as const;

export interface GammaResolutionInput {
  readonly expectedMarket: PublicBtcFiveMinuteMarket;
  readonly responseStatus: number;
  readonly rawPayload: string;
  readonly receiveTime: string;
}

export class GammaResolutionPending extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GammaResolutionPending";
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be non-empty`);
  return value;
}

function utcMilliseconds(value: unknown, field: string): number {
  const candidate = text(value, field);
  if (!candidate.endsWith("Z")) throw new Error(`${field} must be explicit UTC`);
  const parsed = Date.parse(candidate);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be valid UTC`);
  return parsed;
}

function stringArray(value: unknown, field: string): readonly string[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      throw new Error(`${field} must contain a JSON string array`, { cause: error });
    }
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`${field} must be a string array`);
  }
  return Object.freeze([...parsed]);
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function identityHash(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function createKJOfficialSettlementFromGamma(
  input: GammaResolutionInput,
): KJOfficialSettlement {
  if (input.responseStatus !== 200) {
    throw new GammaResolutionPending("Gamma resolution response is not HTTP 200 yet");
  }
  const received = utcMilliseconds(input.receiveTime, "Gamma resolution receiveTime");
  const expectedEnd = utcMilliseconds(input.expectedMarket.intervalEnd, "expected market intervalEnd");
  if (received <= expectedEnd) throw new Error("Gamma resolution evidence must arrive after market end");

  const resolvedMarket = validatePublicBtcFiveMinuteMarket(input.rawPayload);
  for (const field of [
    "marketId",
    "conditionId",
    "slug",
    "upTokenId",
    "downTokenId",
  ] as const) {
    if (resolvedMarket[field] !== input.expectedMarket[field]) {
      throw new Error(`Gamma resolution conflicts with expected market ${field}`);
    }
  }
  for (const field of ["intervalStart", "intervalEnd"] as const) {
    if (Date.parse(resolvedMarket[field]) !== Date.parse(input.expectedMarket[field])) {
      throw new Error(`Gamma resolution conflicts with expected market ${field}`);
    }
  }
  if (resolvedMarket.closed !== true || resolvedMarket.acceptingOrders !== false) {
    throw new GammaResolutionPending("Gamma resolution market is not closed yet");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawPayload);
  } catch (error) {
    throw new Error("Gamma resolution payload is invalid JSON", { cause: error });
  }
  const market = object(parsed, "Gamma resolution market");
  if (market.umaResolutionStatus !== "resolved") {
    throw new GammaResolutionPending("Gamma UMA resolution status is not resolved yet");
  }
  const resolutionTimeValue = market.umaEndDate ?? market.closedTime;
  const resolutionTime = utcMilliseconds(resolutionTimeValue, "Gamma resolution time");
  if (resolutionTime < expectedEnd || resolutionTime > received) {
    throw new Error("Gamma resolution time is outside the observable post-market interval");
  }

  const outcomes = stringArray(market.outcomes, "Gamma outcomes");
  const prices = stringArray(market.outcomePrices, "Gamma outcomePrices");
  const tokens = stringArray(market.clobTokenIds, "Gamma clobTokenIds");
  if (outcomes.length !== 2 || prices.length !== 2 || tokens.length !== 2) {
    throw new Error("Gamma resolution requires exactly two aligned outcomes, prices, and tokens");
  }
  const expectedTokens = new Map([
    ["up", input.expectedMarket.upTokenId],
    ["down", input.expectedMarket.downTokenId],
  ]);
  let winner: "UP" | "DOWN" | null = null;
  const seen = new Set<string>();
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index]!.trim().toLowerCase();
    if ((outcome !== "up" && outcome !== "down") || seen.has(outcome)) {
      throw new Error("Gamma resolution outcomes must be distinct Up and Down");
    }
    seen.add(outcome);
    if (tokens[index] !== expectedTokens.get(outcome)) {
      throw new Error("Gamma resolution outcome/token mapping conflicts with the expected market");
    }
    const price = Money.from(prices[index]);
    if (!price.isZero() && price.comparedTo(Money.from("1")) !== 0) {
      throw new Error("Gamma resolution outcome prices must be exact zero or one");
    }
    if (price.comparedTo(Money.from("1")) === 0) {
      if (winner !== null) throw new Error("Gamma resolution has multiple winning outcomes");
      winner = outcome === "up" ? "UP" : "DOWN";
    }
  }
  if (seen.size !== 2 || winner === null) throw new Error("Gamma resolution has no unique winner");
  const rawHash = digest(input.rawPayload);
  return Object.freeze({
    settlementId: identityHash(
      GAMMA_RESOLUTION_ADAPTER_VERSION,
      input.expectedMarket.conditionId,
      winner,
      rawHash,
    ),
    marketId: input.expectedMarket.marketId,
    winner,
    settlementTime: input.receiveTime,
    evidenceStatus: "OFFICIAL_RESOLUTION",
    evidenceReference: `gamma-market-by-slug:${input.expectedMarket.slug}:sha256:${rawHash}`,
  });
}
