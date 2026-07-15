from __future__ import annotations

from datetime import timedelta
from decimal import Decimal, ROUND_HALF_UP
import unittest

from research.polymarket_money.backtest import (
    DatasetAcceptancePolicy,
    ExecutionConfig,
    ExecutionModel,
    ExecutionScenario,
    FeeModel,
    FeeRate,
    FeeSchedule,
    LiquidityRole,
    NoFillReason,
    market_from_view,
)
from research.polymarket_money.domain import Side
from research.polymarket_money.normalized import PointInTimeDataset, RecordType
from tests.helpers.backtest_fixtures import (
    END,
    MARKET_ID,
    START,
    UP_TOKEN,
    base_records,
    dataset,
    intent,
    record,
)


def fees(*, rate: str = "0.01", verified: bool = True) -> FeeModel:
    return FeeModel(
        FeeSchedule(
            version="fixture-fees-v1",
            historical_verified=verified,
            rates=(
                FeeRate(
                    market_id=MARKET_ID,
                    liquidity_role=LiquidityRole.TAKER,
                    effective_from=START,
                    effective_to=END,
                    rate=Decimal(rate),
                    quantum=Decimal("0.0001"),
                    rounding=ROUND_HALF_UP,
                ),
                FeeRate(
                    market_id=MARKET_ID,
                    liquidity_role=LiquidityRole.NO_FEE,
                    effective_from=START,
                    effective_to=END,
                    rate=Decimal("0"),
                    quantum=Decimal("0.0001"),
                    rounding=ROUND_HALF_UP,
                ),
            ),
        )
    )


