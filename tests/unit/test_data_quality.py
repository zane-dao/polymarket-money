from dataclasses import replace
from hashlib import sha256
import json
from pathlib import Path
import unittest

from research.polymarket_money.data_quality import build_data_quality_report
from research.polymarket_money.raw_events import RawEventEnvelopeV1, RawEventEnvelopeV2


ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "data" / "fixtures" / "batch-2" / "raw-event-v1.golden.jsonl"


class DataQualityTest(unittest.TestCase):
    def test_v2_provider_clock_deltas_are_not_labeled_receive_latency(self) -> None:
        raw = "{}"
        event = RawEventEnvelopeV2.from_mapping(
            {
                "schema_version": "raw-event-v2",
                "event_id": "v2-delta",
                "source": "fixture.clock",
                "stream": "clock",
                "event_type": "clock",
                "transport_connection_id": "connection-1",
                "subscription_id": "subscription-1",
                "market_id": None,
                "condition_id": None,
                "asset_id": None,
                "provider_source_time": "2026-07-15T00:00:00.090Z",
                "provider_server_time": "2026-07-15T00:00:00.095Z",
                "local_wall_receive_time": "2026-07-15T00:00:00.100Z",
                "local_monotonic_receive_ns": "100000000",
                "local_receive_ordinal": "1",
                "clock_domain": "process-1",
                "process_time": "2026-07-15T00:00:00.110Z",
                "persist_time": "2026-07-15T00:00:00.120Z",
                "source_sequence": None,
                "source_hash": None,
                "raw_payload": raw,
                "raw_sha256": sha256(raw.encode()).hexdigest(),
                "parser_status": "parsed",
                "parser_error": None,
            }
        )
        mapping = build_data_quality_report([event]).to_mapping()
        self.assertEqual(
            mapping["provider_source_to_local_wall_delta_ms"],
            {"min": 10, "p50": 10, "p95": 10, "max": 10},
        )
        self.assertEqual(
            mapping["provider_server_to_local_wall_delta_ms"],
            {"min": 5, "p50": 5, "p95": 5, "max": 5},
        )
        self.assertNotIn("source_receive_latency_ms", mapping)
        self.assertNotIn("server_receive_latency_ms", mapping)

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
