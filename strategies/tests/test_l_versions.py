from __future__ import annotations

from decimal import Decimal
import unittest

from strategies.src.python.kj_l import (
    LAdaptiveConfig,
    l_adaptive_v2_midrange_train_selected_config,
)
from strategies.src.python.registry import resolve_strategy


class LStrategyVersionsTest(unittest.TestCase):
    def test_v1_and_v2_have_distinct_frozen_identity_and_status(self) -> None:
        v1 = resolve_strategy("L_ADAPTIVE_EXECUTION_V1")
        v2 = resolve_strategy("L_ADAPTIVE_EXECUTION_V2")

        self.assertEqual(v1.version, LAdaptiveConfig().config_version)
        self.assertEqual(v1.status, "RESEARCH_GATE_FAILED")
        self.assertEqual(
            v2.version,
            l_adaptive_v2_midrange_train_selected_config().config_version,
        )
        self.assertEqual(v2.status, "RESEARCH_ONLY_CANDIDATE")
        self.assertIs(v1.implementation, v2.implementation)

    def test_v2_train_selected_parameters_remain_frozen(self) -> None:
        config = l_adaptive_v2_midrange_train_selected_config()

        self.assertEqual(config.probability_clamp, Decimal("0.02"))
        self.assertEqual(config.max_signal_edge, Decimal("0.25"))
        self.assertEqual(config.depth_risk_max, Decimal("0.02"))
        self.assertEqual(config.entry_price_min, Decimal("0.20"))
        self.assertEqual(config.entry_price_max, Decimal("0.80"))


if __name__ == "__main__":
    unittest.main()
