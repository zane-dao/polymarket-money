from __future__ import annotations

from datetime import timedelta
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from research.polymarket_money.backtest import (
    DISCLAIMER,
    DatasetAcceptancePolicy,
    ExecutionConfig,
    ExecutionModel,
    ExecutionScenario,
    FeeModel,
    FeeRate,
    FeeSchedule,
    FixedDecisionFixtureStrategy,
    LiquidityRole,
    ReplayEngine,
    StrategyOutput,
)
from research.polymarket_money.domain import Decision, DecisionAction, OrderIntent, Side
from tests.helpers.published_backtest import (
    PUBLISHED_DOWN,
    PUBLISHED_END,
    PUBLISHED_START,
    PUBLISHED_UP,
    publish_backtest_fixture,
)


def output(
    *,
    market_id: str,
    milliseconds: int,
    token_id: str,
    side: Side,
    price: str,
    quantity: str,
    ordinal: int,
) -> StrategyOutput:
    decision_time = PUBLISHED_START + timedelta(milliseconds=milliseconds)
    action = DecisionAction.BUY if side is Side.BUY else DecisionAction.SELL
    decision = Decision(
        decision_id=f"decision-{market_id}-{ordinal}",
        market_id=market_id,
        token_id=token_id,
        action=action,
        decision_time=decision_time,
        input_receive_time=decision_time,
        reason_codes=("FIXED_GOLDEN_FIXTURE",),
    )
    intent = OrderIntent(
        intent_id=f"intent-{market_id}-{ordinal}",
        idempotency_key=f"key-{market_id}-{ordinal}",
        decision_id=decision.decision_id,
        market_id=market_id,
        token_id=token_id,
        side=side,
        limit_price=Decimal(price),
        quantity=Decimal(quantity),
        decision_time=decision_time,
        order_send_time=None,
    )
    return StrategyOutput(decision=decision, order_intent=intent)


def fee_schedule(
    market_id: str,
    rows: tuple[tuple[int, int, str], ...],
) -> FeeModel:
    return FeeModel(
        FeeSchedule(
            version=f"fixture-fees-{market_id}",
            historical_verified=False,
            rates=tuple(
                FeeRate(
                    market_id=market_id,
                    liquidity_role=LiquidityRole.TAKER,
                    effective_from=PUBLISHED_START + timedelta(milliseconds=start_ms),
                    effective_to=(
                        PUBLISHED_END
                        if end_ms == 300_000
                        else PUBLISHED_START + timedelta(milliseconds=end_ms)
                    ),
                    rate=Decimal(rate),
                    quantum=Decimal("0.01"),
                    rounding=ROUND_HALF_UP,
                )
                for start_ms, end_ms, rate in rows
            ),
        )
    )


