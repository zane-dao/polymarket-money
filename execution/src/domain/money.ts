import { Decimal } from "decimal.js";

export const MONEY_DECIMAL_CONTRACT_VERSION = "money-decimal-v1" as const;
export const MONEY_DECIMAL_CONFIG = Object.freeze({
  precision: 80,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -100,
  toExpPos: 100,
});

const MoneyDecimal = Decimal.clone({ ...MONEY_DECIMAL_CONFIG });
const CANONICAL_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/u;

function canonicalInput(value: unknown): string {
  if (typeof value !== "string") throw new Error("money input must be a canonical decimal string, never a number");
  if (!CANONICAL_DECIMAL.test(value) || value === "-0") {
    throw new Error("money input must be a canonical finite non-exponent decimal string");
  }
  return value;
}

function canonicalOutput(value: Decimal): string {
  if (!value.isFinite()) throw new Error("money result must be finite");
  const fixed = value.toFixed();
  if (fixed === "-0") return "0";
  const normalized = fixed.includes(".") ? fixed.replace(/0+$/u, "").replace(/\.$/u, "") : fixed;
  if (!CANONICAL_DECIMAL.test(normalized)) throw new Error("money result is not canonical");
  return normalized;
}

/** Narrow immutable wrapper; decimal.js instances never cross the domain boundary. */
export class Money {
  readonly #value: Decimal;

  private constructor(value: Decimal) {
    if (!value.isFinite()) throw new Error("Money must be finite");
    this.#value = value;
    Object.freeze(this);
  }

  static from(value: unknown): Money {
    return new Money(new MoneyDecimal(canonicalInput(value)));
  }

  static fromResult(value: Decimal): Money {
    return new Money(new MoneyDecimal(value.toFixed()));
  }

  plus(other: Money): Money { return Money.fromResult(this.#value.plus(other.#value)); }
  minus(other: Money): Money { return Money.fromResult(this.#value.minus(other.#value)); }
  times(other: Money): Money { return Money.fromResult(this.#value.times(other.#value)); }
  dividedBy(other: Money): Money {
    if (other.isZero()) throw new Error("money division by zero");
    return Money.fromResult(this.#value.dividedBy(other.#value));
  }
  modulo(other: Money): Money { return Money.fromResult(this.#value.modulo(other.#value)); }
  abs(): Money { return Money.fromResult(this.#value.abs()); }
  comparedTo(other: Money): -1 | 0 | 1 { return this.#value.comparedTo(other.#value) as -1 | 0 | 1; }
  isZero(): boolean { return this.#value.isZero(); }
  isPositive(): boolean { return this.#value.isPositive() && !this.#value.isZero(); }
  toCanonical(): string { return canonicalOutput(this.#value); }

  toDecimalPlaces(decimalPlaces: number, rounding: Decimal.Rounding): Money {
    return Money.fromResult(this.#value.toDecimalPlaces(decimalPlaces, rounding));
  }
}

export function canonicalMoney(value: unknown): string {
  return Money.from(value).toCanonical();
}

export function minimumMoney(left: Money, right: Money): Money {
  return left.comparedTo(right) <= 0 ? left : right;
}

export interface FiveDecimalResult {
  readonly value: Money | null;
  readonly tie: boolean;
}

export function roundFeeToFiveDecimals(raw: Money): FiveDecimalResult {
  if (raw.comparedTo(Money.from("0")) < 0) throw new Error("fee must not be negative");
  const quantum = Money.from("0.00001");
  const half = Money.from("0.000005");
  const remainder = raw.modulo(quantum);
  if (remainder.comparedTo(half) === 0) return Object.freeze({ value: null, tie: true });
  return Object.freeze({
    value: raw.toDecimalPlaces(5, Decimal.ROUND_HALF_EVEN),
    tie: false,
  });
}
