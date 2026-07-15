from __future__ import annotations

from dataclasses import replace
from datetime import timedelta
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from research.polymarket_money.backtest import (
    DatasetAcceptancePolicy,
    ExecutionConfig,
    ExecutionModel,
    ExecutionScenario,
    FeeModel,
    FeeRate,
    FeeSchedule,
    FixedDecisionFixtureStrategy,
    LiquidityRole,
    NoTradeStrategy,
    ReplayEngine,
    StrategyOutput,
)
from research.polymarket_money.domain import (
    Decision,
    DecisionAction,
    OrderIntent,
    Side,
)
from research.polymarket_money.normalized import DatasetPublicationError
from tests.helpers.backtest_fixtures import MARKET_ID, START, dataset
from tests.helpers.published_backtest import (
    PUBLISHED_END,
    PUBLISHED_START,
    PUBLISHED_UP,
    publish_backtest_fixture,
)


def fee_model(market_id: str) -> FeeModel:
    return FeeModel(
        FeeSchedule(
            version="causal-replay-fee-v1",
            historical_verified=False,
            rates=(
                FeeRate(
                    market_id=market_id,
                    liquidity_role=LiquidityRole.TAKER,
                    effective_from=PUBLISHED_START,
                    effective_to=PUBLISHED_END,
                    rate=Decimal("0.01"),
                    quantum=Decimal("0.0001"),
                    rounding=ROUND_HALF_UP,
                ),
            ),
        )
    )


def fixed_output(market_id: str) -> StrategyOutput:
    decision_time = PUBLISHED_START + timedelta(milliseconds=100)
    decision = Decision(
        decision_id=f"decision-{market_id}",
        market_id=market_id,
        token_id=PUBLISHED_UP,
        action=DecisionAction.BUY,
        decision_time=decision_time,
        input_receive_time=decision_time,
    )
    return StrategyOutput(
        decision=decision,
        order_intent=OrderIntent(
            intent_id=f"intent-{market_id}",
            idempotency_key=f"key-{market_id}",
            decision_id=decision.decision_id,
            market_id=market_id,
            token_id=PUBLISHED_UP,
            side=Side.BUY,
            limit_price=Decimal("0.60"),
            quantity=Decimal("1"),
            decision_time=decision_time,
            order_send_time=None,
        ),
    )


