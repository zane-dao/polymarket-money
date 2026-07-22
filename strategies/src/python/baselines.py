"""Deterministic primitives for the four pre-registered Batch 3B baselines."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
import math
from typing import Sequence

from research.polymarket_money.domain import require_decimal


@dataclass(frozen=True, slots=True)
class BaselineAction:
    direction: str
    expected_value: Decimal


def no_trade_probability() -> None:
    return None


def market_probability(up_bid: Decimal, up_ask: Decimal) -> Decimal:
    require_decimal(up_bid, "up_bid", non_negative=True)
    require_decimal(up_ask, "up_ask", non_negative=True)
    if up_bid > up_ask or up_ask > 1:
        raise ValueError("market midpoint requires an uncrossed binary top of book")
    return (up_bid + up_ask) / Decimal("2")


def action_from_probability(
    *,
    p_up: Decimal,
    ask_up: Decimal,
    ask_down: Decimal,
    fee_up: Decimal,
    fee_down: Decimal,
    threshold: Decimal,
) -> BaselineAction:
    for name, value in (
        ("p_up", p_up),
        ("ask_up", ask_up),
        ("ask_down", ask_down),
        ("fee_up", fee_up),
        ("fee_down", fee_down),
        ("threshold", threshold),
    ):
        require_decimal(value, name, non_negative=True)
    ev_up = p_up - ask_up - fee_up
    ev_down = (Decimal("1") - p_up) - ask_down - fee_down
    best = max(ev_up, ev_down)
    if best <= threshold or ev_up == ev_down:
        return BaselineAction("NO_TRADE", best)
    return BaselineAction("BUY_UP" if ev_up > ev_down else "BUY_DOWN", best)


def brier_score(probabilities: Sequence[Decimal], outcomes: Sequence[int]) -> Decimal:
    if not probabilities or len(probabilities) != len(outcomes):
        raise ValueError("probability and outcome vectors must be non-empty and aligned")
    return sum(
        ((probability - Decimal(outcome)) ** 2 for probability, outcome in zip(probabilities, outcomes)),
        Decimal("0"),
    ) / Decimal(len(probabilities))


def log_loss(probabilities: Sequence[Decimal], outcomes: Sequence[int]) -> Decimal:
    if not probabilities or len(probabilities) != len(outcomes):
        raise ValueError("probability and outcome vectors must be non-empty and aligned")
    epsilon = 1e-15
    total = 0.0
    for probability, outcome in zip(probabilities, outcomes):
        p = min(max(float(probability), epsilon), 1 - epsilon)
        total -= outcome * math.log(p) + (1 - outcome) * math.log(1 - p)
    return Decimal(str(total / len(probabilities)))
