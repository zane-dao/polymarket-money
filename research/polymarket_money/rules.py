"""Pure BTC five-minute market and causality rules."""

from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal

from .domain import (
    Market,
    OraclePrice,
    OrderBookSnapshot,
    Outcome,
    OutcomeToken,
    Settlement,
    Side,
    require_utc,
)


class MarketRuleViolation(ValueError):
    """The market does not satisfy the supported BTC five-minute contract."""


class CausalityViolation(ValueError):
    """Feature input was not available at the decision time."""


def token_for_outcome(market: Market, outcome: Outcome) -> OutcomeToken:
    matches = [token for token in market.outcome_tokens if token.outcome is outcome]
    if len(matches) != 1:
        raise MarketRuleViolation(f"market must contain exactly one {outcome.value} token")
    return matches[0]


def validate_btc_five_minute_market(market: Market) -> None:
    expected_prefix = "btc-updown-5m-"
    if not market.slug.startswith(expected_prefix):
        raise MarketRuleViolation("slug is not a BTC Up/Down five-minute market")
    suffix = market.slug.removeprefix(expected_prefix)
    if not suffix.isdigit() or int(suffix) != int(market.interval_start.timestamp()):
        raise MarketRuleViolation("slug epoch must match interval_start")
    if market.interval_end - market.interval_start != timedelta(minutes=5):
        raise MarketRuleViolation("market interval must be exactly five minutes")
    if market.oracle.provider.casefold() != "chainlink":
        raise MarketRuleViolation("settlement oracle must be Chainlink")
    if market.oracle.pair.upper() != "BTC/USD":
        raise MarketRuleViolation("settlement pair must be BTC/USD")
    token_for_outcome(market, Outcome.UP)
    token_for_outcome(market, Outcome.DOWN)
    if len(market.outcome_tokens) != 2:
        raise MarketRuleViolation("market must contain only Up and Down tokens")


def settlement_outcome(start_price: Decimal, end_price: Decimal) -> Outcome:
    if not isinstance(start_price, Decimal) or not isinstance(end_price, Decimal):
        raise TypeError("settlement prices must be Decimal values")
    return Outcome.UP if end_price >= start_price else Outcome.DOWN


def settlement_from_oracle(
    *,
    settlement_id: str,
    market: Market,
    opening: OraclePrice,
    closing: OraclePrice,
    settlement_time: datetime,
) -> Settlement:
    """Build settlement only from the market's Chainlink BTC/USD boundary prices."""

    validate_btc_five_minute_market(market)
    for label, price in (("opening", opening), ("closing", closing)):
        if price.market_id != market.market_id:
            raise MarketRuleViolation(f"{label} oracle price belongs to another market")
        if price.provider.casefold() != market.oracle.provider.casefold():
            raise MarketRuleViolation(f"{label} oracle provider does not match the market")
        if price.pair.upper() != market.oracle.pair.upper():
            raise MarketRuleViolation(f"{label} oracle pair does not match the market")
    if closing.source_time < opening.source_time:
        raise MarketRuleViolation("closing oracle time must not precede opening oracle time")
    if opening.source_time != market.interval_start:
        raise MarketRuleViolation("opening oracle source_time must equal interval_start")
    if closing.source_time != market.interval_end:
        raise MarketRuleViolation("closing oracle source_time must equal interval_end")
    require_utc(settlement_time, "settlement_time")
    if settlement_time < closing.receive_time:
        raise MarketRuleViolation("settlement_time must not precede receipt of closing price")

    return Settlement(
        settlement_id=settlement_id,
        market=market,
        opening_price=opening,
        closing_price=closing,
        settlement_time=settlement_time,
    )


def executable_price(book: OrderBookSnapshot, side: Side) -> Decimal:
    if side is Side.BUY:
        if book.best_ask is None:
            raise MarketRuleViolation("buy requires an available ask")
        return book.best_ask
    if book.best_bid is None:
        raise MarketRuleViolation("sell requires an available bid")
    return book.best_bid


def assert_feature_is_causal(*, data_time: datetime, decision_time: datetime) -> None:
    require_utc(data_time, "data_time")
    require_utc(decision_time, "decision_time")
    if data_time > decision_time:
        raise CausalityViolation("data later than decision_time cannot be used as a feature")
