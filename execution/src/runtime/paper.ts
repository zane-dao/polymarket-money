export type ObserverName =
  | "NO_TRADE"
  | "COMPLETE_SET_ARBITRAGE_OBSERVER"
  | "LEAD_LAG_OBSERVER"
  | "MAKER_ENVELOPE_OBSERVER";

export interface TopOfBookSide {
  readonly bid: string;
  readonly ask: string;
  readonly bidSize: string;
  readonly askSize: string;
}

export interface PaperSnapshot {
  readonly observedAt: string;
  readonly marketId: string;
  readonly up: TopOfBookSide;
  readonly down: TopOfBookSide;
  readonly chainlink: string | null;
  readonly binanceSpot: string | null;
  readonly binancePerpetual: string | null;
  readonly continuity: "UNVERIFIED";
}

export interface TheoreticalFill {
  readonly classification: "THEORETICAL_FILL";
  readonly token: "UP" | "DOWN";
  readonly side: "BUY";
  readonly price: string;
  readonly quantity: string;
  readonly observedAt: string;
}

export interface PaperAudit {
  readonly observer: ObserverName;
  readonly observedAt: string;
  readonly marketId: string;
  readonly orderSubmitted: false;
  readonly claimsRealProfit: false;
  readonly fills: readonly TheoreticalFill[];
  readonly executableQuantity: string;
  readonly edgeAfterFees: string | null;
  readonly leggingRisk: "NONE_NO_TRADE" | "TWO_LEG_ATOMICITY_UNAVAILABLE" | "NOT_APPLICABLE";
  readonly queuePosition: null;
  readonly fillLowerBound: string | null;
  readonly fillUpperBound: string | null;
  readonly details: Readonly<Record<string, string | boolean | null>>;
}

interface DecimalValue {
  readonly coefficient: bigint;
  readonly scale: number;
}

function decimal(value: string): DecimalValue {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) throw new Error(`invalid decimal: ${value}`);
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const coefficient = BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n);
  return { coefficient, scale: fraction.length };
}

function align(left: DecimalValue, right: DecimalValue): readonly [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.coefficient * 10n ** BigInt(scale - left.scale),
    right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  ];
}

function add(left: DecimalValue, right: DecimalValue): DecimalValue {
  const [a, b, scale] = align(left, right);
  return { coefficient: a + b, scale };
}

function subtract(left: DecimalValue, right: DecimalValue): DecimalValue {
  const [a, b, scale] = align(left, right);
  return { coefficient: a - b, scale };
}

function multiply(left: DecimalValue, right: DecimalValue): DecimalValue {
  return { coefficient: left.coefficient * right.coefficient, scale: left.scale + right.scale };
}

function minimum(left: DecimalValue, right: DecimalValue): DecimalValue {
  const [a, b] = align(left, right);
  return a <= b ? left : right;
}

