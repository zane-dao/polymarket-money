from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
import unittest

from research.polymarket_money.historical import (
    HistoricalTopOfBook,
    TopOfBookExecutionScenario,
    VisibilityScenario,
    choose_visible_tick,
    execute_top_of_book,
)


UTC = timezone.utc
T0 = datetime(2026, 5, 1, 0, 4, tzinfo=UTC)


def tick(second: int, ask: str, size: str | None = "2") -> HistoricalTopOfBook:
    return HistoricalTopOfBook(
        sample_time=T0 + timedelta(seconds=second),
        up_bid=Decimal("0.48"),
        up_ask=Decimal(ask),
        down_bid=Decimal("0.47"),
        down_ask=Decimal("0.53"),
        up_bid_size=Decimal("3"),
        up_ask_size=None if size is None else Decimal(size),
        down_bid_size=Decimal("3"),
        down_ask_size=Decimal("2"),
    )


class HistoricalVisibilityTest(unittest.TestCase):
    def test_visibility_scenarios_shift_sample_availability(self) -> None:
        ticks = (tick(0, "0.50"), tick(1, "0.55"), tick(2, "0.60"))
        self.assertEqual(
            choose_visible_tick(ticks, T0 + timedelta(seconds=1), VisibilityScenario.SAMPLE_TIME_0S),
            ticks[1],
        )
        self.assertEqual(
            choose_visible_tick(ticks, T0 + timedelta(seconds=1), VisibilityScenario.SAMPLE_TIME_PLUS_1S),
            ticks[0],
        )
        self.assertIsNone(
            choose_visible_tick(ticks, T0 + timedelta(seconds=1), VisibilityScenario.SAMPLE_TIME_PLUS_2S)
        )

    def test_base_latency_uses_next_visible_ask_not_decision_price(self) -> None:
        ticks = (tick(0, "0.50"), tick(1, "0.55"), tick(2, "0.60"))
        outcome = execute_top_of_book(
            ticks=ticks,
            decision_time=T0,
            market_end=T0 + timedelta(seconds=10),
            direction="BUY_UP",
            quantity=Decimal("1"),
            scenario=TopOfBookExecutionScenario.BASE_1S,
            visibility=VisibilityScenario.SAMPLE_TIME_PLUS_1S,
            tick_size=Decimal("0.01"),
        )
        self.assertEqual(outcome.fill_price, Decimal("0.50"))
        self.assertEqual(outcome.executable_time, T0 + timedelta(seconds=1))

    def test_missing_or_small_ask_size_never_creates_full_fill(self) -> None:
        missing = execute_top_of_book(
            ticks=(tick(0, "0.50", None),),
            decision_time=T0,
            market_end=T0 + timedelta(seconds=10),
            direction="BUY_UP",
            quantity=Decimal("1"),
            scenario=TopOfBookExecutionScenario.BASE_1S,
            visibility=VisibilityScenario.SAMPLE_TIME_PLUS_1S,
            tick_size=Decimal("0.01"),
        )
        partial = execute_top_of_book(
            ticks=(tick(0, "0.50", "0.4"),),
            decision_time=T0,
            market_end=T0 + timedelta(seconds=10),
            direction="BUY_UP",
            quantity=Decimal("1"),
            scenario=TopOfBookExecutionScenario.BASE_1S,
            visibility=VisibilityScenario.SAMPLE_TIME_PLUS_1S,
            tick_size=Decimal("0.01"),
        )
        self.assertEqual(missing.filled_quantity, Decimal("0"))
        self.assertEqual(partial.filled_quantity, Decimal("0.4"))

    def test_stress_scenario_worsens_ask_by_one_tick(self) -> None:
        outcome = execute_top_of_book(
            ticks=(tick(0, "0.50"),),
            decision_time=T0,
            market_end=T0 + timedelta(seconds=10),
            direction="BUY_UP",
            quantity=Decimal("1"),
            scenario=TopOfBookExecutionScenario.STRESS_1S_PLUS_TICK,
            visibility=VisibilityScenario.SAMPLE_TIME_PLUS_1S,
            tick_size=Decimal("0.01"),
        )
        self.assertEqual(outcome.fill_price, Decimal("0.51"))


if __name__ == "__main__":
    unittest.main()
