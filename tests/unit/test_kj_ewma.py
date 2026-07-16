from __future__ import annotations

from datetime import datetime, timezone
import math
from pathlib import Path
from types import SimpleNamespace
from zipfile import ZIP_DEFLATED, ZipFile
import unittest

from research.polymarket_money.historical_adapter import file_sha256
from research.polymarket_money.kj_ewma import (
    EwmaArtifactError,
    EwmaVolatility,
    SIGNAL_FIDELITY,
    build_kj_ewma_artifact,
    load_kj_ewma_artifact,
)


UTC = timezone.utc


class KJEwmaTest(unittest.TestCase):
    def test_legacy_update_equation_and_five_second_phase(self) -> None:
        state = EwmaVolatility(halflife_seconds=100, sample_interval_seconds=5)
        state.update(100.0, 0)
        self.assertFalse(state.update(101.0, 4))
        self.assertTrue(state.update(101.0, 5))
        expected = abs(math.log(1.01)) / math.sqrt(5)
        self.assertAlmostEqual(state.sigma, expected)
        self.assertEqual(state.first_time, 0)
        self.assertEqual(state.sample_time, 5)

    def test_build_and_verified_load_are_content_addressed(self) -> None:
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            archives = root / "archives"
            archives.mkdir()
            name = "BTCUSDT-1s-2026-01-01.zip"
            zip_path = archives / name
            start = int(datetime(2026, 1, 1, tzinfo=UTC).timestamp())
            prices: dict[int, float] = {}
            lines: list[str] = []
            for offset in range(400):
                price = 100.0 * math.exp(0.00001 * offset)
                prices[start + offset] = price
                fields = [
                    str((start + offset) * 1_000_000),
                    f"{price:.8f}",
                    f"{price:.8f}",
                    f"{price:.8f}",
                    f"{price:.8f}",
                    "1",
                    str((start + offset + 1) * 1_000_000 - 1),
                    "1",
                    "1",
                    "1",
                    "1",
                    "0",
                ]
                lines.append(",".join(fields) + "\n")
            with ZipFile(zip_path, "w", ZIP_DEFLATED) as archive:
                archive.writestr(name.replace(".zip", ".csv"), "".join(lines))
            digest = file_sha256(zip_path)
            checksum = zip_path.with_name(name + ".CHECKSUM")
            checksum.write_text(f"{digest}  {name}\n", encoding="utf-8")
            receipt = SimpleNamespace(
                dataset_hash="d" * 64,
                manifest={
                    "binance_official_archives": [
                        {
                            "file": name,
                            "bytes": zip_path.stat().st_size,
                            "sha256": digest,
                            "checksum_file_sha256": file_sha256(checksum),
                        }
                    ]
                },
            )
            decision_second = start + 300
            source_price = f"{prices[decision_second - 1]:.8f}"
            rows = (
                {
                    "condition_id": "condition-1",
                    "horizon_seconds": 30,
                    "decision_time": datetime.fromtimestamp(
                        decision_second, UTC
                    ).isoformat().replace("+00:00", "Z"),
                    "binance": {"current_price": source_price},
                },
            )
            destination = build_kj_ewma_artifact(
                receipt,
                rows,
                archive_directory=archives,
                output_root=root / "artifacts",
            )
            artifact = load_kj_ewma_artifact(destination)
            self.assertEqual(artifact.dataset_hash, "d" * 64)
            self.assertEqual(artifact.manifest["signal_fidelity"], SIGNAL_FIDELITY)
            self.assertEqual(len(artifact.samples), 1)
            sample = artifact.samples[("condition-1", 30)]
            self.assertGreater(float(sample["j_single_sigma"]), 0)
            self.assertGreater(float(sample["k_effective_sigma"]), 0)

            (destination / "volatility_samples.jsonl").write_text("tampered\n")
            with self.assertRaises(EwmaArtifactError):
                load_kj_ewma_artifact(destination)


if __name__ == "__main__":
    unittest.main()
