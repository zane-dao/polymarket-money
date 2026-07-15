from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from research.polymarket_money.normalized import (
    DatasetPublicationError,
    NormalizedDatasetBuilder,
    NormalizerConfig,
    PointInTimeDataset,
)
from research.polymarket_money.raw_events import RawEventEnvelopeV1
from research.polymarket_money.replay import ManifestVerificationError, ManifestVerifier


ROOT = Path(__file__).resolve().parents[2]
GAMMA = ROOT / "data" / "fixtures" / "batch-2" / "gamma-btc-5m.json"


def utc(milliseconds: int) -> datetime:
    return datetime(2026, 7, 15, 0, 0, 0, milliseconds * 1_000, tzinfo=timezone.utc)


def raw_gamma_event(*, event_id: str = "gamma-1", receive_ms: int = 100) -> RawEventEnvelopeV1:
    payload = GAMMA.read_text(encoding="utf-8")
    return RawEventEnvelopeV1.from_mapping(
        {
            "schema_version": "raw-event-v1",
            "event_id": event_id,
            "source": "polymarket.gamma",
            "stream": "market-by-slug",
            "event_type": "market_metadata",
            "connection_id": "gamma-http-1",
            "subscription_id": "gamma-subscription-1",
            "market_id": "1822773",
            "condition_id": "0x29789033e9636c68c85f55bc4731d6ffbe8f41d37caf0df655a383b626e29c23",
            "asset_id": None,
            "source_time": None,
            "server_time": None,
            "receive_time": f"2026-07-15T00:00:00.{receive_ms:03d}Z",
            "process_time": f"2026-07-15T00:00:00.{receive_ms + 10:03d}Z",
            "persist_time": f"2026-07-15T00:00:00.{receive_ms + 20:03d}Z",
            "source_sequence": None,
            "source_hash": None,
            "raw_payload": payload,
            "raw_sha256": sha256(payload.encode("utf-8")).hexdigest(),
            "parser_status": "parsed",
            "parser_error": None,
        }
    )


def verified_gamma(root: Path, *, event: RawEventEnvelopeV1 | None = None):
    envelope = event or raw_gamma_event()
    line = json.dumps(envelope.to_mapping(), ensure_ascii=False, separators=(",", ":")) + "\n"
    raw = line.encode("utf-8")
    relative = Path("polymarket.gamma/2026-07-15/market-by-slug/segment-000.jsonl")
    segment = root / relative
    segment.parent.mkdir(parents=True)
    segment.write_bytes(raw)
    manifest = {
        "dataset_id": f"gamma-{envelope.event_id}",
        "schema_version": "dataset-manifest-v1",
        "source": "polymarket.gamma",
        "stream": "market-by-slug",
        "subscription": {
            "endpoint": "gamma-market-by-slug",
            "slug": "btc-updown-5m-1775181000",
        },
        "collector_git_commit": "a" * 40,
        "collection_start": envelope.receive_time.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "collection_end": envelope.persist_time.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "segments": [
            {
                "ordinal": 0,
                "relative_path": str(relative),
                "sha256": sha256(raw).hexdigest(),
                "byte_count": len(raw),
                "event_count": 1,
                "parse_error_count": 0,
                "unknown_event_count": 0,
                "first_receive_time": envelope.receive_time.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "last_receive_time": envelope.receive_time.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            }
        ],
        "event_count": 1,
        "parse_error_count": 0,
        "unknown_event_count": 0,
        "first_receive_time": envelope.receive_time.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "last_receive_time": envelope.receive_time.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "market_ids": ["1822773"],
        "asset_ids": [],
        "continuity": "UNVERIFIED",
        "sanitized_config": {"endpointClass": "public-read-only"},
    }
    manifest_path = root / "manifests" / f"gamma-{envelope.event_id}.manifest.json"
    manifest_path.parent.mkdir(parents=True)
    manifest_path.write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
    return ManifestVerifier.verify(manifest_path, root), manifest_path, segment


