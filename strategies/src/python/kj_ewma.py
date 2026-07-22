"""Content-addressed point-in-time EWMA artifacts for J/K paper research.

The input is the official Binance one-second kline archive already pinned by the Batch 3B
historical receipt.  The implementation reproduces the reviewed legacy EWMA update equations,
but it deliberately uses a canonical one-second-close stream.  It therefore improves historical
fidelity without claiming equivalence to the legacy live trade-tick stream or K's USD conversion.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from hashlib import sha256
import json
import math
from pathlib import Path
from typing import Any, Mapping, Sequence
from zipfile import ZipFile

from research.polymarket_money.historical_adapter import (
    HistoricalDatasetReceipt,
    canonical_json,
    file_sha256,
)


ARTIFACT_SCHEMA = "kj-ewma-artifact-v1"
SIGNAL_FIDELITY = "CANONICAL_5S_EWMA_OFFICIAL_BINANCE_1S_CLOSE"
BUILDER_CODE_SHA256 = sha256(Path(__file__).read_bytes()).hexdigest()
_LOAD_PROOF = object()


class EwmaArtifactError(ValueError):
    """The source or artifact cannot prove the declared point-in-time result."""


@dataclass(slots=True)
class EwmaVolatility:
    halflife_seconds: float
    minimum_sigma: float = 0.0
    sample_interval_seconds: float = 5.0
    variance_per_second: float | None = None
    sample_price: float | None = None
    sample_time: int | None = None
    first_time: int | None = None

    def __post_init__(self) -> None:
        if not math.isfinite(self.halflife_seconds) or self.halflife_seconds <= 0:
            raise ValueError("halflife_seconds must be positive and finite")
        if not math.isfinite(self.minimum_sigma) or self.minimum_sigma < 0:
            raise ValueError("minimum_sigma must be finite and non-negative")
        if not math.isfinite(self.sample_interval_seconds) or self.sample_interval_seconds < 0:
            raise ValueError("sample_interval_seconds must be finite and non-negative")

    def update(self, price: float, source_second: int) -> bool:
        if not math.isfinite(price) or price <= 0:
            raise ValueError("price must be positive and finite")
        if isinstance(source_second, bool) or not isinstance(source_second, int):
            raise ValueError("source_second must be an integer")
        if self.sample_price is None or self.sample_time is None:
            self.sample_price = price
            self.sample_time = source_second
            self.first_time = source_second
            return False
        elapsed = source_second - self.sample_time
        if elapsed <= 0:
            raise ValueError("source seconds must be strictly increasing")
        if elapsed < self.sample_interval_seconds:
            return False
        log_return = math.log(price / self.sample_price)
        observed_variance = log_return * log_return / elapsed
        alpha = 1.0 - 0.5 ** (elapsed / self.halflife_seconds)
        if self.variance_per_second is None:
            self.variance_per_second = observed_variance
        else:
            self.variance_per_second += alpha * (
                observed_variance - self.variance_per_second
            )
        self.sample_price = price
        self.sample_time = source_second
        return True

    @property
    def ready(self) -> bool:
        return self.variance_per_second is not None

    @property
    def sigma(self) -> float | None:
        if self.variance_per_second is None:
            return None
        return max(math.sqrt(self.variance_per_second), self.minimum_sigma)

    @property
    def elapsed_seconds(self) -> int | None:
        if self.first_time is None or self.sample_time is None:
            return None
        return self.sample_time - self.first_time


@dataclass(slots=True)
class KJDualVolatility:
    fast: EwmaVolatility
    slow: EwmaVolatility
    floor_ratio: float = 0.4
    absolute_minimum_sigma: float = 1.2e-5
    warmup_seconds: int = 180

    @classmethod
    def legacy_parameters(cls) -> "KJDualVolatility":
        return cls(
            fast=EwmaVolatility(180.0, sample_interval_seconds=5.0),
            slow=EwmaVolatility(2700.0, sample_interval_seconds=5.0),
        )

    def update(self, price: float, source_second: int) -> None:
        self.fast.update(price, source_second)
        self.slow.update(price, source_second)

    @property
    def ready(self) -> bool:
        elapsed = self.fast.elapsed_seconds
        return elapsed is not None and elapsed >= self.warmup_seconds

    @property
    def effective_sigma(self) -> float | None:
        if not self.ready or self.fast.sigma is None:
            return None
        slow_floor = 0.0 if self.slow.sigma is None else self.floor_ratio * self.slow.sigma
        return max(self.fast.sigma, slow_floor, self.absolute_minimum_sigma)


@dataclass(frozen=True, slots=True)
class KJEwmaArtifact:
    artifact_hash: str
    directory: Path
    dataset_hash: str
    samples: Mapping[tuple[str, int], Mapping[str, str]]
    manifest: Mapping[str, Any]
    _proof: object

    def __post_init__(self) -> None:
        if self._proof is not _LOAD_PROOF:
            raise EwmaArtifactError("KJEwmaArtifact must be created by verified load")


def _utc_second(value: str) -> int:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.utcoffset() != timedelta(0) or parsed.microsecond:
        raise EwmaArtifactError("decision time must be whole-second explicit UTC")
    return int(parsed.timestamp())


def _float_text(value: float | None, field: str) -> str:
    if value is None or not math.isfinite(value):
        raise EwmaArtifactError(f"{field} is unavailable or non-finite")
    return format(value, ".17g")


def _verify_archives(
    receipt: HistoricalDatasetReceipt, archive_directory: Path
) -> tuple[Mapping[str, Any], ...]:
    inventory = receipt.manifest.get("binance_official_archives")
    if not isinstance(inventory, list) or not inventory:
        raise EwmaArtifactError("historical receipt has no Binance archive inventory")
    verified: list[Mapping[str, Any]] = []
    for item in inventory:
        if not isinstance(item, dict):
            raise EwmaArtifactError("invalid Binance inventory item")
        path = archive_directory / str(item["file"])
        checksum = path.with_name(path.name + ".CHECKSUM")
        if not path.is_file() or not checksum.is_file():
            raise EwmaArtifactError(f"missing Binance archive or checksum: {path.name}")
        if path.stat().st_size != int(item["bytes"]) or file_sha256(path) != item["sha256"]:
            raise EwmaArtifactError(f"Binance archive mismatch: {path.name}")
        if file_sha256(checksum) != item["checksum_file_sha256"]:
            raise EwmaArtifactError(f"Binance checksum-file mismatch: {checksum.name}")
        declared = checksum.read_text(encoding="utf-8").split()[0]
        if declared != item["sha256"]:
            raise EwmaArtifactError(f"Binance checksum content mismatch: {checksum.name}")
        verified.append(dict(item))
    return tuple(verified)


def _archive_rows(path: Path):
    with ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != 1 or not names[0].endswith(".csv"):
            raise EwmaArtifactError(f"unexpected Binance zip inventory: {path.name}")
        with archive.open(names[0]) as stream:
            for line_number, raw in enumerate(stream, 1):
                fields = raw.decode("ascii").rstrip("\n").split(",")
                if len(fields) != 12:
                    raise EwmaArtifactError(
                        f"unexpected Binance row at {path.name}:{line_number}"
                    )
                timestamp = int(fields[0])
                if timestamp > 10**15:
                    timestamp //= 1_000_000
                elif timestamp > 10**12:
                    timestamp //= 1_000
                yield timestamp, float(fields[4])


def build_kj_ewma_artifact(
    receipt: HistoricalDatasetReceipt,
    rows: Sequence[Mapping[str, Any]],
    *,
    archive_directory: Path,
    output_root: Path,
) -> Path:
    """Build one immutable artifact and return its content-addressed directory."""
    inventory = _verify_archives(receipt, archive_directory)
    targets: dict[int, list[Mapping[str, Any]]] = {}
    expected_prices: dict[tuple[str, int], str] = {}
    for row in rows:
        target = _utc_second(str(row["decision_time"])) - 1
        targets.setdefault(target, []).append(row)
        expected_prices[(str(row["condition_id"]), int(row["horizon_seconds"]))] = str(
            row["binance"]["current_price"]
        )

    single = EwmaVolatility(100.0, minimum_sigma=2e-5, sample_interval_seconds=5.0)
    dual = KJDualVolatility.legacy_parameters()
    samples: list[dict[str, str | int]] = []
    seen_targets: set[tuple[str, int]] = set()
    previous_second: int | None = None
    gap_count = 0
    maximum_gap = 0
    source_rows = 0
    for item in inventory:
        for source_second, price in _archive_rows(archive_directory / str(item["file"])):
            if previous_second is not None:
                if source_second <= previous_second:
                    raise EwmaArtifactError("Binance archive time is not strictly increasing")
                gap = source_second - previous_second - 1
                if gap > 0:
                    gap_count += 1
                    maximum_gap = max(maximum_gap, gap)
            previous_second = source_second
            source_rows += 1
            single.update(price, source_second)
            dual.update(price, source_second)
            for row in targets.get(source_second, ()):
                key = (str(row["condition_id"]), int(row["horizon_seconds"]))
                if key in seen_targets:
                    raise EwmaArtifactError("duplicate EWMA target key")
                expected = float(expected_prices[key])
                if not math.isclose(price, expected, rel_tol=0.0, abs_tol=1e-9):
                    raise EwmaArtifactError(
                        f"source close disagrees with decision sample for {key}"
                    )
                if not dual.ready:
                    raise EwmaArtifactError(f"K dual EWMA is not warm at {key}")
                samples.append(
                    {
                        "condition_id": key[0],
                        "horizon_seconds": key[1],
                        "decision_time": str(row["decision_time"]),
                        "source_second": source_second,
                        "source_price": format(price, ".17g"),
                        "j_single_sigma": _float_text(single.sigma, "j_single_sigma"),
                        "k_fast_sigma": _float_text(dual.fast.sigma, "k_fast_sigma"),
                        "k_slow_sigma": _float_text(dual.slow.sigma, "k_slow_sigma"),
                        "k_effective_sigma": _float_text(
                            dual.effective_sigma, "k_effective_sigma"
                        ),
                    }
                )
                seen_targets.add(key)
    expected_keys = set(expected_prices)
    if seen_targets != expected_keys:
        missing = sorted(expected_keys - seen_targets)[:5]
        raise EwmaArtifactError(f"missing EWMA decision targets: {missing}")

    samples.sort(key=lambda item: (str(item["decision_time"]), str(item["condition_id"]), int(item["horizon_seconds"])))
    sample_bytes = b"".join(
        (canonical_json(item) + "\n").encode("utf-8") for item in samples
    )
    core = {
        "schema_version": ARTIFACT_SCHEMA,
        "builder_code_sha256": BUILDER_CODE_SHA256,
        "dataset_hash": receipt.dataset_hash,
        "signal_fidelity": SIGNAL_FIDELITY,
        "fidelity_limits": [
            "one-second kline close stream is not the legacy live trade-tick stream",
            "BTCUSDT is not the legacy K binance_usd converted signal",
            "canonical archive start fixes phase instead of a recovered legacy vol_epoch",
        ],
        "parameters": {
            "sample_interval_seconds": 5,
            "j_halflife_seconds": 100,
            "j_minimum_sigma": "0.00002",
            "k_fast_halflife_seconds": 180,
            "k_slow_halflife_seconds": 2700,
            "k_floor_ratio": "0.4",
            "k_absolute_minimum_sigma": "0.000012",
            "k_warmup_seconds": 180,
        },
        "source": {
            "provider": "Binance",
            "symbol": "BTCUSDT",
            "stream": "official-1s-kline-close",
            "archives": list(inventory),
            "source_row_count": source_rows,
            "gap_count": gap_count,
            "maximum_gap_seconds": maximum_gap,
        },
        "output": {
            "file": "volatility_samples.jsonl",
            "rows": len(samples),
            "bytes": len(sample_bytes),
            "sha256": sha256(sample_bytes).hexdigest(),
        },
    }
    artifact_hash = sha256(canonical_json(core).encode("utf-8")).hexdigest()
    manifest = {**core, "artifact_hash": artifact_hash}
    destination = output_root / f"artifact={artifact_hash}"
    destination.mkdir(parents=True, exist_ok=False)
    (destination / "volatility_samples.jsonl").write_bytes(sample_bytes)
    (destination / "manifest.json").write_text(
        canonical_json(manifest) + "\n", encoding="utf-8"
    )
    return destination


def load_kj_ewma_artifact(directory: Path) -> KJEwmaArtifact:
    manifest_path = directory / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    artifact_hash = manifest.pop("artifact_hash")
    if directory.name != f"artifact={artifact_hash}":
        raise EwmaArtifactError("EWMA artifact directory does not match hash")
    if sha256(canonical_json(manifest).encode("utf-8")).hexdigest() != artifact_hash:
        raise EwmaArtifactError("EWMA artifact manifest hash mismatch")
    output = manifest["output"]
    raw = (directory / output["file"]).read_bytes()
    if len(raw) != output["bytes"] or sha256(raw).hexdigest() != output["sha256"]:
        raise EwmaArtifactError("EWMA sample output mismatch")
    rows = [json.loads(line) for line in raw.splitlines()]
    if len(rows) != output["rows"]:
        raise EwmaArtifactError("EWMA sample row count mismatch")
    samples: dict[tuple[str, int], Mapping[str, str]] = {}
    for row in rows:
        key = (str(row["condition_id"]), int(row["horizon_seconds"]))
        if key in samples:
            raise EwmaArtifactError("duplicate EWMA sample key")
        samples[key] = row
    restored = {**manifest, "artifact_hash": artifact_hash}
    return KJEwmaArtifact(
        artifact_hash=artifact_hash,
        directory=directory,
        dataset_hash=str(manifest["dataset_hash"]),
        samples=samples,
        manifest=restored,
        _proof=_LOAD_PROOF,
    )
