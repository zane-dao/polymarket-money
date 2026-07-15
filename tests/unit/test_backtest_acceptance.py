from __future__ import annotations

from dataclasses import replace
from datetime import timedelta
import unittest

from research.polymarket_money.backtest import (
    AcceptanceStatus,
    DatasetAcceptancePolicy,
)
from research.polymarket_money.normalized import BookState, PointInTimeView, QuarantineRecord
from tests.helpers.backtest_fixtures import (
    DOWN_TOKEN,
    MARKET_ID,
    START,
    UP_TOKEN,
    dataset,
    lineage,
)


class DatasetAcceptancePolicyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.policy = DatasetAcceptancePolicy()
        self.decision_time = START + timedelta(milliseconds=100)

    def test_eligible_view_preserves_unverified_continuity(self) -> None:
        assessment = self.policy.evaluate(dataset().as_of(self.decision_time, MARKET_ID))
        self.assertEqual(assessment.status, AcceptanceStatus.EXECUTION_ELIGIBLE)
        self.assertEqual(assessment.continuity, "UNVERIFIED")
        self.assertFalse(assessment.reason_codes)

    def test_unverified_cannot_be_upgraded(self) -> None:
        original = dataset().as_of(self.decision_time, MARKET_ID)
        forged = PointInTimeView(
            decision_time=original.decision_time,
            market_id=original.market_id,
            metadata=original.metadata,
            token_by_outcome=original.token_by_outcome,
            books=original.books,
            chainlink_price=original.chainlink_price,
            binance_price=original.binance_price,
            continuity="VERIFIED",
            quarantines=original.quarantines,
            active_quarantines=original.active_quarantines,
        )
        assessment = self.policy.evaluate(forged)
        self.assertEqual(assessment.status, AcceptanceStatus.EXCLUDED)
        self.assertIn("INVALID_CONTINUITY", assessment.reason_codes)

    def test_non_executable_transport_states_are_feature_only(self) -> None:
        cases = {
            "DISCONNECTED": dataset(connection_state="DISCONNECTED"),
            "WAITING_FOR_SNAPSHOT": dataset(include_down_book=False),
            "STALE": dataset(stale_after=timedelta(milliseconds=20)),
            "EMPTY_BOOK_SIDE": dataset(up_asks=()),
        }
        for reason, candidate in cases.items():
            with self.subTest(reason=reason):
                assessment = self.policy.evaluate(
                    candidate.as_of(self.decision_time, MARKET_ID)
                )
                self.assertEqual(assessment.status, AcceptanceStatus.FEATURE_ONLY)
                self.assertIn(reason, assessment.reason_codes)

    def test_reset_crossed_and_active_quarantine_are_excluded(self) -> None:
        quarantine = QuarantineRecord.create(
            reason_code="INVALID_BOOK_DELTA",
            business_key="bad-book",
            market_id=MARKET_ID,
            asset_id=UP_TOKEN,
            visible_at=START + timedelta(milliseconds=50),
            affected_record_ids=(),
            lineage=(lineage(30, START + timedelta(milliseconds=50)),),
        )
        cases = (
            dataset(connection_state="RESET_REQUIRED"),
            dataset(up_bids=(("0.60", "1"),), up_asks=(("0.50", "1"),)),
            dataset(quarantines=(quarantine,)),
        )
        for candidate in cases:
            assessment = self.policy.evaluate(candidate.as_of(self.decision_time, MARKET_ID))
            self.assertEqual(assessment.status, AcceptanceStatus.EXCLUDED)

    def test_sibling_failure_closes_both_tokens(self) -> None:
        view = dataset(up_asks=()).as_of(self.decision_time, MARKET_ID)
        self.assertEqual(set(view.books), {UP_TOKEN, DOWN_TOKEN})
        self.assertTrue(all(book.state is BookState.UNTRADEABLE for book in view.books.values()))
        self.assertTrue(all(not book.execution_eligible for book in view.books.values()))

    def test_acceptance_summary_reports_duration_and_all_reasons(self) -> None:
        summary = self.policy.summarize(dataset(), market_ids=(MARKET_ID,))
        self.assertEqual(summary.total_market_count, 1)
        self.assertEqual(summary.eligible_market_count, 1)
        self.assertEqual(summary.continuity, "UNVERIFIED")
        self.assertGreater(summary.eligible_time_coverage, 0)
        self.assertGreater(summary.stale_time_coverage, 0)
        self.assertIn("MISSING_MARKET_IDENTITY", summary.exclusion_reasons)


if __name__ == "__main__":
    unittest.main()
