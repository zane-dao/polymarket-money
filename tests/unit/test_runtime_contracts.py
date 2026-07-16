from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from research.polymarket_money.runtime import (
    MAX_LOCAL_RAW_BYTES,
    MAX_LOCAL_RAW_SECONDS,
    MIN_FREE_BYTES,
    PaperRuntimeGuard,
    RawCapturePolicy,
    RecordMode,
    ReplayPacer,
    ReplaySpeed,
    StoragePolicyError,
    inventory_directory,
)


class RuntimeContractsTest(unittest.TestCase):
    def test_raw_capture_is_explicit_bounded_and_linux_native(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            policy = RawCapturePolicy.create(
                mode=RecordMode.RAW,
                duration_seconds=MAX_LOCAL_RAW_SECONDS,
                max_bytes=MAX_LOCAL_RAW_BYTES,
                output_path=root,
                free_bytes=MIN_FREE_BYTES + MAX_LOCAL_RAW_BYTES,
                filesystem_type="ext4",
            )
            self.assertEqual(policy.max_bytes, 2 * 1024**3)
            with self.assertRaises(StoragePolicyError):
                RawCapturePolicy.create(
                    mode=RecordMode.RAW,
                    duration_seconds=MAX_LOCAL_RAW_SECONDS + 1,
                    max_bytes=MAX_LOCAL_RAW_BYTES,
                    output_path=root,
                    free_bytes=MIN_FREE_BYTES + MAX_LOCAL_RAW_BYTES,
                    filesystem_type="ext4",
                )
            with self.assertRaises(StoragePolicyError):
                RawCapturePolicy.create(
                    mode=RecordMode.RAW,
                    duration_seconds=60,
                    max_bytes=MAX_LOCAL_RAW_BYTES,
                    output_path=Path("/mnt/d/capture"),
                    free_bytes=100 * 1024**3,
                    filesystem_type="9p",
                )

    def test_raw_capture_stops_when_safety_reserve_would_be_crossed(self) -> None:
        with TemporaryDirectory() as directory:
            with self.assertRaises(StoragePolicyError):
                RawCapturePolicy.create(
                    mode=RecordMode.RAW,
                    duration_seconds=60,
                    max_bytes=1024**3,
                    output_path=Path(directory),
                    free_bytes=MIN_FREE_BYTES + 1024**3 - 1,
                    filesystem_type="ext4",
                )

    def test_metrics_and_none_cannot_be_misread_as_raw(self) -> None:
        self.assertFalse(RawCapturePolicy.for_non_raw(RecordMode.NONE).writes_anything)
        metrics = RawCapturePolicy.for_non_raw(RecordMode.METRICS)
        self.assertTrue(metrics.writes_anything)
        self.assertFalse(metrics.writes_raw)

    def test_inventory_is_read_only_and_uses_partial_fingerprints(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "ticks.jsonl"
            source.write_text('{"t":"2026-07-01T00:00:00Z","p":"1"}\n', encoding="utf-8")
            before = source.stat()
            report = inventory_directory(root)
            after = source.stat()
            self.assertEqual(report.file_count, 1)
            self.assertEqual(report.formats["jsonl"], 1)
            self.assertEqual(before.st_mtime_ns, after.st_mtime_ns)
            self.assertEqual(before.st_size, after.st_size)
            self.assertEqual(report.files[0].hash_kind, "PARTIAL_FINGERPRINT_NOT_SHA256")

    def test_inventory_never_reads_browser_or_credential_path_contents(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            sensitive = root / "tmp" / "edge-prof" / "Default" / "Network" / "Cookies"
            sensitive.parent.mkdir(parents=True)
            sensitive.write_text("must-not-be-read", encoding="utf-8")
            with patch(
                "research.polymarket_money.runtime._partial_fingerprint",
                side_effect=AssertionError("sensitive content was read"),
            ):
                report = inventory_directory(root)
            self.assertEqual(report.files[0].classification, "SENSITIVE_METADATA_ONLY")
            self.assertEqual(report.files[0].hash_kind, "NOT_HASHED_SENSITIVE_PATH")
            self.assertEqual(report.files[0].partial_fingerprint, "NOT_READ_SENSITIVE_PATH")
            self.assertEqual(report.files[0].sample_error, "SKIPPED_SENSITIVE_PATH")

    def test_inventory_does_not_follow_file_symlinks(self) -> None:
        with TemporaryDirectory() as directory, TemporaryDirectory() as outside:
            root = Path(directory)
            target = Path(outside) / "outside.json"
            target.write_text('{"secret":"must-not-be-read"}', encoding="utf-8")
            (root / "linked.json").symlink_to(target)
            with patch(
                "research.polymarket_money.runtime._partial_fingerprint",
                side_effect=AssertionError("symlink target was read"),
            ):
                report = inventory_directory(root)
            self.assertEqual(report.file_count, 0)

    def test_replay_pacer_is_controller_not_a_second_engine(self) -> None:
        sleeps: list[float] = []
        pacer = ReplayPacer(ReplaySpeed.TEN_X, sleep=sleeps.append)
        pacer.wait_between(10.0)
        self.assertEqual(sleeps, [1.0])
        pacer.pause()
        self.assertTrue(pacer.paused)
        pacer.resume()
        self.assertFalse(pacer.paused)

    def test_paper_runtime_has_no_live_client_factory(self) -> None:
        with self.assertRaises(RuntimeError):
            PaperRuntimeGuard.create_live_client()


if __name__ == "__main__":
    unittest.main()
