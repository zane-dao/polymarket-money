from __future__ import annotations

from decimal import Decimal
import unittest

from research.polymarket_money.baseline_research import (
    action_from_probability,
    brier_score,
    log_loss,
    market_probability,
    no_trade_probability,
)


class BaselineResearchGoldenTest(unittest.TestCase):
    def test_no_trade_and_market_probability_are_fixed(self) -> None:
        self.assertIsNone(no_trade_probability())
        self.assertEqual(
            market_probability(Decimal("0.40"), Decimal("0.50")), Decimal("0.45")
        )

    def test_midpoint_selects_probability_but_ask_prices_execution(self) -> None:
        action = action_from_probability(
            p_up=Decimal("0.70"),
            ask_up=Decimal("0.60"),
            ask_down=Decimal("0.42"),
            fee_up=Decimal("0.01"),
            fee_down=Decimal("0.01"),
            threshold=Decimal("0.02"),
        )
        self.assertEqual(action.direction, "BUY_UP")
        self.assertEqual(action.expected_value, Decimal("0.09"))

    def test_threshold_is_strict_and_ties_do_not_trade(self) -> None:
        action = action_from_probability(
            p_up=Decimal("0.50"),
            ask_up=Decimal("0.48"),
            ask_down=Decimal("0.48"),
            fee_up=Decimal("0"),
            fee_down=Decimal("0"),
            threshold=Decimal("0.02"),
        )
        self.assertEqual(action.direction, "NO_TRADE")

    def test_probability_metrics_are_deterministic(self) -> None:
        probabilities = (Decimal("0.8"), Decimal("0.3"))
        outcomes = (1, 0)
        self.assertEqual(brier_score(probabilities, outcomes), Decimal("0.065"))
        self.assertGreater(log_loss(probabilities, outcomes), Decimal("0"))


if __name__ == "__main__":
    unittest.main()
