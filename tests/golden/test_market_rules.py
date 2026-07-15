from dataclasses import FrozenInstanceError
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import unittest

from research.polymarket_money.domain import (
    Market,
    OracleDefinition,
    OraclePrice,
    OrderBookSnapshot,
    Outcome,
    OutcomeToken,
    PriceLevel,
    Side,
)
from research.polymarket_money.rules import (
    CausalityViolation,
    MarketRuleViolation,
    assert_feature_is_causal,
    executable_price,
    settlement_outcome,
    settlement_from_oracle,
    token_for_outcome,
    validate_btc_five_minute_market,
)


UTC = timezone.utc
START = datetime(2026, 7, 15, 12, 0, tzinfo=UTC)


def make_market() -> Market:
    return Market(
        market_id="market-1",
        condition_id="condition-1",
        slug=f"btc-updown-5m-{int(START.timestamp())}",
        interval_start=START,
        interval_end=START + timedelta(minutes=5),
        oracle=OracleDefinition(provider="Chainlink", pair="BTC/USD"),
        outcome_tokens=(
            OutcomeToken(token_id="down-token", market_id="market-1", outcome=Outcome.DOWN),
            OutcomeToken(token_id="up-token", market_id="market-1", outcome=Outcome.UP),
        ),
    )


class MarketRulesGoldenTest(unittest.TestCase):
    def test_up_down_mapping_uses_labels_not_array_position(self) -> None:
        market = make_market()

        self.assertEqual(token_for_outcome(market, Outcome.UP).token_id, "up-token")
        self.assertEqual(token_for_outcome(market, Outcome.DOWN).token_id, "down-token")
        validate_btc_five_minute_market(market)

    def test_rising_market_settles_up(self) -> None:
        self.assertEqual(settlement_outcome(Decimal("60000"), Decimal("60001")), Outcome.UP)

    def test_tied_market_settles_up(self) -> None:
        self.assertEqual(settlement_outcome(Decimal("60000"), Decimal("60000")), Outcome.UP)

    def test_chainlink_prices_build_tie_settlement_with_up_token(self) -> None:
        market = make_market()
        opening = OraclePrice(
            market_id=market.market_id,
            pair="BTC/USD",
            provider="Chainlink",
            price=Decimal("60000"),
            source_time=market.interval_start,
            server_time=market.interval_start + timedelta(milliseconds=5),
            receive_time=market.interval_start + timedelta(milliseconds=10),
        )
        closing = OraclePrice(
            market_id=market.market_id,
            pair="BTC/USD",
            provider="Chainlink",
            price=Decimal("60000"),
            source_time=market.interval_end,
            server_time=market.interval_end + timedelta(milliseconds=5),
            receive_time=market.interval_end + timedelta(milliseconds=10),
        )

        settlement = settlement_from_oracle(
            settlement_id="settlement-1",
            market=market,
            opening=opening,
            closing=closing,
            settlement_time=market.interval_end + timedelta(minutes=1),
        )

        self.assertEqual(settlement.winning_outcome, Outcome.UP)
        self.assertEqual(settlement.winning_token_id, "up-token")

        with self.assertRaises(FrozenInstanceError):
            settlement.settlement_time = market.interval_end + timedelta(minutes=2)

    def test_oracle_prices_from_different_market_are_rejected(self) -> None:
        market = make_market()
        opening = OraclePrice(
            market_id=market.market_id,
            pair="BTC/USD",
            provider="Chainlink",
            price=Decimal("60000"),
            source_time=market.interval_start,
            server_time=None,
            receive_time=market.interval_start,
        )
        closing = OraclePrice(
            market_id="another-market",
            pair="BTC/USD",
            provider="Chainlink",
            price=Decimal("60001"),
            source_time=market.interval_end,
            server_time=None,
            receive_time=market.interval_end,
        )

        with self.assertRaises(MarketRuleViolation):
            settlement_from_oracle(
                settlement_id="settlement-wrong-market",
                market=market,
                opening=opening,
                closing=closing,
                settlement_time=market.interval_end + timedelta(minutes=1),
            )

    def test_oracle_prices_outside_or_reversing_market_window_are_rejected(self) -> None:
        market = make_market()
        opening = OraclePrice(
            market_id=market.market_id,
            pair="BTC/USD",
            provider="Chainlink",
            price=Decimal("60000"),
            source_time=market.interval_end,
            server_time=None,
            receive_time=market.interval_end,
        )
        closing = OraclePrice(
            market_id=market.market_id,
            pair="BTC/USD",
            provider="Chainlink",
            price=Decimal("60001"),
            source_time=market.interval_start,
            server_time=None,
            receive_time=market.interval_start,
        )

        with self.assertRaises(MarketRuleViolation):
            settlement_from_oracle(
                settlement_id="settlement-reversed-window",
                market=market,
                opening=opening,
                closing=closing,
                settlement_time=market.interval_end + timedelta(minutes=1),
            )

    def test_falling_market_settles_down(self) -> None:
        self.assertEqual(settlement_outcome(Decimal("60000"), Decimal("59999")), Outcome.DOWN)

    def test_buy_uses_ask_not_mid(self) -> None:
        book = OrderBookSnapshot(
            snapshot_id="book-1",
            market_id="market-1",
            token_id="up-token",
            bids=(PriceLevel(price=Decimal("0.48"), quantity=Decimal("10")),),
            asks=(PriceLevel(price=Decimal("0.52"), quantity=Decimal("10")),),
            source_time=START,
            server_time=START + timedelta(milliseconds=5),
            receive_time=START + timedelta(milliseconds=10),
        )

        self.assertEqual(executable_price(book, Side.BUY), Decimal("0.52"))
        self.assertNotEqual(executable_price(book, Side.BUY), Decimal("0.50"))

    def test_sell_uses_bid_not_mid(self) -> None:
        book = OrderBookSnapshot(
            snapshot_id="book-2",
            market_id="market-1",
            token_id="up-token",
            bids=(PriceLevel(price=Decimal("0.48"), quantity=Decimal("10")),),
            asks=(PriceLevel(price=Decimal("0.52"), quantity=Decimal("10")),),
            source_time=START,
            server_time=START + timedelta(milliseconds=5),
            receive_time=START + timedelta(milliseconds=10),
        )

        self.assertEqual(executable_price(book, Side.SELL), Decimal("0.48"))
        self.assertNotEqual(executable_price(book, Side.SELL), Decimal("0.50"))

    def test_future_data_is_rejected(self) -> None:
        decision_time = START + timedelta(seconds=30)

        with self.assertRaises(CausalityViolation):
            assert_feature_is_causal(
                data_time=decision_time + timedelta(microseconds=1),
                decision_time=decision_time,
            )


if __name__ == "__main__":
    unittest.main()
