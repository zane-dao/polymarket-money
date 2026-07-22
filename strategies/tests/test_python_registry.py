from __future__ import annotations

import unittest
from decimal import Decimal

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
                    cash: Decimal, position: Decimal) -> tuple[dict[str, object], str]:
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

    def test_strategy_without_workbench_adapter_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "has no offline workbench runner"):
            run_registered_workbench_backtest(
                "B0_NO_TRADE", object(), (), {}, Decimal("100"), Decimal("5")
            )


if __name__ == "__main__":
    unittest.main()
