from hashlib import sha256
import json
from pathlib import Path
import unittest

from research.polymarket_money.raw_events import RawEventEnvelopeV1, parse_rtds_price


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "data" / "fixtures" / "batch-2"


class RawContractTest(unittest.TestCase):
    def test_shared_fixture_is_valid_and_byte_preserving(self) -> None:
        line = (FIXTURES / "raw-event-v1.golden.jsonl").read_text(encoding="utf-8").rstrip("\n")
        envelope = RawEventEnvelopeV1.from_json_line(line)
        self.assertEqual(envelope.source_sequence, "9007199254740993")
        self.assertEqual(
            sha256(envelope.raw_payload.encode("utf-8")).hexdigest(),
            envelope.raw_sha256,
        )
        self.assertIn("vendor_extra", envelope.raw_payload)
        expected = json.loads(
            (FIXTURES / "raw-event-v1.golden.expected.json").read_text(encoding="utf-8")
        )
        raw_bytes = (FIXTURES / "raw-event-v1.golden.jsonl").read_bytes()
        self.assertEqual(sha256(raw_bytes).hexdigest(), expected["segment_sha256"])
        self.assertEqual(len(raw_bytes), expected["byte_count"])

    def test_rtds_clocks_and_decimal_lexeme_are_distinct(self) -> None:
        fixtures = json.loads((FIXTURES / "rtds-events.json").read_text(encoding="utf-8"))
        parsed = parse_rtds_price(fixtures["chainlink"], expected_source="chainlink")
        self.assertEqual(parsed.server_time.isoformat(), "2025-07-23T23:41:28.421000+00:00")
        self.assertEqual(parsed.source_time.isoformat(), "2025-07-23T23:41:28.395000+00:00")
        self.assertEqual(str(parsed.value), "67234.50")

    def test_wrong_symbol_is_quarantined_without_dropping_raw(self) -> None:
        fixtures = json.loads((FIXTURES / "rtds-events.json").read_text(encoding="utf-8"))
        parsed = parse_rtds_price(
            fixtures["wrong_chainlink_symbol"], expected_source="chainlink"
        )
        self.assertEqual(parsed.parser_status, "quarantined")
        self.assertEqual(parsed.raw_payload, fixtures["wrong_chainlink_symbol"])

    def test_non_z_and_ambiguous_times_are_rejected(self) -> None:
        mapping = json.loads(
            (FIXTURES / "raw-event-v1.golden.jsonl").read_text(encoding="utf-8")
        )
        mapping["receive_time"] = "2026-07-15T00:00:00.100+00:00"
        with self.assertRaisesRegex(ValueError, "canonical UTC"):
            RawEventEnvelopeV1.from_mapping(mapping)

    def test_invalid_calendar_and_noncanonical_time_variants_are_rejected(self) -> None:
        baseline = json.loads(
            (FIXTURES / "raw-event-v1.golden.jsonl").read_text(encoding="utf-8")
        )
        for timestamp in (
            "2026-02-30T00:00:00.100Z",
            "2026-07-15T00:00:00Z",
            "2026-07-15T00:00:00.1Z",
            "2026-07-15 00:00:00.100Z",
            "20260715T000000.100Z",
        ):
            with self.subTest(timestamp=timestamp), self.assertRaises(ValueError):
                RawEventEnvelopeV1.from_mapping(
                    {**baseline, "receive_time": timestamp}
                )

    def test_rtds_wrong_message_type_is_quarantined(self) -> None:
        fixtures = json.loads((FIXTURES / "rtds-events.json").read_text(encoding="utf-8"))
        raw = fixtures["chainlink"].replace('"type":"update"', '"type":"snapshot"')
        parsed = parse_rtds_price(raw, expected_source="chainlink")
        self.assertEqual(parsed.parser_status, "quarantined")


if __name__ == "__main__":
    unittest.main()
