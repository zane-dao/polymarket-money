from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
import unittest

from research.polymarket_money.historical import (
    DataGateInputs,
    FeeEvidenceGrade,
    HistoricalFeeEvidence,
    HistoricalSourceContract,
    LabelEvidenceGrade,
    OfficialLabelEvidence,
    Regime,
    ResearchSplit,
    classify_regime,
    classify_split,
    evaluate_data_gate,
)


UTC = timezone.utc


class HistoricalContractsTest(unittest.TestCase):
    def test_external_source_contract_cannot_upgrade_third_party_evidence(self) -> None:
        contract = HistoricalSourceContract.required(
            revision="a" * 40,
            markets_sha256="b" * 64,
            ticks_sha256="c" * 64,
        )
        self.assertEqual(contract.source_numeric_type, "BINARY_FLOAT_SOURCE")
        self.assertEqual(contract.continuity, "UNVERIFIED")
        self.assertEqual(contract.visibility_evidence, "THIRD_PARTY_SAMPLE_TIME")
        self.assertEqual(contract.sampling_interval, timedelta(seconds=1))
        self.assertEqual(contract.depth_scope, "TOP_OF_BOOK_ONLY")
        self.assertEqual(contract.receive_time, "UNOBSERVED")
        self.assertFalse(contract.full_l2_available)

    def test_official_label_is_derived_only_from_closed_official_response(self) -> None:
        end = datetime(2026, 5, 1, 0, 5, tzinfo=UTC)
        evidence = OfficialLabelEvidence.from_gamma_market(
            expected_condition_id="0xabc",
            expected_slug="btc-updown-5m-1777593600",
            expected_start=end - timedelta(minutes=5),
            expected_end=end,
            expected_up_token="up-token",
            expected_down_token="down-token",
            fetched_at=end + timedelta(days=1),
            response_sha256="d" * 64,
            market={
                "conditionId": "0xabc",
                "slug": "btc-updown-5m-1777593600",
                "eventStartTime": "2026-05-01T00:00:00Z",
                "endDate": "2026-05-01T00:05:00Z",
                "closed": True,
                "outcomes": '["Up", "Down"]',
                "outcomePrices": '["1", "0"]',
                "clobTokenIds": '["up-token", "down-token"]',
            },
        )
        self.assertEqual(evidence.grade, LabelEvidenceGrade.OFFICIAL_RESOLUTION)
        self.assertEqual(evidence.winner, "Up")

    def test_third_party_label_is_never_admitted(self) -> None:
        evidence = OfficialLabelEvidence.third_party_comparison("Up")
        self.assertEqual(evidence.grade, LabelEvidenceGrade.THIRD_PARTY_INFERRED)
        self.assertFalse(evidence.headline_eligible)

    def test_fee_verification_requires_point_in_time_or_market_static_official(self) -> None:
        for grade, verified in (
            (FeeEvidenceGrade.POINT_IN_TIME_OFFICIAL, True),
            (FeeEvidenceGrade.MARKET_STATIC_OFFICIAL, True),
            (FeeEvidenceGrade.CHANGELOG_SUPPORTED_SCENARIO, False),
            (FeeEvidenceGrade.CURRENT_POSTHOC_ONLY, False),
            (FeeEvidenceGrade.UNKNOWN, False),
        ):
            with self.subTest(grade=grade):
                evidence = HistoricalFeeEvidence(
                    grade=grade,
                    fee_rate=Decimal("0.07"),
                    source_sha256="e" * 64,
                )
                self.assertEqual(evidence.net_pnl_verified, verified)
        charge = HistoricalFeeEvidence(
            grade=FeeEvidenceGrade.MARKET_STATIC_OFFICIAL,
            fee_rate=Decimal("0.07"),
            source_sha256="e" * 64,
        ).taker_fee_per_share(Decimal("0.50"))
        self.assertEqual(charge, Decimal("0.0175"))

    def test_regime_and_split_boundaries_are_fixed_and_half_open(self) -> None:
        self.assertEqual(
            classify_regime(datetime(2026, 4, 27, 23, 59, tzinfo=UTC)), Regime.PRE_V2
        )
        self.assertEqual(
            classify_regime(datetime(2026, 4, 28, 12, 0, tzinfo=UTC)),
            Regime.CUTOVER_EXCLUDED,
        )
        self.assertEqual(
            classify_regime(datetime(2026, 4, 29, 0, 0, tzinfo=UTC)), Regime.PRIMARY_V2
        )
        self.assertEqual(
            classify_split(datetime(2026, 5, 8, 23, 55, tzinfo=UTC)), ResearchSplit.TRAIN
        )
        self.assertEqual(
            classify_split(datetime(2026, 5, 9, 0, 0, tzinfo=UTC)), ResearchSplit.VALIDATION
        )
        self.assertEqual(
            classify_split(datetime(2026, 5, 14, 0, 0, tzinfo=UTC)), ResearchSplit.FINAL_TEST
        )

    def test_any_failed_data_gate_stops_model_training(self) -> None:
        failed = evaluate_data_gate(
            DataGateInputs(
                primary_market_count=1999,
                official_label_coverage=Decimal("0.99"),
                identity_unique=True,
                train_test_overlap=False,
                binance_coverage=Decimal("1"),
                future_data_count=0,
                auditable_exclusions=True,
                decision_horizons=frozenset({60, 30, 15}),
            )
        )
        self.assertFalse(failed.passed)
        self.assertIn("PRIMARY_MARKETS_BELOW_2000", failed.failures)


if __name__ == "__main__":
    unittest.main()