class CausalReplayTest(unittest.TestCase):
    def test_replay_rejects_a_direct_unpublished_dataset(self) -> None:
        with self.assertRaises(DatasetPublicationError):
            ReplayEngine.from_dataset_forbidden(dataset())

    def test_replay_constructor_cannot_bypass_verified_open(self) -> None:
        policy = DatasetAcceptancePolicy()
        with self.assertRaisesRegex(DatasetPublicationError, "open"):
            ReplayEngine(
                dataset(),
                expected_dataset_hash="a" * 64,
                execution_model=ExecutionModel(
                    ExecutionConfig(ExecutionScenario.TAKER_TOUCH_WITH_FEES),
                    fee_model=fee_model(MARKET_ID),
                    acceptance_policy=policy,
                ),
                acceptance_policy=policy,
                require_clean_normalizer=False,
                _proof=object(),
            )

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

    def test_published_dataset_hash_pin_is_mandatory(self) -> None:
        market_id = "hash-pin-market"
        with TemporaryDirectory() as directory:
            version, _ = publish_backtest_fixture(
                Path(directory),
                market_id=market_id,
                initial_up_bid="0.49",
                initial_up_ask="0.51",
                initial_down_bid="0.48",
                initial_down_ask="0.52",
                open_price="60000",
                close_price="60001",
            )
            policy = DatasetAcceptancePolicy()
            with self.assertRaisesRegex(DatasetPublicationError, "hash pin"):
                ReplayEngine.open(
                    version,
                    expected_dataset_hash="0" * 64,
                    execution_model=ExecutionModel(
                        ExecutionConfig(ExecutionScenario.TAKER_TOUCH_WITH_FEES),
                        fee_model=fee_model(market_id),
                        acceptance_policy=policy,
                    ),
                    acceptance_policy=policy,
                    require_clean_normalizer=False,
                )

    def test_no_trade_strategy_runs_published_data_without_intent_or_fill(self) -> None:
        market_id = "no-trade-market"
        with TemporaryDirectory() as directory:
            version, dataset_hash = publish_backtest_fixture(
                Path(directory),
                market_id=market_id,
                initial_up_bid="0.49",
                initial_up_ask="0.51",
                initial_down_bid="0.48",
                initial_down_ask="0.52",
                open_price="60000",
                close_price="60001",
            )
            policy = DatasetAcceptancePolicy()
            engine = ReplayEngine.open(
                version,
                expected_dataset_hash=dataset_hash,
                execution_model=ExecutionModel(
                    ExecutionConfig(ExecutionScenario.TAKER_TOUCH_WITH_FEES),
                    fee_model=fee_model(market_id),
                    acceptance_policy=policy,
                ),
                acceptance_policy=policy,
                require_clean_normalizer=False,
            )
            strategy = NoTradeStrategy(
                ((market_id, PUBLISHED_START + timedelta(milliseconds=100)),)
            )
            result = engine.run(strategy)
            self.assertEqual(result.decision_count, 1)
            self.assertEqual(result.intent_count, 0)
            self.assertEqual(result.fill_event_count, 0)
            self.assertEqual(result.replay_hash, engine.run(strategy).replay_hash)

    def test_future_book_mutation_does_not_change_earlier_decision_or_fill(self) -> None:
        market_id = "future-invariance-market"
        executions = []
        decisions = []
        hashes = []
        for updates in ((), ((250, PUBLISHED_UP, "0.39", "0.40"),)):
            with TemporaryDirectory() as directory:
                version, dataset_hash = publish_backtest_fixture(
                    Path(directory),
                    market_id=market_id,
                    initial_up_bid="0.49",
                    initial_up_ask="0.51",
                    initial_down_bid="0.48",
                    initial_down_ask="0.52",
                    open_price="60000",
                    close_price="60001",
                    updates=updates,
                )
                policy = DatasetAcceptancePolicy()
                engine = ReplayEngine.open(
                    version,
                    expected_dataset_hash=dataset_hash,
                    execution_model=ExecutionModel(
                        ExecutionConfig(ExecutionScenario.TAKER_TOUCH_WITH_FEES),
                        fee_model=fee_model(market_id),
                        acceptance_policy=policy,
                    ),
                    acceptance_policy=policy,
                    require_clean_normalizer=False,
                )
                result = engine.run(FixedDecisionFixtureStrategy((fixed_output(market_id),)))
                audit = result.market_audits[0]
                executions.append(audit.executions[0].to_mapping())
                decisions.append(audit.decisions[0])
                hashes.append(result.replay_hash)
        self.assertEqual(executions[0], executions[1])
        self.assertEqual(decisions[0], decisions[1])
        self.assertNotEqual(hashes[0], hashes[1])

    def test_unsettled_fill_never_claims_verified_net_pnl(self) -> None:
        market_id = "unsettled-market"
        with TemporaryDirectory() as directory:
            version, dataset_hash = publish_backtest_fixture(
                Path(directory),
                market_id=market_id,
                initial_up_bid="0.49",
                initial_up_ask="0.51",
                initial_down_bid="0.48",
                initial_down_ask="0.52",
                open_price="60000",
                close_price="60001",
            )
            policy = DatasetAcceptancePolicy()
            engine = ReplayEngine.open(
                version,
                expected_dataset_hash=dataset_hash,
                execution_model=ExecutionModel(
                    ExecutionConfig(ExecutionScenario.TAKER_TOUCH_WITH_FEES),
                    fee_model=fee_model(market_id),
                    acceptance_policy=policy,
                ),
                acceptance_policy=policy,
                require_clean_normalizer=False,
            )
            result = engine.run(FixedDecisionFixtureStrategy((fixed_output(market_id),)))
            self.assertEqual(result.fill_event_count, 1)
            self.assertFalse(result.net_pnl_verified)
            self.assertEqual(result.pnl_status, "UNSETTLED")

    def test_duplicate_decision_id_with_different_content_fails_closed(self) -> None:
        market_id = "duplicate-decision-market"
        first = fixed_output(market_id)
        later_time = PUBLISHED_START + timedelta(milliseconds=200)
        second_decision = replace(
            first.decision,
            decision_time=later_time,
            input_receive_time=later_time,
        )
        second = StrategyOutput(
            second_decision,
            replace(
                first.order_intent,
                intent_id="intent-duplicate-second",
                idempotency_key="key-duplicate-second",
                decision_time=later_time,
            ),
        )
        with TemporaryDirectory() as directory:
            version, dataset_hash = publish_backtest_fixture(
                Path(directory), market_id=market_id,
                initial_up_bid="0.49", initial_up_ask="0.51",
                initial_down_bid="0.48", initial_down_ask="0.52",
                open_price="60000", close_price="60001",
            )
            policy = DatasetAcceptancePolicy()
            engine = ReplayEngine.open(
                version, expected_dataset_hash=dataset_hash,
                execution_model=ExecutionModel(
                    ExecutionConfig(ExecutionScenario.TAKER_TOUCH_WITH_FEES),
                    fee_model=fee_model(market_id), acceptance_policy=policy,
                ),
                acceptance_policy=policy, require_clean_normalizer=False,
            )
            with self.assertRaisesRegex(ValueError, "decision_id"):
                engine.run(FixedDecisionFixtureStrategy((first, second)))

    def test_reused_idempotency_key_with_different_content_fails_closed(self) -> None:
        market_id = "duplicate-key-market"
        first = fixed_output(market_id)
        later_time = PUBLISHED_START + timedelta(milliseconds=200)
        second_decision = replace(
            first.decision,
            decision_id="decision-second",
            decision_time=later_time,
            input_receive_time=later_time,
        )
        second = StrategyOutput(
            second_decision,
            replace(
                first.order_intent,
                intent_id="intent-second",
                decision_id=second_decision.decision_id,
                quantity=Decimal("2"),
                decision_time=later_time,
            ),
        )
        with TemporaryDirectory() as directory:
            version, dataset_hash = publish_backtest_fixture(
                Path(directory), market_id=market_id,
                initial_up_bid="0.49", initial_up_ask="0.51",
                initial_down_bid="0.48", initial_down_ask="0.52",
                open_price="60000", close_price="60001",
            )
            policy = DatasetAcceptancePolicy()
            engine = ReplayEngine.open(
                version, expected_dataset_hash=dataset_hash,
                execution_model=ExecutionModel(
                    ExecutionConfig(ExecutionScenario.TAKER_TOUCH_WITH_FEES),
                    fee_model=fee_model(market_id), acceptance_policy=policy,
                ),
                acceptance_policy=policy, require_clean_normalizer=False,
            )
            with self.assertRaisesRegex(ValueError, "idempotency_key"):
                engine.run(FixedDecisionFixtureStrategy((first, second)))


if __name__ == "__main__":
    unittest.main()
