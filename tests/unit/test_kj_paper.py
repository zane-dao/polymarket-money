from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
import json
import unittest

from research.polymarket_money.kj_paper import (
    KJConfig,
    KJStrategy,
    PaperScenario,
    SIGNAL_FIDELITY,
    export_kj_paper,
    run_kj_paper,
    simulate_decision,
)
from research.polymarket_money.kj_ewma import SIGNAL_FIDELITY as EWMA_SIGNAL_FIDELITY


def row(*, condition: str = "m1", winner: str = "Up", current: str = "111") -> dict:
    book = {"bu": "0.44", "au": "0.45", "bd": "0.54", "ad": "0.55", "su": "20", "sd": "20", "sau": "20", "sad": "20"}
    return {
        "condition_id": condition,
        "slug": f"btc-updown-5m-{condition}",
        "decision_time": f"2026-05-14T00:0{condition[-1]}:30Z",
        "market_start": "2026-05-14T00:00:00Z",
        "market_end": "2026-05-14T00:05:00Z",
        "split": "FINAL_TEST",
        "horizon_seconds": 30,
        "winner": winner,
        "binance": {
            "start_price": "100",
            "current_price": current,
            "log_return_from_start": "0.001",
            "realized_vol_30s": "0.001",
            "realized_vol_60s": "0.001",
            "realized_vol_120s": "0.001",
        },
        "books": {
            "decision_plus_1s_visibility": dict(book),
            "execution_base_1s": dict(book),
        },
        "fee_evidence": {
            "grade": "MARKET_STATIC_OFFICIAL",
            "fee_rate": "0.07",
            "fetch_time": "2026-07-15T23:50:08Z",
        },
    }


class KJPaperTest(unittest.TestCase):
    def test_critical_band_fails_closed(self) -> None:
        event = simulate_decision(
            row(current="100.01"),
            strategy=KJStrategy.J_FEE_AWARE,
            scenario=PaperScenario.BASE_1S,
            bankroll=Decimal("10000"),
            config=KJConfig(),
        )
        self.assertEqual(event["reason"], "CRITICAL_BAND")
        self.assertEqual(event["status"], "NO_TRADE")

    def test_fee_aware_fill_has_position_cash_and_pnl_fields(self) -> None:
        event = simulate_decision(
            row(),
            strategy=KJStrategy.K_DUAL_VOL,
            scenario=PaperScenario.BASE_1S,
            bankroll=Decimal("10000"),
            config=KJConfig(),
        )
        self.assertEqual(event["status"], "FILLED")
        self.assertEqual(event["side"], "UP")
        self.assertEqual(event["fill_time"], "2026-05-14T00:01:31Z")
        self.assertGreater(Decimal(event["quantity"]), 0)
        self.assertEqual(
            Decimal(event["net_pnl"]),
            Decimal(event["gross_pnl"]) - Decimal(event["fee"]),
        )
        self.assertEqual(event["signal_fidelity"], SIGNAL_FIDELITY)

    def test_verified_ewma_sample_replaces_realized_vol_proxy(self) -> None:
        event = simulate_decision(
            row(),
            strategy=KJStrategy.K_DUAL_VOL,
            scenario=PaperScenario.BASE_1S,
            bankroll=Decimal("10000"),
            config=KJConfig(),
            volatility_sample={
                "j_single_sigma": "0.001",
                "k_effective_sigma": "0.002",
            },
        )
        self.assertEqual(event["signal_fidelity"], EWMA_SIGNAL_FIDELITY)
        self.assertEqual(event["effective_sigma"], "0.002")

    def test_stress_tick_cannot_turn_zero_ask_into_a_fill(self) -> None:
        fixture = row()
        fixture["books"]["execution_base_1s"]["au"] = "0"
        event = simulate_decision(
            fixture,
            strategy=KJStrategy.J_FEE_AWARE,
            scenario=PaperScenario.STRESS_1S_PLUS_TICK,
            bankroll=Decimal("10000"),
            config=KJConfig(),
        )
        self.assertEqual(event["status"], "UNFILLED")
        self.assertEqual(event["reason"], "EXECUTION_PRICE_OUT_OF_RANGE")

    def test_execution_can_only_reduce_frozen_intent_quantity(self) -> None:
        base_event = simulate_decision(
            row(),
            strategy=KJStrategy.J_FEE_AWARE,
            scenario=PaperScenario.BASE_1S,
            bankroll=Decimal("10000"),
            config=KJConfig(),
        )
        stress_event = simulate_decision(
            row(),
            strategy=KJStrategy.J_FEE_AWARE,
            scenario=PaperScenario.STRESS_1S_PLUS_TICK,
            bankroll=Decimal("10000"),
            config=KJConfig(),
        )
        self.assertEqual(base_event["intended_quantity"], stress_event["intended_quantity"])
        self.assertLessEqual(
            Decimal(stress_event["quantity"]),
            Decimal(stress_event["intended_quantity"]),
        )

    def test_portfolios_are_independent_and_exports_are_complete(self) -> None:
        receipt = SimpleNamespace(
            dataset_hash="a" * 64,
            manifest={"audit": {"gate": {"passed": True}}},
        )
        result = run_kj_paper(
            receipt,
            (row(condition="m1"), row(condition="m2", winner="Down")),
            strategies=(KJStrategy.J_FEE_AWARE, KJStrategy.K_DUAL_VOL),
        )
        self.assertEqual(set(result["runs"]), {"J_FEE_AWARE", "K_DUAL_VOL"})
        self.assertFalse(result["safety"]["orders_submitted"])
        self.assertEqual(len(result["events"]), 4)
        self.assertIn("brier_score", result["runs"]["J_FEE_AWARE"])
        self.assertIn("net_without_best_3_days", result["runs"]["K_DUAL_VOL"])

        from tempfile import TemporaryDirectory
        with TemporaryDirectory() as temporary:
            output = Path(temporary) / "run"
            export_kj_paper(result, output)
            self.assertTrue((output / "summary.json").is_file())
            self.assertTrue((output / "trades.csv").is_file())
            lines = (output / "events.ndjson").read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines), 4)
            self.assertTrue(all(json.loads(line)["strategy"] for line in lines))
            with self.assertRaises(FileExistsError):
                export_kj_paper(result, output)


if __name__ == "__main__":
    unittest.main()
