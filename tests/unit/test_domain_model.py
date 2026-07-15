from dataclasses import fields
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import unittest

from research.polymarket_money.domain import (
    Decision,
    Fill,
    Market,
    OracleDefinition,
    OraclePrice,
    OrderBookSnapshot,
    OrderIntent,
    Outcome,
    OutcomeToken,
    Settlement,
)
from research.polymarket_money.rules import MarketRuleViolation, validate_btc_five_minute_market


UTC = timezone.utc
START = datetime(2026, 7, 15, 12, 0, tzinfo=UTC)


def make_market(*, provider: str = "Chainlink", minutes: int = 5) -> Market:
    market_id = "market-1"
    return Market(
        market_id=market_id,
        condition_id="condition-1",
        slug=f"btc-updown-5m-{int(START.timestamp())}",
        interval_start=START,
        interval_end=START + timedelta(minutes=minutes),
        oracle=OracleDefinition(provider=provider, pair="BTC/USD"),
        outcome_tokens=(
            OutcomeToken(token_id="up-token", market_id=market_id, outcome=Outcome.UP),
            OutcomeToken(token_id="down-token", market_id=market_id, outcome=Outcome.DOWN),
        ),
    )


class DomainModelTest(unittest.TestCase):
    def test_causal_time_fields_are_explicit_and_no_generic_timestamp_exists(self) -> None:
        expected_fields = {
            OraclePrice: {"source_time", "server_time", "receive_time"},
            OrderBookSnapshot: {"source_time", "server_time", "receive_time"},
            Decision: {"decision_time", "input_receive_time"},
            OrderIntent: {"decision_time", "order_send_time"},
            Fill: {"fill_time", "receive_time"},
            Settlement: {"opening_price", "closing_price", "settlement_time"},
        }

        for model, required in expected_fields.items():
            names = {field.name for field in fields(model)}
            self.assertTrue(required.issubset(names), model.__name__)
            self.assertNotIn("timestamp", names, model.__name__)

        settlement_fields = {field.name for field in fields(Settlement)}
        self.assertNotIn("winning_outcome", settlement_fields)
        self.assertNotIn("winning_token_id", settlement_fields)
        self.assertNotIn("start_price", settlement_fields)
        self.assertNotIn("end_price", settlement_fields)

    def test_non_utc_time_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            OraclePrice(
                market_id="market-1",
                pair="BTC/USD",
                provider="Chainlink",
                price=Decimal("60000"),
                source_time=datetime(2026, 7, 15, 12, 0),
                server_time=None,
                receive_time=START,
            )

    def test_non_chainlink_settlement_oracle_is_rejected(self) -> None:
        with self.assertRaises(MarketRuleViolation):
            validate_btc_five_minute_market(make_market(provider="Binance"))

    def test_non_five_minute_market_is_rejected(self) -> None:
        with self.assertRaises(MarketRuleViolation):
            validate_btc_five_minute_market(make_market(minutes=15))


if __name__ == "__main__":
    unittest.main()
