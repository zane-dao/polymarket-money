from __future__ import annotations

from decimal import Decimal
import unittest

from research.polymarket_money.historical_study import _aggregate, _quantile_boundaries


class HistoricalStudyDiagnosticsTest(unittest.TestCase):
    def test_volatility_boundaries_are_deterministic(self) -> None:
        self.assertEqual(_quantile_boundaries([6, 1, 5, 2, 4, 3]), (3, 5))

    def test_aggregate_reports_daily_and_iso_weekly_pnl(self) -> None:
        trades = [
            (
                {"market_start": "2026-05-14T00:00:00Z"},
                {
                    "action": "BUY_UP",
                    "filled_quantity": Decimal("1"),
                    "gross_pnl": Decimal("0.4"),
                    "fee": Decimal("0.1"),
                    "net_pnl": Decimal("0.3"),
                    "status": "FILLED",
                },
            ),
            (
                {"market_start": "2026-05-15T00:00:00Z"},
                {
                    "action": "NO_TRADE",
                    "filled_quantity": Decimal("0"),
                    "gross_pnl": Decimal("0"),
                    "fee": Decimal("0"),
                    "net_pnl": Decimal("0"),
                    "status": "NO_TRADE",
                },
            ),
        ]
        result = _aggregate(trades)
        self.assertEqual(result["daily_pnl"]["2026-05-14"], "0.3")
        self.assertEqual(result["weekly_pnl"], {"2026-W20": "0.3"})


if __name__ == "__main__":
    unittest.main()
