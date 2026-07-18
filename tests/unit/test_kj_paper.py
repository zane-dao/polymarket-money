from __future__ import annotations

from decimal import Decimal
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace
import json
import math
import unittest

from research.polymarket_money.kj_paper import (
    ADAPTIVE_SIGNAL_FIDELITY,
    AdaptiveStrategy,
    KJConfig,
    KJStrategy,
    LAdaptiveConfig,
    LAdaptiveV2Config,
    l_adaptive_v2_midrange_train_selected_config,
    PaperScenario,
    SIGNAL_FIDELITY,
    export_kj_paper,
    HISTORICAL_PAPER_PUBLICATION_VERSION,
    run_l_adaptive_paper,
    run_kj_paper,
    simulate_decision,
)
from research.polymarket_money.kj_ewma import SIGNAL_FIDELITY as EWMA_SIGNAL_FIDELITY
from research.polymarket_money.kj_ewma import EwmaVolatility, KJDualVolatility
from research.polymarket_money.cli import parser


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
    def test_l_v2_train_selected_factory_is_explicit_and_stable(self) -> None:
        config = l_adaptive_v2_midrange_train_selected_config()
        self.assertEqual(config.config_version, "l-adaptive-execution-v2-candidate")
        self.assertEqual(config.probability_clamp, Decimal("0.02"))
        self.assertEqual(config.max_signal_edge, Decimal("0.25"))
        self.assertEqual(config.depth_risk_max, Decimal("0.02"))
        self.assertEqual(config.entry_price_min, Decimal("0.20"))
        self.assertEqual(config.entry_price_max, Decimal("0.80"))

    def test_l_adaptive_records_dynamic_costs_and_volatility_drag(self) -> None:
        event = simulate_decision(
            row(),
            strategy=AdaptiveStrategy.L_ADAPTIVE_EXECUTION,
            scenario=PaperScenario.BASE_1S,
            bankroll=Decimal("10000"),
            config=KJConfig(),
        )
        self.assertEqual(event["strategy"], "L_ADAPTIVE_EXECUTION")
        self.assertEqual(event["signal_fidelity"], ADAPTIVE_SIGNAL_FIDELITY)
        self.assertGreater(Decimal(event["volatility_drag"]), 0)
        self.assertGreater(
            Decimal(event["required_edge"]),
            Decimal(event["required_edge_fee"]),
        )
        self.assertGreater(Decimal(event["required_edge_depth_participation"]), 0)
        self.assertFalse(event["market_quote_velocity_available"])
        self.assertEqual(
            event["market_quote_reprice_risk_source"],
            "CURRENT_TOP_OF_BOOK_SPREAD_PROXY_1HZ",
        )
        self.assertNotIn("edge_threshold", event)

    def test_l_adaptive_higher_volatility_increases_drag_and_remaining_risk(self) -> None:
        low_event = simulate_decision(
            row(),
            strategy=AdaptiveStrategy.L_ADAPTIVE_EXECUTION,
            scenario=PaperScenario.BASE_1S,
            bankroll=Decimal("10000"),
            config=KJConfig(),
        )
        high = row()
        high["binance"].update(
            {
                "realized_vol_30s": "0.01",
                "realized_vol_60s": "0.01",
                "realized_vol_120s": "0.01",
            }
        )
        high_event = simulate_decision(
            high,
            strategy=AdaptiveStrategy.L_ADAPTIVE_EXECUTION,
            scenario=PaperScenario.BASE_1S,
            bankroll=Decimal("10000"),
            config=KJConfig(),
        )
        self.assertGreater(
            Decimal(high_event["volatility_drag"]),
            Decimal(low_event["volatility_drag"]),
        )
        self.assertGreater(
            Decimal(high_event["required_edge_volatility_remaining"]),
            Decimal(low_event["required_edge_volatility_remaining"]),
        )

    def test_l_v2_price_substrategy_rejects_extreme_decision_odds_causally(self) -> None:
        event = simulate_decision(
            row(),
            strategy=AdaptiveStrategy.L_ADAPTIVE_EXECUTION,
            scenario=PaperScenario.BASE_1S,
            bankroll=Decimal("10000"),
            config=KJConfig(),
            adaptive_config=LAdaptiveV2Config(entry_price_min=Decimal("0.60")),
        )
        self.assertEqual(event["status"], "NO_TRADE")
        self.assertEqual(event["reason"], "ENTRY_PRICE_OUTSIDE_V2_RANGE")
        self.assertEqual(
            LAdaptiveV2Config().to_mapping()["entry_price_max"],
            "1",
        )

    def test_l_adaptive_does_not_look_ahead_to_execution_quote_for_speed(self) -> None:
        baseline = simulate_decision(
            row(),
            strategy=AdaptiveStrategy.L_ADAPTIVE_EXECUTION,
            scenario=PaperScenario.BASE_1S,
            bankroll=Decimal("10000"),
            config=KJConfig(),
        )
        changed_execution = row()
        changed_execution["books"]["execution_base_1s"].update(
            {"au": "0.75", "ad": "0.25", "sau": "1", "sad": "1"}
        )
        changed = simulate_decision(
            changed_execution,
            strategy=AdaptiveStrategy.L_ADAPTIVE_EXECUTION,
            scenario=PaperScenario.BASE_1S,
            bankroll=Decimal("10000"),
            config=KJConfig(),
        )
        self.assertEqual(baseline["required_edge"], changed["required_edge"])
        self.assertEqual(
            baseline["market_quote_reprice_risk_proxy"],
            changed["market_quote_reprice_risk_proxy"],
        )

    def test_l_adaptive_preregistration_blocks_final_test_and_isolates_l(self) -> None:
        receipt = SimpleNamespace(
            dataset_hash="a" * 64,
            manifest={"audit": {"gate": {"passed": True}}},
        )
        train = row()
        train["split"] = "TRAIN"
        validation = row(condition="m2", winner="Down")
        validation["split"] = "VALIDATION"
        with self.assertRaisesRegex(ValueError, "only TRAIN or VALIDATION"):
            run_l_adaptive_paper(receipt, (train, validation), split="FINAL_TEST")
        with self.assertRaisesRegex(ValueError, "only TRAIN or VALIDATION"):
            run_kj_paper(
                receipt,
                (train, validation),
                strategies=(AdaptiveStrategy.L_ADAPTIVE_EXECUTION,),
                split="FINAL_TEST",
            )
        result = run_l_adaptive_paper(receipt, (train, validation), split="TRAIN")
        self.assertEqual(result["evaluation_stage"], "TRAIN_FIXED_CONFIGURATION_AUDIT")
        self.assertEqual(
            result["evaluation_protocol"]["final_test_policy"],
            "LOCKED_NOT_ACCEPTED_BY_PAPER_L_ADAPTIVE",
        )
        self.assertEqual(result["config"]["config_version"], LAdaptiveConfig().config_version)
        self.assertNotIn("edge_threshold", result["config"])
        with self.assertRaisesRegex(ValueError, "run separately"):
            run_kj_paper(
                receipt,
                (train,),
                strategies=(KJStrategy.J_FEE_AWARE, AdaptiveStrategy.L_ADAPTIVE_EXECUTION),
                split="TRAIN",
            )

    def test_l_adaptive_cli_exposes_only_train_and_validation(self) -> None:
        arguments = parser().parse_args(
            [
                "paper-l-adaptive",
                "--dataset",
                "/tmp/dataset",
                "--dataset-hash",
                "a" * 64,
                "--split",
                "VALIDATION",
                "--output",
                "/tmp/output",
            ]
        )
        self.assertEqual(arguments.command, "paper-l-adaptive")
        with self.assertRaises(SystemExit):
            parser().parse_args(
                [
                    "paper-l-adaptive",
                    "--dataset",
                    "/tmp/dataset",
                    "--dataset-hash",
                    "a" * 64,
                    "--split",
                    "FINAL_TEST",
                    "--output",
                    "/tmp/output",
                ]
            )

    def test_python_ewma_to_intent_is_the_shared_decision_golden_reference(self) -> None:
        fixture_path = (
            Path(__file__).parents[2]
            / "data"
            / "golden"
            / "batch-06"
            / "kj-ewma-intent-parity-v1.json"
        )
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        single = EwmaVolatility(100, minimum_sigma=0.00002, sample_interval_seconds=5)
        dual = KJDualVolatility.legacy_parameters()
        for sample in fixture["prices"]:
            single.update(float(sample["price"]), sample["offsetSeconds"])
            dual.update(float(sample["price"]), sample["offsetSeconds"])
        volatility = {
            "j_single_sigma": format(single.sigma, ".17g"),
            "k_effective_sigma": format(dual.effective_sigma, ".17g"),
        }
        book = fixture["decisionBook"]
        decision_row = {
            "condition_id": "golden-market",
            "slug": "btc-updown-5m-1784246400",
            "decision_time": "2026-07-17T00:03:05.000Z",
            "market_start": fixture["market"]["intervalStart"],
            "market_end": fixture["market"]["intervalEnd"],
            "split": "GOLDEN",
            "horizon_seconds": fixture["market"]["horizonSeconds"],
            "winner": "Up",
            "binance": {
                "start_price": fixture["market"]["startPrice"],
                "current_price": fixture["prices"][-1]["price"],
                "log_return_from_start": str(math.log(60240 / 60000)),
                "realized_vol_30s": "0.001",
                "realized_vol_60s": "0.001",
                "realized_vol_120s": "0.001",
            },
            "books": {
                "decision_plus_1s_visibility": {
                    "bu": book["upBid"], "au": book["upAsk"],
                    "bd": book["downBid"], "ad": book["downAsk"],
                    "su": "1000", "sd": "1000",
                    "sau": book["askSize"], "sad": book["askSize"],
                },
                "execution_base_1s": {
                    "bu": book["upBid"], "au": book["upAsk"],
                    "bd": book["downBid"], "ad": book["downAsk"],
                    "su": "1000", "sd": "1000",
                    "sau": book["askSize"], "sad": book["askSize"],
                },
            },
            "fee_evidence": {
                "grade": "MARKET_STATIC_OFFICIAL",
                "fee_rate": fixture["feeRate"],
                "fetch_time": "2026-07-17T00:05:01Z",
            },
        }
        numeric_tolerance = Decimal(fixture["tolerances"]["numericAbsolute"])
        probability_tolerance = Decimal(fixture["tolerances"]["probabilityAbsolute"])
        reason_mapping = {
            "EDGE_BELOW_FEE_AWARE_THRESHOLD": "EDGE_BELOW_THRESHOLD",
            None: "EDGE_ACCEPTED",
        }
        for strategy in KJStrategy:
            event = simulate_decision(
                decision_row,
                strategy=strategy,
                scenario=PaperScenario.BASE_1S,
                bankroll=Decimal("10000"),
                config=KJConfig(),
                volatility_sample=volatility,
            )
            expected = fixture["expected"][strategy.value]
            action = "INTENT" if event["status"] == "FILLED" else event["status"]
            self.assertEqual(action, expected["action"])
            self.assertEqual(reason_mapping[event["reason"]], expected["reason"])
            self.assertEqual(event["side"], expected["outcome"])
            self.assertLessEqual(
                abs(Decimal(event["effective_sigma"]) - Decimal(expected["sigma"])),
                numeric_tolerance,
            )
            for field, expected_field in (
                ("probability_up", "probabilityUp"),
                ("edge", "edge"),
            ):
                self.assertLessEqual(
                    abs(Decimal(event[field]) - Decimal(expected[expected_field])),
                    probability_tolerance,
                )
            self.assertLessEqual(
                abs(Decimal(event["required_edge"]) - Decimal(expected["requiredEdge"])),
                numeric_tolerance,
            )
            if expected["intendedQuantity"] is None:
                self.assertNotIn("intended_quantity", event)
            else:
                self.assertLessEqual(
                    abs(
                        Decimal(event["intended_quantity"])
                        - Decimal(expected["intendedQuantity"])
                    ),
                    numeric_tolerance,
                )
            if expected["fill"] is None:
                self.assertEqual(event["status"], "NO_TRADE")
                continue
            fill = expected["fill"]
            for field, expected_field in (
                ("fill_price", "price"),
                ("quantity", "quantity"),
                ("stake", "cost"),
                ("fee", "fee"),
                ("cash_after_fill", "cashAfterFill"),
                ("position_after_fill", "positionAfter"),
                ("payout", "payout"),
                ("gross_pnl", "grossPnl"),
                ("net_pnl", "netPnl"),
                ("bankroll_after", "finalCash"),
            ):
                self.assertLessEqual(
                    abs(Decimal(event[field]) - Decimal(fill[expected_field])),
                    numeric_tolerance,
                    field,
                )

    def test_python_erf_is_the_shared_probability_golden_reference(self) -> None:
        fixture_path = (
            Path(__file__).parents[2]
            / "data"
            / "golden"
            / "batch-06"
            / "kj-probability-v1.json"
        )
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        tolerance = Decimal(fixture["referenceAbsoluteError"])
        for case in fixture["cases"]:
            z = float(case["z"])
            raw = Decimal(str(0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))))
            actual = min(max(raw, Decimal("0.005")), Decimal("0.995"))
            self.assertLessEqual(
                abs(actual - Decimal(case["expectedProbability"])),
                tolerance,
                case["z"],
            )

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
            intent = json.loads((output / "publication-intent.json").read_text(encoding="utf-8"))
            self.assertEqual(intent["schema_version"], HISTORICAL_PAPER_PUBLICATION_VERSION)
            self.assertEqual(intent["result_hash"], result["result_hash"])
            publication = json.loads((output / "publication.json").read_text(encoding="utf-8"))
            self.assertEqual(publication["schema_version"], HISTORICAL_PAPER_PUBLICATION_VERSION)
            self.assertEqual(publication["result_hash"], result["result_hash"])
            self.assertEqual(set(publication["files"]), {"summary.json", "events.ndjson", "trades.csv"})
            self.assertTrue(all(item["bytes"] > 0 and len(item["sha256"]) == 64 for item in publication["files"].values()))
            for name, evidence in publication["files"].items():
                self.assertEqual(evidence["sha256"], sha256((output / name).read_bytes()).hexdigest())
            publication_core = {key: value for key, value in publication.items() if key != "publication_hash"}
            self.assertEqual(
                publication["publication_hash"],
                sha256(json.dumps(publication_core, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")).hexdigest(),
            )
            lines = (output / "events.ndjson").read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines), 4)
            self.assertTrue(all(json.loads(line)["strategy"] for line in lines))
            with self.assertRaises(FileExistsError):
                export_kj_paper(result, output)


if __name__ == "__main__":
    unittest.main()
