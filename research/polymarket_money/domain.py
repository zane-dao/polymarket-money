"""Vendor-neutral domain types for deterministic research and accounting.

The models intentionally use explicit time names.  There is no generic
``timestamp`` field because source, server, receive, decision, send, fill, and
settlement times have different causal meanings.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
from enum import Enum


class Outcome(str, Enum):
    UP = "up"
    DOWN = "down"


class Side(str, Enum):
    BUY = "buy"
    SELL = "sell"


class DecisionAction(str, Enum):
    BUY = "buy"
    SELL = "sell"
    HOLD = "hold"


def require_utc(value: datetime, field_name: str) -> None:
    """Reject naive and non-UTC datetimes at the domain boundary."""

    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError(f"{field_name} must be an aware UTC datetime")


def require_non_empty(value: str, field_name: str) -> None:
    if not value.strip():
        raise ValueError(f"{field_name} must not be empty")


def require_decimal(
    value: Decimal,
    field_name: str,
    *,
    positive: bool = False,
    non_negative: bool = False,
) -> None:
    if not isinstance(value, Decimal) or not value.is_finite():
        raise ValueError(f"{field_name} must be a finite Decimal")
    if positive and value <= 0:
        raise ValueError(f"{field_name} must be greater than zero")
    if non_negative and value < 0:
        raise ValueError(f"{field_name} must not be negative")


@dataclass(frozen=True, slots=True)
class OutcomeToken:
    token_id: str
    market_id: str
    outcome: Outcome

    def __post_init__(self) -> None:
        require_non_empty(self.token_id, "token_id")
        require_non_empty(self.market_id, "market_id")


@dataclass(frozen=True, slots=True)
class OracleDefinition:
    provider: str
    pair: str

    def __post_init__(self) -> None:
        require_non_empty(self.provider, "provider")
        require_non_empty(self.pair, "pair")


@dataclass(frozen=True, slots=True)
class Market:
    market_id: str
    condition_id: str
    slug: str
    interval_start: datetime
    interval_end: datetime
    oracle: OracleDefinition
    outcome_tokens: tuple[OutcomeToken, ...]

    def __post_init__(self) -> None:
        require_non_empty(self.market_id, "market_id")
        require_non_empty(self.condition_id, "condition_id")
        require_non_empty(self.slug, "slug")
        require_utc(self.interval_start, "interval_start")
        require_utc(self.interval_end, "interval_end")
        if self.interval_end <= self.interval_start:
            raise ValueError("interval_end must be later than interval_start")
        if any(token.market_id != self.market_id for token in self.outcome_tokens):
            raise ValueError("all outcome tokens must belong to the market")


@dataclass(frozen=True, slots=True)
class OraclePrice:
    market_id: str
    pair: str
    provider: str
    price: Decimal
    source_time: datetime
    server_time: datetime | None
    receive_time: datetime

    def __post_init__(self) -> None:
        require_non_empty(self.market_id, "market_id")
        require_non_empty(self.pair, "pair")
        require_non_empty(self.provider, "provider")
        require_decimal(self.price, "price", positive=True)
        require_utc(self.source_time, "source_time")
        if self.server_time is not None:
            require_utc(self.server_time, "server_time")
        require_utc(self.receive_time, "receive_time")


@dataclass(frozen=True, slots=True)
class PriceLevel:
    price: Decimal
    quantity: Decimal

    def __post_init__(self) -> None:
        require_decimal(self.price, "price", non_negative=True)
        require_decimal(self.quantity, "quantity", positive=True)
        if self.price > Decimal("1"):
            raise ValueError("prediction-market token price must not exceed 1")


@dataclass(frozen=True, slots=True)
class OrderBookSnapshot:
    snapshot_id: str
    market_id: str
    token_id: str
    bids: tuple[PriceLevel, ...]
    asks: tuple[PriceLevel, ...]
    source_time: datetime | None
    server_time: datetime | None
    receive_time: datetime

    def __post_init__(self) -> None:
        require_non_empty(self.snapshot_id, "snapshot_id")
        require_non_empty(self.market_id, "market_id")
        require_non_empty(self.token_id, "token_id")
        if self.source_time is not None:
            require_utc(self.source_time, "source_time")
        if self.server_time is not None:
            require_utc(self.server_time, "server_time")
        require_utc(self.receive_time, "receive_time")

    @property
    def best_bid(self) -> Decimal | None:
        return max((level.price for level in self.bids), default=None)

    @property
    def best_ask(self) -> Decimal | None:
        return min((level.price for level in self.asks), default=None)


@dataclass(frozen=True, slots=True)
class Decision:
    decision_id: str
    market_id: str
    token_id: str | None
    action: DecisionAction
    decision_time: datetime
    input_receive_time: datetime
    reason_codes: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        require_non_empty(self.decision_id, "decision_id")
        require_non_empty(self.market_id, "market_id")
        require_utc(self.decision_time, "decision_time")
        require_utc(self.input_receive_time, "input_receive_time")
        if self.input_receive_time > self.decision_time:
            raise ValueError("input_receive_time must not be later than decision_time")


@dataclass(frozen=True, slots=True)
class OrderIntent:
    intent_id: str
    idempotency_key: str
    decision_id: str
    market_id: str
    token_id: str
    side: Side
    limit_price: Decimal
    quantity: Decimal
    decision_time: datetime
    order_send_time: datetime | None

    def __post_init__(self) -> None:
        for field_name in (
            "intent_id",
            "idempotency_key",
            "decision_id",
            "market_id",
            "token_id",
        ):
            require_non_empty(getattr(self, field_name), field_name)
        require_decimal(self.limit_price, "limit_price", positive=True)
        require_decimal(self.quantity, "quantity", positive=True)
        if self.limit_price > Decimal("1"):
            raise ValueError("limit_price must not exceed 1")
        require_utc(self.decision_time, "decision_time")
        if self.order_send_time is not None:
            require_utc(self.order_send_time, "order_send_time")
            if self.order_send_time < self.decision_time:
                raise ValueError("order_send_time must not precede decision_time")


@dataclass(frozen=True, slots=True)
class Fill:
    fill_id: str
    order_intent_id: str
    market_id: str
    token_id: str
    side: Side
    price: Decimal
    quantity: Decimal
    fee: Decimal
    fill_time: datetime
    receive_time: datetime

    def __post_init__(self) -> None:
        for field_name in ("fill_id", "order_intent_id", "market_id", "token_id"):
            require_non_empty(getattr(self, field_name), field_name)
        require_decimal(self.price, "price", non_negative=True)
        require_decimal(self.quantity, "quantity", positive=True)
        require_decimal(self.fee, "fee", non_negative=True)
        if self.price > Decimal("1"):
            raise ValueError("fill price must not exceed 1")
        require_utc(self.fill_time, "fill_time")
        require_utc(self.receive_time, "receive_time")


@dataclass(frozen=True, slots=True)
class Settlement:
    settlement_id: str
    market: Market
    opening_price: OraclePrice
    closing_price: OraclePrice
    settlement_time: datetime
    payout_per_token: Decimal = Decimal("1")

    def __post_init__(self) -> None:
        require_non_empty(self.settlement_id, "settlement_id")
        require_decimal(self.payout_per_token, "payout_per_token", non_negative=True)
        require_utc(self.settlement_time, "settlement_time")
        if self.market.oracle.provider.casefold() != "chainlink":
            raise ValueError("settlement market oracle must be Chainlink")
        if self.market.oracle.pair.upper() != "BTC/USD":
            raise ValueError("settlement market oracle pair must be BTC/USD")
        if self.market.interval_end - self.market.interval_start != timedelta(minutes=5):
            raise ValueError("settlement market window must be exactly five minutes")
        for label, price in (
            ("opening_price", self.opening_price),
            ("closing_price", self.closing_price),
        ):
            if price.market_id != self.market.market_id:
                raise ValueError(f"{label} belongs to another market")
            if price.provider.casefold() != self.market.oracle.provider.casefold():
                raise ValueError(f"{label} provider does not match the market oracle")
            if price.pair.upper() != self.market.oracle.pair.upper():
                raise ValueError(f"{label} pair does not match the market oracle")
        if self.closing_price.source_time < self.opening_price.source_time:
            raise ValueError("closing source time must not precede opening source time")
        if self.opening_price.source_time != self.market.interval_start:
            raise ValueError("opening source time must equal market interval_start")
        if self.closing_price.source_time != self.market.interval_end:
            raise ValueError("closing source time must equal market interval_end")
        if self.settlement_time < self.closing_price.receive_time:
            raise ValueError("settlement time must not precede receipt of closing price")

        outcomes = [token.outcome for token in self.market.outcome_tokens]
        if (
            len(outcomes) != 2
            or outcomes.count(Outcome.UP) != 1
            or outcomes.count(Outcome.DOWN) != 1
        ):
            raise ValueError("settlement market must have exactly one Up and one Down token")

    @property
    def market_id(self) -> str:
        return self.market.market_id

    @property
    def start_price(self) -> Decimal:
        return self.opening_price.price

    @property
    def end_price(self) -> Decimal:
        return self.closing_price.price

    @property
    def source_time(self) -> datetime:
        return self.closing_price.source_time

    @property
    def server_time(self) -> datetime | None:
        return self.closing_price.server_time

    @property
    def receive_time(self) -> datetime:
        return self.closing_price.receive_time

    @property
    def winning_outcome(self) -> Outcome:
        return Outcome.UP if self.end_price >= self.start_price else Outcome.DOWN

    @property
    def winning_token(self) -> OutcomeToken:
        return next(
            token
            for token in self.market.outcome_tokens
            if token.outcome is self.winning_outcome
        )

    @property
    def winning_token_id(self) -> str:
        return self.winning_token.token_id


@dataclass(frozen=True, slots=True)
class Position:
    market_id: str
    token_id: str
    quantity: Decimal
    net_cash_outlay: Decimal
    fees: Decimal

    def __post_init__(self) -> None:
        require_non_empty(self.market_id, "market_id")
        require_non_empty(self.token_id, "token_id")
        require_decimal(self.quantity, "quantity", non_negative=True)
        require_decimal(self.net_cash_outlay, "net_cash_outlay")
        require_decimal(self.fees, "fees", non_negative=True)


@dataclass(frozen=True, slots=True)
class PnL:
    market_id: str
    payout: Decimal
    net_cash_outlay: Decimal
    gross_pnl: Decimal
    fees: Decimal
    net_pnl: Decimal

    def __post_init__(self) -> None:
        require_non_empty(self.market_id, "market_id")
        require_decimal(self.payout, "payout", non_negative=True)
        require_decimal(self.net_cash_outlay, "net_cash_outlay")
        require_decimal(self.gross_pnl, "gross_pnl")
        require_decimal(self.fees, "fees", non_negative=True)
        require_decimal(self.net_pnl, "net_pnl")
