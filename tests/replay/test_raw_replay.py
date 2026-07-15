from hashlib import sha256
from dataclasses import replace
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from research.polymarket_money.replay import (
    ManifestVerificationError,
    ManifestVerifier,
    RawReplay,
    VerifiedDataset,
)
from research.polymarket_money.raw_events import RawEventEnvelopeV1
from research.polymarket_money.data_quality import build_verified_data_quality_report


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "data" / "fixtures" / "batch-2"


class RawReplayTest(unittest.TestCase):
    def _dataset(
        self,
        root: Path,
        events=None,
        *,
        source: str = "fixture.cross-language",
        stream: str = "unknown-events",
        subscription=None,
        sanitized_config=None,
    ) -> Path:
        segment = (
            root
            / source
            / "2026-07-15"
            / stream
            / "segment.jsonl"
        )
        segment.parent.mkdir(parents=True)
        if events is None:
            data = (FIXTURES / "raw-event-v1.golden.jsonl").read_bytes()
        else:
            data = b"".join(
                (json.dumps(event.to_mapping(), ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
                for event in events
            )
        segment.write_bytes(data)
        envelopes = [json.loads(line) for line in data.splitlines()]
        receive_times = sorted(item["receive_time"] for item in envelopes)
        persist_times = sorted(item["persist_time"] for item in envelopes)
        error_count = sum(item["parser_status"] == "error" for item in envelopes)
        unknown_count = sum(item["parser_status"] == "unparsed" for item in envelopes)
        manifest = {
            "dataset_id": "dataset-fixture",
            "schema_version": "dataset-manifest-v1",
            "source": source,
            "stream": stream,
            "subscription": subscription or {"topic": "public-fixture"},
            "collector_git_commit": "a" * 40,
            "collection_start": receive_times[0],
            "collection_end": persist_times[-1],
            "segments": [{
                "ordinal": 0,
                "relative_path": str(segment.relative_to(root)),
                "sha256": sha256(data).hexdigest(),
                "byte_count": len(data),
                "event_count": len(envelopes),
                "parse_error_count": error_count,
                "unknown_event_count": unknown_count,
                "first_receive_time": receive_times[0],
                "last_receive_time": receive_times[-1],
            }],
            "event_count": len(envelopes),
            "parse_error_count": error_count,
            "unknown_event_count": unknown_count,
            "first_receive_time": receive_times[0],
            "last_receive_time": receive_times[-1],
            "market_ids": [],
            "asset_ids": [],
            "continuity": "UNVERIFIED",
            "sanitized_config": sanitized_config or {"endpointClass": "fixture"},
        }
        manifest_path = root / "manifests" / "dataset-fixture.manifest.json"
        manifest_path.parent.mkdir()
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        return manifest_path

    def test_verified_manifest_replays_unknown_raw_event(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            verified = ManifestVerifier.verify(self._dataset(root), root)
            events = list(RawReplay.iter_raw(verified))
            self.assertEqual([event.event_id for event in events], ["evt-golden-001"])
            self.assertEqual(events[0].parser_status, "unparsed")
            quality = build_verified_data_quality_report(verified)
            self.assertTrue(quality.segment_checksum_verified)
            self.assertTrue(quality.manifest_consistent)
            self.assertEqual(quality.verified_dataset_id, "dataset-fixture")

    def test_wrong_hash_yields_no_verified_dataset(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = self._dataset(root)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["segments"][0]["sha256"] = "0" * 64
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaises(ManifestVerificationError):
                ManifestVerifier.verify(manifest_path, root)

    def test_partial_files_are_identified_but_never_replayed(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            partial = root / "source" / "2026-07-15" / "stream" / "x.jsonl.partial"
            partial.parent.mkdir(parents=True)
            partial.write_text("torn", encoding="utf-8")
            report = ManifestVerifier.scan_recovery(root)
            self.assertEqual(report.partial_incomplete, (partial,))

    def test_duplicate_event_id_enters_effective_stream_once(self) -> None:
        original = RawEventEnvelopeV1.from_json_line(
            (FIXTURES / "raw-event-v1.golden.jsonl").read_text(encoding="utf-8").rstrip("\n")
        )
        parsed = replace(original, parser_status="parsed")
        with TemporaryDirectory() as directory:
            root = Path(directory)
            verified = ManifestVerifier.verify(self._dataset(root, [parsed, parsed]), root)
            self.assertEqual(len(list(RawReplay.iter_raw(verified))), 2)
            self.assertEqual(len(list(RawReplay.iter_effective(verified))), 1)

    def test_parse_error_is_preserved_in_raw_and_routed_to_quarantine(self) -> None:
        original = RawEventEnvelopeV1.from_json_line(
            (FIXTURES / "raw-event-v1.golden.jsonl").read_text(encoding="utf-8").rstrip("\n")
        )
        failed = replace(original, parser_status="error", parser_error="fixture parse failure")
        with TemporaryDirectory() as directory:
            root = Path(directory)
            verified = ManifestVerifier.verify(self._dataset(root, [failed]), root)
            self.assertEqual(len(list(RawReplay.iter_raw(verified))), 1)
            self.assertEqual(len(list(RawReplay.iter_effective(verified))), 0)
            self.assertEqual(len(list(RawReplay.iter_quarantine(verified))), 1)

    def test_manifest_path_traversal_is_rejected(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = self._dataset(root)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["segments"][0]["relative_path"] = "../outside.jsonl"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaises(ManifestVerificationError):
                ManifestVerifier.verify(manifest_path, root)

    def test_partial_manifest_is_never_a_commit_record(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = self._dataset(root)
            partial = manifest_path.with_suffix(manifest_path.suffix + ".partial")
            manifest_path.rename(partial)
            with self.assertRaisesRegex(ManifestVerificationError, "final"):
                ManifestVerifier.verify(partial, root)

    def test_duplicate_segment_reference_and_unknown_manifest_field_are_rejected(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = self._dataset(root)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            duplicate = {**manifest["segments"][0], "ordinal": 1}
            manifest["segments"].append(duplicate)
            manifest["event_count"] *= 2
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(ManifestVerificationError, "repeats"):
                ManifestVerifier.verify(manifest_path, root)

            manifest_path = self._dataset(Path(directory) / "second")
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["surprise"] = True
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(ManifestVerificationError, "unknown"):
                ManifestVerifier.verify(manifest_path, Path(directory) / "second")

    def test_verified_replay_uses_the_bytes_that_were_verified(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = self._dataset(root)
            verified = ManifestVerifier.verify(manifest_path, root)
            segment_path = root / verified.segments[0].relative_path
            segment_path.write_text("tampered\n", encoding="utf-8")
            events = list(RawReplay.iter_raw(verified))
            self.assertEqual([event.event_id for event in events], ["evt-golden-001"])
            with self.assertRaises(ManifestVerificationError):
                ManifestVerifier.verify(manifest_path, root)

    def test_verified_dataset_cannot_be_directly_forged(self) -> None:
        with TemporaryDirectory() as directory:
            with self.assertRaises(ManifestVerificationError):
                VerifiedDataset(
                    dataset_id="forged",
                    root=Path(directory),
                    segments=(),
                    market_ids=frozenset(),
                    asset_ids=frozenset(),
                    _proof=object(),
                )

    def test_symlink_segment_is_rejected(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = self._dataset(root)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            segment = root / manifest["segments"][0]["relative_path"]
            target = root / "real-segment.jsonl"
            segment.rename(target)
            segment.symlink_to(target)
            with self.assertRaisesRegex(ManifestVerificationError, "symlink"):
                ManifestVerifier.verify(manifest_path, root)

    def test_manifest_metadata_ids_are_recomputed(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = self._dataset(root)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["asset_ids"] = ["fabricated-token"]
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(ManifestVerificationError, "asset_ids"):
                ManifestVerifier.verify(manifest_path, root)

    def test_receive_range_uses_minimum_and_maximum_not_line_order(self) -> None:
        original = RawEventEnvelopeV1.from_json_line(
            (FIXTURES / "raw-event-v1.golden.jsonl").read_text(encoding="utf-8").rstrip("\n")
        )
        later = replace(
            original,
            event_id="later",
            receive_time=original.receive_time.replace(microsecond=150_000),
            process_time=original.process_time.replace(microsecond=250_000),
            persist_time=original.persist_time.replace(microsecond=350_000),
        )
        earlier = replace(original, event_id="earlier")
        with TemporaryDirectory() as directory:
            root = Path(directory)
            verified = ManifestVerifier.verify(self._dataset(root, [later, earlier]), root)
            self.assertEqual(len(list(RawReplay.iter_raw(verified))), 2)

    def test_conflicting_duplicate_event_id_is_rejected_regardless_of_status(self) -> None:
        original = RawEventEnvelopeV1.from_json_line(
            (FIXTURES / "raw-event-v1.golden.jsonl").read_text(encoding="utf-8").rstrip("\n")
        )
        parsed = replace(original, parser_status="parsed")
        with TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ManifestVerificationError, "conflicting"):
                ManifestVerifier.verify(self._dataset(root, [original, parsed]), root)

    def test_binance_manifest_requires_an_allowlisted_transport_and_btc_filter(self) -> None:
        original = RawEventEnvelopeV1.from_json_line(
            (FIXTURES / "raw-event-v1.golden.jsonl").read_text(encoding="utf-8").rstrip("\n")
        )
        event = replace(
            original,
            source="polymarket.rtds.binance",
            stream="crypto-prices",
        )
        subscription = {
            "action": "subscribe",
            "subscriptions": [{
                "topic": "crypto_prices",
                "type": "update",
                "filters": "btcusdt",
            }],
        }
        with TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = self._dataset(
                root,
                [event],
                source="polymarket.rtds.binance",
                stream="crypto-prices",
                subscription=subscription,
                sanitized_config={
                    "endpointClass": "public-read-only",
                    "symbolFilter": "btcusdt",
                    "transportScope": "btc-only",
                },
            )
            verified = ManifestVerifier.verify(manifest_path, root)
            self.assertEqual(verified.dataset_id, "dataset-fixture")

            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["subscription"]["subscriptions"][0]["filters"] = (
                "solusdt,btcusdt,ethusdt"
            )
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(ManifestVerificationError, "declared source"):
                ManifestVerifier.verify(manifest_path, root)

        with TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_path = self._dataset(
                root,
                [event],
                source="polymarket.rtds.binance",
                stream="crypto-prices",
                subscription={
                    "action": "subscribe",
                    "subscriptions": [{
                        "topic": "crypto_prices",
                        "type": "update",
                    }],
                },
                sanitized_config={
                    "endpointClass": "public-read-only",
                    "symbolFilter": "btcusdt",
                    "transportScope": "all-symbols-quarantine",
                },
            )
            self.assertEqual(
                ManifestVerifier.verify(manifest_path, root).dataset_id,
                "dataset-fixture",
            )
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["sanitized_config"]["transportScope"] = "btc-only"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(ManifestVerificationError, "transport scope"):
                ManifestVerifier.verify(manifest_path, root)


if __name__ == "__main__":
    unittest.main()