class NormalizedDatasetReplayTest(unittest.TestCase):
    def test_verified_raw_normalizes_and_reloads_offline_as_of(self) -> None:
        with TemporaryDirectory() as raw_directory, TemporaryDirectory() as output_directory:
            verified, _, _ = verified_gamma(Path(raw_directory))
            build = NormalizedDatasetBuilder.normalize_verified(
                [verified],
                dataset_id="btc-five-minute",
                normalizer_commit="b" * 40,
                config=NormalizerConfig(),
            )
            version = NormalizedDatasetBuilder.publish(build, Path(output_directory))
            restored = PointInTimeDataset.load(version)
            view = restored.as_of(utc(999), "1822773")
            self.assertEqual(view.metadata["oracle_pair"], "BTC/USD")
            self.assertEqual(
                view.token_by_outcome,
                {
                    "up": "43327618351213667646391460691177105630991180325414735346402735306929604801558",
                    "down": "239155430611845419074853127543677303617673506907031331685640059318336493355",
                },
            )
            self.assertEqual(restored.dataset_hash, build.dataset_hash)

    def test_same_input_code_and_config_have_same_hash(self) -> None:
        with TemporaryDirectory() as directory:
            verified, _, _ = verified_gamma(Path(directory))
            first = NormalizedDatasetBuilder.normalize_verified(
                [verified], "stable", "b" * 40, NormalizerConfig()
            )
            second = NormalizedDatasetBuilder.normalize_verified(
                [verified], "stable", "b" * 40, NormalizerConfig()
            )
            self.assertEqual(first.dataset_hash, second.dataset_hash)
            self.assertEqual(first.records_bytes, second.records_bytes)
            self.assertEqual(first.manifest_bytes, second.manifest_bytes)

    def test_input_code_or_config_change_creates_new_version(self) -> None:
        with TemporaryDirectory() as first_directory, TemporaryDirectory() as second_directory:
            first_verified, _, _ = verified_gamma(Path(first_directory))
            second_verified, _, _ = verified_gamma(
                Path(second_directory), event=raw_gamma_event(event_id="gamma-2", receive_ms=200)
            )
            baseline = NormalizedDatasetBuilder.normalize_verified(
                [first_verified], "stable", "b" * 40, NormalizerConfig()
            )
            changed_input = NormalizedDatasetBuilder.normalize_verified(
                [second_verified], "stable", "b" * 40, NormalizerConfig()
            )
            changed_code = NormalizedDatasetBuilder.normalize_verified(
                [first_verified], "stable", "c" * 40, NormalizerConfig()
            )
            changed_config = NormalizedDatasetBuilder.normalize_verified(
                [first_verified], "stable", "b" * 40, NormalizerConfig(book_stale_after_ms=2_000)
            )
            self.assertEqual(
                len({baseline.dataset_hash, changed_input.dataset_hash, changed_code.dataset_hash, changed_config.dataset_hash}),
                4,
            )

    def test_completed_version_cannot_be_overwritten(self) -> None:
        with TemporaryDirectory() as raw_directory, TemporaryDirectory() as output_directory:
            verified, _, _ = verified_gamma(Path(raw_directory))
            build = NormalizedDatasetBuilder.normalize_verified(
                [verified], "immutable", "b" * 40, NormalizerConfig()
            )
            NormalizedDatasetBuilder.publish(build, Path(output_directory))
            with self.assertRaisesRegex(DatasetPublicationError, "exists"):
                NormalizedDatasetBuilder.publish(build, Path(output_directory))

    def test_tampered_segment_after_verification_rejects_normalization(self) -> None:
        with TemporaryDirectory() as directory:
            verified, _, segment = verified_gamma(Path(directory))
            segment.write_text("tampered\n", encoding="utf-8")
            with self.assertRaises(ManifestVerificationError):
                NormalizedDatasetBuilder.normalize_verified(
                    [verified], "tampered", "b" * 40, NormalizerConfig()
                )

    def test_tampered_manifest_after_verification_rejects_normalization(self) -> None:
        with TemporaryDirectory() as directory:
            verified, manifest, _ = verified_gamma(Path(directory))
            value = json.loads(manifest.read_text(encoding="utf-8"))
            value["sanitized_config"]["endpointClass"] = "fixture"
            manifest.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaises(ManifestVerificationError):
                NormalizedDatasetBuilder.normalize_verified(
                    [verified], "tampered", "b" * 40, NormalizerConfig()
                )

    def test_drvfs_output_root_is_rejected_before_write(self) -> None:
        with TemporaryDirectory() as directory:
            verified, _, _ = verified_gamma(Path(directory))
            build = NormalizedDatasetBuilder.normalize_verified(
                [verified], "linux-only", "b" * 40, NormalizerConfig()
            )
            with self.assertRaisesRegex(DatasetPublicationError, "DrvFS"):
                NormalizedDatasetBuilder.publish(build, Path("/mnt/d/polymarket-data"))

    def test_published_output_tamper_is_detected_on_load(self) -> None:
        with TemporaryDirectory() as raw_directory, TemporaryDirectory() as output_directory:
            verified, _, _ = verified_gamma(Path(raw_directory))
            build = NormalizedDatasetBuilder.normalize_verified(
                [verified], "load-gate", "b" * 40, NormalizerConfig()
            )
            version = NormalizedDatasetBuilder.publish(build, Path(output_directory))
            records = version / "records.jsonl"
            records.write_bytes(records.read_bytes() + b"{}\n")
            with self.assertRaisesRegex(DatasetPublicationError, "checksum"):
                PointInTimeDataset.load(version)


if __name__ == "__main__":
    unittest.main()
