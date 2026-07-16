from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from research.polymarket_money.runtime import ReplaySpeed, run_no_trade_replay
from tests.helpers.published_backtest import publish_backtest_fixture


class RuntimeReplayTest(unittest.TestCase):
    def test_runtime_delegates_to_replay_engine_and_is_deterministic(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            version, dataset_hash = publish_backtest_fixture(
                root,
                market_id="runtime-replay-market",
                initial_up_bid="0.49",
                initial_up_ask="0.51",
                initial_down_bid="0.49",
                initial_down_ask="0.51",
                open_price="60000",
                close_price="60001",
            )
            first = run_no_trade_replay(version, dataset_hash, speed=ReplaySpeed.MAX)
            second = run_no_trade_replay(version, dataset_hash, speed=ReplaySpeed.MAX)
            self.assertEqual(first.replay_hash, second.replay_hash)
            self.assertEqual(first.to_mapping(), second.to_mapping())
            self.assertGreater(first.decision_count, 0)
            self.assertIsNotNone(first.market_audits[0].settlement)
            self.assertIsNotNone(first.market_audits[0].pnl)


if __name__ == "__main__":
    unittest.main()