class ExecutionModelsTest(unittest.TestCase):
    def execute(self, scenario: ExecutionScenario, *, candidate=None, order=None, **config):
        data = candidate or dataset()
        order = order or intent()
        market = market_from_view(data.as_of(order.decision_time, MARKET_ID))
        return ExecutionModel(
            ExecutionConfig(scenario=scenario, **config),
            fee_model=fees(),
            acceptance_policy=DatasetAcceptancePolicy(),
        ).execute(data, market, order)

    def test_debug_touch_buy_uses_ask_and_sell_uses_bid_not_mid(self) -> None:
        buy = self.execute(ExecutionScenario.DEBUG_TOUCH)
        sell = self.execute(
            ExecutionScenario.DEBUG_TOUCH,
            order=intent(side=Side.SELL, quantity="1", limit_price="0.1"),
        )
        self.assertEqual(buy.vwap, Decimal("0.52"))
        self.assertEqual(sell.vwap, Decimal("0.48"))
        self.assertEqual(buy.assumption_label, "NON_REALISTIC_DEBUG_TOUCH")

    def test_taker_touch_charges_explicit_fee(self) -> None:
        outcome = self.execute(ExecutionScenario.TAKER_TOUCH_WITH_FEES)
        self.assertEqual(outcome.filled_quantity, Decimal("2"))
        self.assertEqual(outcome.fee, Decimal("0.0104"))
        self.assertTrue(outcome.fee_verified)

    def test_latency_uses_first_new_book_after_deadline(self) -> None:
        records = base_records()
        records.append(
            record(
                RecordType.CLOB_BOOK_STATE,
                "up-book-later",
                START + timedelta(milliseconds=200),
                {
                    "bids": [{"price": "0.58", "size": "10"}],
                    "asks": [{"price": "0.62", "size": "10"}],
                    "snapshot_received": True,
                    "provider_timestamp_raw": None,
                },
                index=20,
                asset_id=UP_TOKEN,
            )
        )
        data = PointInTimeDataset(records, stale_after=timedelta(seconds=1), dataset_hash="b" * 64)
        outcome = self.execute(
            ExecutionScenario.LATENCY,
            candidate=data,
            latency=timedelta(milliseconds=50),
        )
        self.assertEqual(outcome.executable_time, START + timedelta(milliseconds=200))
        self.assertEqual(outcome.vwap, Decimal("0.62"))

    def test_latency_without_new_book_is_no_fill(self) -> None:
        outcome = self.execute(
            ExecutionScenario.LATENCY,
            latency=timedelta(milliseconds=50),
        )
        self.assertEqual(outcome.filled_quantity, Decimal("0"))
        self.assertEqual(outcome.no_fill_reason, NoFillReason.NO_NEW_BOOK)

    def test_depth_walks_levels_and_computes_vwap(self) -> None:
        data = dataset(up_asks=(("0.51", "1"), ("0.53", "2")))
        outcome = self.execute(
            ExecutionScenario.DEPTH_AND_PARTIAL_FILL,
            candidate=data,
            order=intent(quantity="3"),
        )
        self.assertEqual([fill.price for fill in outcome.fills], [Decimal("0.51"), Decimal("0.53")])
        self.assertEqual(outcome.vwap, Decimal("0.5233333333333333333333333333"))
        self.assertEqual(outcome.unfilled_quantity, Decimal("0"))

    def test_insufficient_depth_produces_only_partial_fill(self) -> None:
        outcome = self.execute(
            ExecutionScenario.DEPTH_AND_PARTIAL_FILL,
            candidate=dataset(up_asks=(("0.51", "1"),)),
            order=intent(quantity="3"),
        )
        self.assertEqual(outcome.filled_quantity, Decimal("1"))
        self.assertEqual(outcome.unfilled_quantity, Decimal("2"))
        self.assertTrue(outcome.is_partial_fill)

    def test_empty_stale_disconnected_and_reset_books_never_fill(self) -> None:
        candidates = (
            dataset(up_asks=()),
            dataset(stale_after=timedelta(milliseconds=20)),
            dataset(connection_state="DISCONNECTED"),
            dataset(connection_state="RESET_REQUIRED"),
        )
        for candidate in candidates:
            with self.subTest(candidate=candidate):
                outcome = self.execute(ExecutionScenario.TAKER_TOUCH_WITH_FEES, candidate=candidate)
                self.assertFalse(outcome.fills)

    def test_market_end_is_half_open_and_cannot_fill(self) -> None:
        outcome = self.execute(
            ExecutionScenario.DEBUG_TOUCH,
            order=intent(decision_time=END),
        )
        self.assertFalse(outcome.fills)
        self.assertEqual(outcome.no_fill_reason, NoFillReason.MARKET_CLOSED)

    def test_missing_historical_fee_never_claims_verified_net(self) -> None:
        charge = FeeModel(
            FeeSchedule(version="unknown", historical_verified=False, rates=())
        ).charge(
            market_id=MARKET_ID,
            executable_time=START,
            liquidity_role=LiquidityRole.TAKER,
            price=Decimal("0.5"),
            quantity=Decimal("1"),
        )
        self.assertEqual(charge.amount, Decimal("0"))
        self.assertFalse(charge.verified)
        self.assertEqual(charge.reason_code, "UNKNOWN_FEE")

    def test_fee_rounding_is_per_fill_and_role_is_explicit(self) -> None:
        model = FeeModel(
            FeeSchedule(
                version="rounding-v1",
                historical_verified=True,
                rates=(
                    FeeRate(
                        market_id=MARKET_ID,
                        liquidity_role=LiquidityRole.TAKER,
                        effective_from=START,
                        effective_to=END,
                        rate=Decimal("0.01"),
                        quantum=Decimal("0.01"),
                        rounding=ROUND_HALF_UP,
                    ),
                ),
            )
        )
        charge = model.charge(
            market_id=MARKET_ID,
            executable_time=START,
            liquidity_role=LiquidityRole.TAKER,
            price=Decimal("0.50"),
            quantity=Decimal("1"),
        )
        self.assertEqual(charge.amount, Decimal("0.01"))


if __name__ == "__main__":
    unittest.main()
