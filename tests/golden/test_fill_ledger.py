from datetime import datetime, timedelta, timezone
from decimal import Decimal
import json
from pathlib import Path
import unittest

from research.polymarket_money.domain import (
    Fill,
    Market,
    OracleDefinition,
    OraclePrice,
    Outcome,
    OutcomeToken,
    Settlement,
    Side,
)
from research.polymarket_money.ledger import FillLedger
from research.polymarket_money.rules import settlement_from_oracle


UTC = timezone.utc
BASE = datetime(2026, 7, 15, 12, 0, tzinfo=UTC)


def make_fill(
    *,
    fill_id: str,
    market_id: str = "market-1",
    token_id: str = "up-token",
    side: Side = Side.BUY,
    price: str = "0.50",
    quantity: str = "10",
    fee: str = "0.10",
) -> Fill:
    return Fill(
        fill_id=fill_id,
        order_intent_id=f"intent-{fill_id}",
        market_id=market_id,
        token_id=token_id,
        side=side,
        price=Decimal(price),
        quantity=Decimal(quantity),
        fee=Decimal(fee),
        fill_time=BASE + timedelta(seconds=10),
        receive_time=BASE + timedelta(seconds=10, milliseconds=20),
    )


def make_settlement(
    *,
    settlement_id: str = "settlement-1",
    market_id: str = "market-1",
    winning_outcome: Outcome = Outcome.UP,
    winning_token_id: str = "up-token",
) -> Settlement:
    market = Market(
        market_id=market_id,
        condition_id=f"condition-{market_id}",
        slug=f"btc-updown-5m-{int(BASE.timestamp())}",
        interval_start=BASE,
        interval_end=BASE + timedelta(minutes=5),
        oracle=OracleDefinition(provider="Chainlink", pair="BTC/USD"),
        outcome_tokens=(
            OutcomeToken(token_id="up-token", market_id=market_id, outcome=Outcome.UP),
            OutcomeToken(token_id="down-token", market_id=market_id, outcome=Outcome.DOWN),
        ),
    )
    opening = OraclePrice(
        market_id=market_id,
        pair="BTC/USD",
        provider="Chainlink",
        price=Decimal("60000"),
        source_time=market.interval_start,
        server_time=market.interval_start + timedelta(milliseconds=10),
        receive_time=market.interval_start + timedelta(milliseconds=30),
    )
    closing = OraclePrice(
        market_id=market_id,
        pair="BTC/USD",
        provider="Chainlink",
        price=Decimal("60001") if winning_outcome is Outcome.UP else Decimal("59999"),
        source_time=market.interval_end,
        server_time=market.interval_end + timedelta(milliseconds=10),
        receive_time=market.interval_end + timedelta(milliseconds=30),
    )
    settlement = settlement_from_oracle(
        settlement_id=settlement_id,
        market=market,
        opening=opening,
        closing=closing,
        settlement_time=BASE + timedelta(minutes=6),
    )
    if settlement.winning_token_id != winning_token_id:
        raise AssertionError("test fixture winning token contradicts derived settlement")
    return settlement


class FillLedgerGoldenTest(unittest.TestCase):
    def test_fee_adjusted_pnl_is_exact(self) -> None:
        ledger = FillLedger()
        ledger.apply_fill(make_fill(fill_id="fill-1", price="0.55", quantity="10", fee="0.10"))

        result = ledger.apply_settlement(make_settlement())

        self.assertTrue(result.applied)
        self.assertEqual(result.pnl.gross_pnl, Decimal("4.50"))
        self.assertEqual(result.pnl.fees, Decimal("0.10"))
        self.assertEqual(result.pnl.net_pnl, Decimal("4.40"))

    def test_partial_fills_are_accounted_fill_by_fill(self) -> None:
        ledger = FillLedger()
        ledger.apply_fill(make_fill(fill_id="fill-1", price="0.48", quantity="4", fee="0.02"))
        ledger.apply_fill(make_fill(fill_id="fill-2", price="0.50", quantity="6", fee="0.03"))

        result = ledger.apply_settlement(make_settlement())

        self.assertEqual(result.pnl.payout, Decimal("10"))
        self.assertEqual(result.pnl.net_cash_outlay, Decimal("4.92"))
        self.assertEqual(result.pnl.net_pnl, Decimal("5.03"))

    def test_unfilled_intent_does_not_create_a_position(self) -> None:
        ledger = FillLedger()

        self.assertIsNone(ledger.get_position("market-1", "up-token"))

    def test_duplicate_fill_is_not_booked_twice(self) -> None:
        ledger = FillLedger()
        fill = make_fill(fill_id="fill-1")

        self.assertTrue(ledger.apply_fill(fill))
        self.assertFalse(ledger.apply_fill(fill))
        self.assertEqual(
            ledger.get_position("market-1", "up-token").quantity,
            Decimal("10"),
        )

    def test_duplicate_settlement_is_not_applied_twice(self) -> None:
        ledger = FillLedger()
        ledger.apply_fill(make_fill(fill_id="fill-1"))
        settlement = make_settlement()

        first = ledger.apply_settlement(settlement)
        second = ledger.apply_settlement(settlement)

        self.assertTrue(first.applied)
        self.assertFalse(second.applied)
        self.assertEqual(second.pnl, first.pnl)

    def test_three_manual_markets_match_hand_calculated_pnl(self) -> None:
        fixture_path = Path(__file__).resolve().parents[2] / "data/golden/batch-1/manual-markets.json"
        cases = json.loads(fixture_path.read_text(encoding="utf-8"))

        for case in cases:
            with self.subTest(case=case["case_id"]):
                ledger = FillLedger()
                for raw_fill in case["fills"]:
                    ledger.apply_fill(
                        make_fill(
                            fill_id=raw_fill["fill_id"],
                            market_id=case["market_id"],
                            token_id=raw_fill["token_id"],
                            side=Side(raw_fill["side"]),
                            price=raw_fill["price"],
                            quantity=raw_fill["quantity"],
                            fee=raw_fill["fee"],
                        )
                    )
                result = ledger.apply_settlement(
                    make_settlement(
                        settlement_id=f"settlement-{case['case_id']}",
                        market_id=case["market_id"],
                        winning_outcome=Outcome(case["winning_outcome"]),
                        winning_token_id=case["winning_token_id"],
                    )
                )

                self.assertEqual(result.pnl.net_pnl, Decimal(case["expected_net_pnl"]))


if __name__ == "__main__":
    unittest.main()
