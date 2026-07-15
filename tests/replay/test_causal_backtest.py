from __future__ import annotations

from datetime import timedelta
import unittest

from research.polymarket_money.backtest import (
    DatasetAcceptancePolicy,
    ExecutionConfig,
    ExecutionScenario,
    FixedDecisionFixtureStrategy,
    NoTradeStrategy,
    ReplayEngine,
)
from research.polymarket_money.normalized import DatasetPublicationError
from tests.helpers.backtest_fixtures import MARKET_ID, START, dataset


class CausalReplayTest(unittest.TestCase):
    def test_replay_rejects_a_direct_unpublished_dataset(self) -> None:
        with self.assertRaises(DatasetPublicationError):
            ReplayEngine.from_dataset_forbidden(dataset())

    def test_no_trade_strategy_is_deterministic_and_emits_no_intent(self) -> None:
        strategy = NoTradeStrategy(((MARKET_ID, START + timedelta(milliseconds=100)),))
        self.assertEqual(strategy.config_mapping(), strategy.config_mapping())

    def test_fixed_strategy_releases_only_predefined_decisions(self) -> None:
        strategy = FixedDecisionFixtureStrategy(())
        self.assertEqual(strategy.decision_points(), ())

    def test_replay_config_hash_binds_execution_assumptions(self) -> None:
        touch = ExecutionConfig(scenario=ExecutionScenario.DEBUG_TOUCH)
        latency = ExecutionConfig(
            scenario=ExecutionScenario.LATENCY,
            latency=timedelta(milliseconds=50),
        )
        self.assertNotEqual(touch.config_hash, latency.config_hash)

    def test_acceptance_policy_version_is_stable(self) -> None:
        self.assertEqual(DatasetAcceptancePolicy().version, "dataset-acceptance-v1")


if __name__ == "__main__":
    unittest.main()