function format(value: DecimalValue): string {
  const negative = value.coefficient < 0n;
  const digits = (negative ? -value.coefficient : value.coefficient)
    .toString()
    .padStart(value.scale + 1, "0");
  if (value.scale === 0) return `${negative ? "-" : ""}${digits}`;
  const whole = digits.slice(0, -value.scale);
  const fraction = digits.slice(-value.scale).replace(/0+$/u, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

const ZERO = decimal("0");
const ONE = decimal("1");

function base(snapshot: PaperSnapshot, observer: ObserverName): Omit<PaperAudit, "fills" | "executableQuantity" | "edgeAfterFees" | "leggingRisk" | "fillLowerBound" | "fillUpperBound" | "details"> {
  return {
    observer,
    observedAt: snapshot.observedAt,
    marketId: snapshot.marketId,
    orderSubmitted: false,
    claimsRealProfit: false,
    queuePosition: null,
  };
}

export function noTradeObserver(snapshot: PaperSnapshot): PaperAudit {
  return {
    ...base(snapshot, "NO_TRADE"),
    fills: [],
    executableQuantity: "0",
    edgeAfterFees: null,
    leggingRisk: "NONE_NO_TRADE",
    fillLowerBound: null,
    fillUpperBound: null,
    details: { reason: "EXPLICIT_NO_TRADE" },
  };
}

export function completeSetArbitrageObserver(
  snapshot: PaperSnapshot,
  options: { readonly feeRate: string | null; readonly latencyMilliseconds: number },
): PaperAudit {
  if (!Number.isSafeInteger(options.latencyMilliseconds) || options.latencyMilliseconds < 0) {
    throw new Error("latencyMilliseconds must be a non-negative safe integer");
  }
  const upAsk = decimal(snapshot.up.ask);
  const downAsk = decimal(snapshot.down.ask);
  if (options.feeRate === null) {
    return {
      ...base(snapshot, "COMPLETE_SET_ARBITRAGE_OBSERVER"),
      fills: [],
      executableQuantity: "0",
      edgeAfterFees: null,
      leggingRisk: "NOT_APPLICABLE",
      fillLowerBound: null,
      fillUpperBound: null,
      details: {
        feeRate: null,
        configuredLatencyMilliseconds: String(options.latencyMilliseconds),
        warning: "UNKNOWN_FEE_RATE_NO_EXECUTABLE_EDGE",
      },
    };
  }
  const feeRate = decimal(options.feeRate);
  const upFee = multiply(multiply(feeRate, upAsk), subtract(ONE, upAsk));
  const downFee = multiply(multiply(feeRate, downAsk), subtract(ONE, downAsk));
  const edge = subtract(ONE, add(add(upAsk, downAsk), add(upFee, downFee)));
  const quantity = minimum(decimal(snapshot.up.askSize), decimal(snapshot.down.askSize));
  const executable = edge.coefficient > 0n && quantity.coefficient > 0n;
  return {
    ...base(snapshot, "COMPLETE_SET_ARBITRAGE_OBSERVER"),
    fills: executable
      ? [
          { classification: "THEORETICAL_FILL", token: "UP", side: "BUY", price: snapshot.up.ask, quantity: format(quantity), observedAt: snapshot.observedAt },
          { classification: "THEORETICAL_FILL", token: "DOWN", side: "BUY", price: snapshot.down.ask, quantity: format(quantity), observedAt: snapshot.observedAt },
        ]
      : [],
    executableQuantity: executable ? format(quantity) : "0",
    edgeAfterFees: format(edge),
    leggingRisk: executable ? "TWO_LEG_ATOMICITY_UNAVAILABLE" : "NOT_APPLICABLE",
    fillLowerBound: null,
    fillUpperBound: null,
    details: {
      feeRate: options.feeRate,
      configuredLatencyMilliseconds: String(options.latencyMilliseconds),
      warning: "THEORETICAL_TWO_LEG_EXECUTION_NOT_ATOMIC",
    },
  };
}

export function leadLagObserver(
  snapshot: PaperSnapshot,
  options: { readonly referenceChangeBps: string; readonly thresholdBps: string },
): PaperAudit {
  const change = decimal(options.referenceChangeBps);
  const threshold = decimal(options.thresholdBps);
  const [changeValue, thresholdValue] = align(change, threshold);
  const detected = (changeValue < 0n ? -changeValue : changeValue) >= thresholdValue;
  return {
    ...base(snapshot, "LEAD_LAG_OBSERVER"),
    fills: [],
    executableQuantity: "0",
    edgeAfterFees: null,
    leggingRisk: "NOT_APPLICABLE",
    fillLowerBound: null,
    fillUpperBound: null,
    details: {
      detected,
      referenceChangeBps: options.referenceChangeBps,
      thresholdBps: options.thresholdBps,
      warning: "OBSERVER_ONLY_NO_FAIR_VALUE_ORDER",
    },
  };
}

export function makerEnvelopeObserver(
  snapshot: PaperSnapshot,
  options: { readonly markoutPrice: string | null },
): PaperAudit {
  const spread = subtract(decimal(snapshot.up.ask), decimal(snapshot.up.bid));
  const markout = options.markoutPrice === null
    ? null
    : format(subtract(decimal(options.markoutPrice), decimal(snapshot.up.bid)));
  return {
    ...base(snapshot, "MAKER_ENVELOPE_OBSERVER"),
    fills: [],
    executableQuantity: "0",
    edgeAfterFees: null,
    leggingRisk: "NOT_APPLICABLE",
    fillLowerBound: format(ZERO),
    fillUpperBound: snapshot.up.askSize,
    details: {
      spread: format(spread),
      markout,
      adverseSelection: markout === null ? null : format(subtract(ZERO, decimal(markout))),
      warning: "NO_QUEUE_POSITION_OR_FILL_CLAIM",
    },
  };
}
