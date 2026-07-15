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
    SettlementResolver,
    market_from_view,
)
from research.polymarket_money.domain import Side
from research.polymarket_money.domain import OraclePrice
from research.polymarket_money.ledger import FillLedger
from research.polymarket_money.normalized import (
    DatasetPublicationError,
    PointInTimeDataset,
    QuarantineRecord,
    RecordType,
)
from research.polymarket_money.rules import settlement_from_oracle
from tests.helpers.backtest_fixtures import (
    END,
    MARKET_ID,
    START,
    UP_TOKEN,
    base_records,
    dataset,
    intent,
    lineage,
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
        self.assertEqual([fill.fee for fill in outcome.fills], [Decimal("0.0051"), Decimal("0.0106")])

    def test_insufficient_depth_produces_only_partial_fill(self) -> None:
        outcome = self.execute(
            ExecutionScenario.DEPTH_AND_PARTIAL_FILL,
            candidate=dataset(up_asks=(("0.51", "1"),)),
            order=intent(quantity="3"),
        )
        self.assertEqual(outcome.filled_quantity, Decimal("1"))
        self.assertEqual(outcome.unfilled_quantity, Decimal("2"))
        self.assertTrue(outcome.is_partial_fill)
        self.assertEqual(outcome.no_fill_reason, NoFillReason.INSUFFICIENT_DEPTH)

    def test_fee_rounding_is_applied_to_each_depth_fill(self) -> None:
        data = dataset(up_asks=(("0.50", "1"), ("0.51", "1")))
        outcome = ExecutionModel(
            ExecutionConfig(ExecutionScenario.DEPTH_AND_PARTIAL_FILL),
            fee_model=FeeModel(
                FeeSchedule(
                    "per-fill-rounding",
                    True,
                    (
                        FeeRate(
                            MARKET_ID,
                            LiquidityRole.TAKER,
                            START,
                            END,
                            Decimal("0.01"),
                            Decimal("0.01"),
                            ROUND_HALF_UP,
                        ),
                    ),
                )
            ),
            acceptance_policy=DatasetAcceptancePolicy(),
        ).execute(
            data,
            market_from_view(data.as_of(START + timedelta(milliseconds=100), MARKET_ID)),
            intent(quantity="2"),
        )
        self.assertEqual([fill.fee for fill in outcome.fills], [Decimal("0.01"), Decimal("0.01")])
        self.assertEqual(outcome.fee, Decimal("0.02"))

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

    def test_settlement_rejects_early_or_quarantined_chainlink_boundary(self) -> None:
        records = base_records()
        close = records[-1]
        quarantine_time = END + timedelta(milliseconds=40)
        quarantine = QuarantineRecord.create(
            reason_code="CONFLICTING_BUSINESS_KEY",
            business_key=close.business_key,
            market_id=MARKET_ID,
            asset_id=None,
            visible_at=quarantine_time,
            affected_record_ids=(close.record_id,),
            lineage=(lineage(99, quarantine_time),),
        )
        data = PointInTimeDataset(
            records,
            quarantines=(quarantine,),
            dataset_hash="c" * 64,
        )
        market = market_from_view(data.as_of(START + timedelta(milliseconds=100), MARKET_ID))
        with self.assertRaisesRegex(ValueError, "interval_end"):
            SettlementResolver().resolve(
                data, market, settlement_time=END - timedelta(milliseconds=1)
            )
        with self.assertRaises(DatasetPublicationError):
            SettlementResolver().resolve(
                data, market, settlement_time=END + timedelta(milliseconds=100)
            )

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

    def test_fee_can_turn_positive_gross_pnl_negative(self) -> None:
        data = dataset(up_bids=(("0.98", "10"),), up_asks=(("0.99", "10"),))
        order = intent(quantity="1", limit_price="0.99")
        market = market_from_view(data.as_of(order.decision_time, MARKET_ID))
        outcome = ExecutionModel(
            ExecutionConfig(ExecutionScenario.TAKER_TOUCH_WITH_FEES),
            fee_model=fees(rate="0.02"),
            acceptance_policy=DatasetAcceptancePolicy(),
        ).execute(data, market, order)
        ledger = FillLedger()
        ledger.apply_fill(outcome.fills[0])
        opening = OraclePrice(
            market_id=MARKET_ID,
            pair="BTC/USD",
            provider="Chainlink",
            price=Decimal("60000"),
            source_time=START,
            server_time=None,
            receive_time=START + timedelta(milliseconds=10),
        )
        closing = OraclePrice(
            market_id=MARKET_ID,
            pair="BTC/USD",
            provider="Chainlink",
            price=Decimal("60001"),
            source_time=END,
            server_time=None,
            receive_time=END + timedelta(milliseconds=10),
        )
        pnl = ledger.apply_settlement(
            settlement_from_oracle(
                settlement_id="fee-negative-settlement",
                market=market,
                opening=opening,
                closing=closing,
                settlement_time=END + timedelta(milliseconds=20),
            )
        ).pnl
        self.assertEqual(pnl.gross_pnl, Decimal("0.01"))
        self.assertEqual(pnl.fees, Decimal("0.0198"))
        self.assertEqual(pnl.net_pnl, Decimal("-0.0098"))

    def test_adverse_ticks_only_worsen_price_and_respect_limit(self) -> None:
        worsened = self.execute(
            ExecutionScenario.DEPTH_AND_PARTIAL_FILL,
            adverse_ticks=2,
            tick_size=Decimal("0.01"),
        )
        rejected = self.execute(
            ExecutionScenario.DEPTH_AND_PARTIAL_FILL,
            order=intent(limit_price="0.53"),
            adverse_ticks=2,
            tick_size=Decimal("0.01"),
        )
        self.assertEqual(worsened.vwap, Decimal("0.54"))
        self.assertFalse(rejected.fills)

    def test_overlapping_fee_intervals_fail_closed(self) -> None:
        row = FeeRate(
            market_id=MARKET_ID,
            liquidity_role=LiquidityRole.TAKER,
            effective_from=START,
            effective_to=END,
            rate=Decimal("0.01"),
            quantum=Decimal("0.01"),
            rounding=ROUND_HALF_UP,
        )
        with self.assertRaisesRegex(ValueError, "overlapping"):
            FeeSchedule(version="overlap", historical_verified=True, rates=(row, row))

    def test_maker_taker_and_no_fee_roles_are_not_interchangeable(self) -> None:
        rows = tuple(
            FeeRate(
                market_id=MARKET_ID,
                liquidity_role=role,
                effective_from=START,
                effective_to=END,
                rate=rate,
                quantum=Decimal("0.0001"),
                rounding=ROUND_HALF_UP,
            )
            for role, rate in (
                (LiquidityRole.MAKER, Decimal("0.005")),
                (LiquidityRole.TAKER, Decimal("0.01")),
                (LiquidityRole.NO_FEE, Decimal("0")),
            )
        )
        model = FeeModel(FeeSchedule("roles-v1", True, rows))
        amounts = {
            role: model.charge(
                market_id=MARKET_ID,
                executable_time=START,
                liquidity_role=role,
                price=Decimal("0.5"),
                quantity=Decimal("10"),
            ).amount
            for role in LiquidityRole
        }
        self.assertEqual(
            amounts,
            {
                LiquidityRole.MAKER: Decimal("0.0250"),
                LiquidityRole.TAKER: Decimal("0.0500"),
                LiquidityRole.NO_FEE: Decimal("0.0000"),
            },
        )


if __name__ == "__main__":
    unittest.main()
