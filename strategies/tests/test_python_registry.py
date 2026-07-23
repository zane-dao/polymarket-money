from __future__ import annotations

import unittest
from decimal import Decimal
from unittest.mock import patch

from strategies.src.python.registry import (
    STRATEGY_CATALOG,
    StrategyDescriptor,
    resolve_strategy,
    run_registered_workbench_backtest,
)


class PythonStrategyRegistryTest(unittest.TestCase):
    def test_catalog_contains_all_current_strategy_families(self) -> None:
        self.assertEqual(
            set(STRATEGY_CATALOG),
            {
                "B0_NO_TRADE",
                "B1_MARKET_PROBABILITY",
                "B2_GBM_BINANCE_PROXY",
                "B3_MARKET_PRIOR_LOGISTIC",
                "J_FEE_AWARE",
                "K_DUAL_VOL",
                "L_ADAPTIVE_EXECUTION_V1",
                "L_ADAPTIVE_EXECUTION_V2",
            },
        )

    def test_l_versions_remain_distinct_and_auditable(self) -> None:
        v1 = resolve_strategy("L_ADAPTIVE_EXECUTION_V1")
        v2 = resolve_strategy("L_ADAPTIVE_EXECUTION_V2")
        self.assertEqual(v1.version, "l-adaptive-execution-v1-preregistered")
        self.assertEqual(v1.status, "RESEARCH_GATE_FAILED")
        self.assertEqual(v2.version, "l-adaptive-execution-v2-candidate")
        self.assertEqual(v2.status, "RESEARCH_ONLY_CANDIDATE")

    def test_unknown_strategy_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown strategy"):
            resolve_strategy("POLYMARKET_PAPER_LEGACY_MAIN")

    def test_workbench_dispatch_is_registry_driven(self) -> None:
        calls: list[tuple[object, object, dict[str, object], Decimal, Decimal]] = []

        def adapter(receipt: object, rows: object, parameters: dict[str, object],
                    cash: Decimal, position: Decimal,
                    _evaluation_split: str | None = None) -> tuple[dict[str, object], str]:
            calls.append((receipt, rows, parameters, cash, position))
            return {"runs": {}, "events": []}, "SYNTHETIC_REGISTERED"

        descriptor = StrategyDescriptor(
            "SYNTHETIC_REGISTERED", "TEST", "1.0.0", "TEST_ONLY", adapter, adapter
        )
        STRATEGY_CATALOG[descriptor.strategy_id] = descriptor
        try:
            result, result_id = run_registered_workbench_backtest(
                descriptor.strategy_id, "receipt", ("row",), {"threshold": 0.1},
                Decimal("100"), Decimal("5"),
            )
        finally:
            del STRATEGY_CATALOG[descriptor.strategy_id]
        self.assertEqual(result_id, descriptor.strategy_id)
        self.assertEqual(result, {"runs": {}, "events": []})
        self.assertEqual(calls[0][2], {"threshold": 0.1})

    def test_all_frozen_baselines_have_workbench_adapters(self) -> None:
        for strategy_id in ("B0_NO_TRADE", "B1_MARKET_PROBABILITY", "B2_GBM_BINANCE_PROXY", "B3_MARKET_PRIOR_LOGISTIC"):
            self.assertIsNotNone(resolve_strategy(strategy_id).workbench_backtest)

    def test_l_v2_workbench_uses_frozen_train_selected_candidate(self) -> None:
        captured: dict[str, object] = {}

        def fake_run(*_args: object, **kwargs: object) -> dict[str, object]:
            captured.update(kwargs)
            return {"runs": {"L_ADAPTIVE_EXECUTION": {}}, "events": []}

        with patch("strategies.src.python.registry.run_kj_paper", side_effect=fake_run):
            run_registered_workbench_backtest(
                "L_ADAPTIVE_EXECUTION_V2", object(), (),
                {"maxSignalEdge": 0.25, "maxStakeUsdc": 100, "bookParticipation": 0.5},
                Decimal("10000"), Decimal("100"),
            )
        adaptive = captured["adaptive_config"]
        self.assertEqual(adaptive.config_version, "l-adaptive-execution-v2-candidate")
        self.assertEqual(adaptive.probability_clamp, Decimal("0.02"))
        self.assertEqual(adaptive.depth_risk_max, Decimal("0.02"))
        self.assertEqual(adaptive.entry_price_min, Decimal("0.20"))
        self.assertEqual(adaptive.entry_price_max, Decimal("0.80"))


if __name__ == "__main__":
    unittest.main()
