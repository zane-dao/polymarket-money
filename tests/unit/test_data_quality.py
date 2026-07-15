from dataclasses import replace
from hashlib import sha256
import json
from pathlib import Path
import unittest

from research.polymarket_money.data_quality import build_data_quality_report
from research.polymarket_money.raw_events import RawEventEnvelopeV1


ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "data" / "fixtures" / "batch-2" / "raw-event-v1.golden.jsonl"


class DataQualityTest(unittest.TestCase):
    def test_unknown_and_duplicate_observations_are_reported_not_deleted(self) -> None:
        event = RawEventEnvelopeV1.from_json_line(FIXTURE.read_text(encoding="utf-8").rstrip("\n"))
        duplicate_observation = replace(event, event_id="evt-golden-002")
        report = build_data_quality_report([event, duplicate_observation])
        self.assertEqual(report.total_events, 2)
        self.assertEqual(report.unknown_event_count, 2)
        self.assertEqual(report.duplicate_raw_hash_count, 1)
        self.assertEqual(report.duplicate_event_id_count, 0)
        self.assertFalse(report.segment_checksum_verified)
        self.assertFalse(report.manifest_consistent)
        self.assertEqual(report.unknown_token_evaluation, "NOT_EVALUATED")
        self.assertEqual(report.continuity, "UNVERIFIED")
        self.assertIn("not that no upstream packet was lost", report.continuity_limitation)

    def test_clob_batch_and_delta_quality_checks_use_decimal_semantics(self) -> None:
        baseline = RawEventEnvelopeV1.from_json_line(
            FIXTURE.read_text(encoding="utf-8").rstrip("\n")
        )
        batch_raw = json.dumps(
            [
                {
                    "event_type": "book",
                    "asset_id": "1",
                    "bids": [{"price": ".48", "size": "2"}],
                    "asks": [{"price": ".52", "size": "2"}],
                },
                {
                    "event_type": "book",
                    "asset_id": "2",
                    "bids": [{"price": ".60", "size": "2"}],
                    "asks": [{"price": ".55", "size": "2"}],
                },
            ],
            separators=(",", ":"),
        )
        batch = replace(
            baseline,
            event_id="clob-batch",
            source="polymarket.clob.market",
            stream="market-channel",
            event_type="clob_batch_unverified",
            parser_status="parsed",
            raw_payload=batch_raw,
            raw_sha256=sha256(batch_raw.encode()).hexdigest(),
        )
        delta_raw = json.dumps(
            {
                "event_type": "price_change",
                "price_changes": [
                    {"asset_id": "1", "price": ".49", "size": "-1", "side": "BUY"},
                    {"asset_id": "3", "price": ".49", "size": "1", "side": "BUY"},
                ],
            },
            separators=(",", ":"),
        )
        delta = replace(
            batch,
            event_id="clob-delta",
            event_type="price_change",
            raw_payload=delta_raw,
            raw_sha256=sha256(delta_raw.encode()).hexdigest(),
        )
        report = build_data_quality_report(
            [batch, delta], known_asset_ids=frozenset({"1", "2"})
        )
        self.assertEqual(report.crossed_book_count, 1)
        self.assertEqual(report.invalid_price_or_quantity_count, 1)
        self.assertEqual(report.unknown_token_count, 1)
        self.assertEqual(report.missing_initial_snapshot_count, 1)
        self.assertEqual(report.unknown_token_evaluation, "EVALUATED")


if __name__ == "__main__":
    unittest.main()