class BacktestCoreGoldenTest(unittest.TestCase):
    def run_case(
        self,
        *,
        market_id: str,
        initial_up: tuple[str, str],
        initial_down: tuple[str, str],
        close_price: str,
        updates: tuple[tuple[int, str, str, str], ...],
        outputs: tuple[StrategyOutput, ...],
        fees: FeeModel,
    ):
        with TemporaryDirectory() as directory:
            version, dataset_hash = publish_backtest_fixture(
                Path(directory),
                market_id=market_id,
                initial_up_bid=initial_up[0],
                initial_up_ask=initial_up[1],
                initial_down_bid=initial_down[0],
                initial_down_ask=initial_down[1],
                open_price="60000",
                close_price=close_price,
                updates=updates,
            )
            policy = DatasetAcceptancePolicy()
            engine = ReplayEngine.open(
                version,
                expected_dataset_hash=dataset_hash,
                execution_model=ExecutionModel(
                    ExecutionConfig(ExecutionScenario.TAKER_TOUCH_WITH_FEES),
                    fee_model=fees,
                    acceptance_policy=policy,
                ),
                acceptance_policy=policy,
                require_clean_normalizer=False,
            )
            strategy = FixedDecisionFixtureStrategy(outputs)
            first = engine.run(
                strategy,
                settlement_times={market_id: PUBLISHED_END + timedelta(milliseconds=100)},
            )
            second = engine.run(
                strategy,
                settlement_times={market_id: PUBLISHED_END + timedelta(milliseconds=100)},
            )
            self.assertEqual(first.replay_hash, second.replay_hash)
            self.assertEqual(first.to_mapping(), second.to_mapping())
            return first

    def test_three_manual_markets_match_hand_calculated_pnl_through_full_pipeline(self) -> None:
        cases = (
            {
                "market_id": "manual-market-1",
                "initial_up": ("0.54", "0.55"),
                "initial_down": ("0.44", "0.45"),
                "close": "60001",
                "updates": (),
                "outputs": (
                    output(
                        market_id="manual-market-1",
                        milliseconds=100,
                        token_id=PUBLISHED_UP,
                        side=Side.BUY,
                        price="0.55",
                        quantity="10",
                        ordinal=1,
                    ),
                ),
                "fees": fee_schedule(
                    "manual-market-1", ((0, 300_000, "0.01818181818181818181818181818"),)
                ),
                "expected": "4.40",
                "gross": "4.50",
                "fee": "0.10",
                "payout": "10",
                "cash": "5.50",
            },
            {
                "market_id": "manual-market-2",
                "initial_up": ("0.47", "0.48"),
                "initial_down": ("0.51", "0.52"),
                "close": "60000",
                "updates": ((150, PUBLISHED_UP, "0.49", "0.50"),),
                "outputs": (
                    output(
                        market_id="manual-market-2",
                        milliseconds=100,
                        token_id=PUBLISHED_UP,
                        side=Side.BUY,
                        price="0.48",
                        quantity="4",
                        ordinal=1,
                    ),
                    output(
                        market_id="manual-market-2",
                        milliseconds=200,
                        token_id=PUBLISHED_UP,
                        side=Side.BUY,
                        price="0.50",
                        quantity="6",
                        ordinal=2,
                    ),
                ),
                "fees": fee_schedule(
                    "manual-market-2",
                    (
                        (0, 150, "0.01041666666666666666666666667"),
                        (150, 300_000, "0.01"),
                    ),
                ),
                "expected": "5.03",
                "gross": "5.08",
                "fee": "0.05",
                "payout": "10",
                "cash": "4.92",
            },
            {
                "market_id": "manual-market-3",
                "initial_up": ("0.39", "0.40"),
                "initial_down": ("0.59", "0.60"),
                "close": "59999",
                "updates": ((150, PUBLISHED_DOWN, "0.70", "0.71"),),
                "outputs": (
                    output(
                        market_id="manual-market-3",
                        milliseconds=100,
                        token_id=PUBLISHED_DOWN,
                        side=Side.BUY,
                        price="0.60",
                        quantity="8",
                        ordinal=1,
                    ),
                    output(
                        market_id="manual-market-3",
                        milliseconds=200,
                        token_id=PUBLISHED_DOWN,
                        side=Side.SELL,
                        price="0.70",
                        quantity="3",
                        ordinal=2,
                    ),
                ),
                "fees": fee_schedule(
                    "manual-market-3",
                    (
                        (0, 150, "0.01666666666666666666666666667"),
                        (150, 300_000, "0.01428571428571428571428571429"),
                    ),
                ),
                "expected": "2.19",
                "gross": "2.30",
                "fee": "0.11",
                "payout": "5",
                "cash": "2.70",
            },
        )
        for case in cases:
            with self.subTest(market_id=case["market_id"]):
                result = self.run_case(
                    market_id=case["market_id"],
                    initial_up=case["initial_up"],
                    initial_down=case["initial_down"],
                    close_price=case["close"],
                    updates=case["updates"],
                    outputs=case["outputs"],
                    fees=case["fees"],
                )
                self.assertEqual(result.net_pnl, Decimal(case["expected"]))
                self.assertEqual(result.gross_pnl, Decimal(case["gross"]))
                self.assertEqual(result.fees, Decimal(case["fee"]))
                self.assertFalse(result.net_pnl_verified)
                self.assertEqual(result.pnl_status, "COMPLETE_FEE_UNVERIFIED")
                self.assertEqual(result.disclaimer, DISCLAIMER)
                self.assertEqual(result.dataset_hash, result.market_audits[0].dataset_hash)
                audit = result.market_audits[0]
                self.assertEqual(audit.pnl.payout, Decimal(case["payout"]))
                self.assertEqual(audit.pnl.net_cash_outlay, Decimal(case["cash"]))
                self.assertIsNotNone(audit.settlement)
                self.assertEqual(
                    sum(
                        (fill.fee for execution in audit.executions for fill in execution.fills),
                        Decimal("0"),
                    ),
                    result.fees,
                )
                self.assertEqual(
                    sum(
                        (len(execution.fills) for execution in audit.executions),
                        0,
                    ),
                    result.fill_event_count,
                )
                self.assertEqual(
                    result.intent_count,
                    result.fully_filled_order_count
                    + result.partially_filled_order_count
                    + result.unfilled_order_count,
                )
                self.assertEqual(
                    result.fill_event_count,
                    sum(len(item.fills) for item in result.market_audits[0].executions),
                )


if __name__ == "__main__":
    unittest.main()
