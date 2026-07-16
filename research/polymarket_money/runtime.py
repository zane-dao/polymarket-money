"""Minimal research runtime orchestration over the existing causal engine and data contracts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
import gzip
from hashlib import sha256
import importlib
import json
from pathlib import Path
import time
from typing import Callable, Mapping, Sequence, cast

from .backtest import (
    BacktestResult,
    DatasetAcceptancePolicy,
    ExecutionConfig,
    ExecutionModel,
    ExecutionScenario,
    FeeModel,
    FeeSchedule,
    NoTradeStrategy,
    ReplayEngine,
    Strategy,
)
from .normalized import NormalizedDatasetBuilder, PointInTimeDataset, RecordType
from .raw_events import parse_utc_iso


GIB = 1024**3
MAX_LOCAL_RAW_SECONDS = 60 * 60
MAX_LOCAL_RAW_BYTES = 2 * GIB
MIN_FREE_BYTES = 10 * GIB


class StoragePolicyError(ValueError):
    """A requested recording mode cannot preserve the local safety boundary."""


class RecordMode(str, Enum):
    NONE = "none"
    METRICS = "metrics"
    RAW = "raw"


@dataclass(frozen=True, slots=True)
class RawCapturePolicy:
    mode: RecordMode
    duration_seconds: int | None
    max_bytes: int | None
    output_path: Path | None
    writes_anything: bool
    writes_raw: bool

    @classmethod
    def for_non_raw(cls, mode: RecordMode) -> "RawCapturePolicy":
        if mode is RecordMode.RAW:
            raise StoragePolicyError("raw mode requires explicit bounded policy")
        return cls(
            mode=mode,
            duration_seconds=None,
            max_bytes=None,
            output_path=None,
            writes_anything=mode is RecordMode.METRICS,
            writes_raw=False,
        )

    @classmethod
    def create(
        cls,
        *,
        mode: RecordMode,
        duration_seconds: int,
        max_bytes: int,
        output_path: Path,
        free_bytes: int,
        filesystem_type: str,
    ) -> "RawCapturePolicy":
        if mode is not RecordMode.RAW:
            raise StoragePolicyError("bounded raw policy is only valid for raw mode")
        if not 1 <= duration_seconds <= MAX_LOCAL_RAW_SECONDS:
            raise StoragePolicyError("local raw duration must be between 1 second and 60 minutes")
        if not 1 <= max_bytes <= MAX_LOCAL_RAW_BYTES:
            raise StoragePolicyError("local raw max-bytes must be between 1 and 2 GiB")
        if not output_path.is_absolute():
            raise StoragePolicyError("raw output path must be absolute")
        if filesystem_type.lower() in {"9p", "drvfs", "fuseblk", "ntfs", "ntfs3"}:
            raise StoragePolicyError("trusted raw output requires a Linux-native filesystem")
        if free_bytes - max_bytes < MIN_FREE_BYTES:
            raise StoragePolicyError("raw allocation would cross the 10 GiB safety reserve")
        return cls(
            mode=mode,
            duration_seconds=duration_seconds,
            max_bytes=max_bytes,
            output_path=output_path,
            writes_anything=True,
            writes_raw=True,
        )


class ReplaySpeed(str, Enum):
    ONE_X = "1x"
    TEN_X = "10x"
    MAX = "max"
    STEP = "step"


class ReplayPacer:
    """Controls wall-clock presentation only; ReplayEngine remains the sole replay engine."""

    def __init__(
        self,
        speed: ReplaySpeed,
        *,
        sleep: Callable[[float], None] = time.sleep,
        step: Callable[[], str] = input,
    ) -> None:
        self.speed = speed
        self._sleep = sleep
        self._step = step
        self.paused = False

    def pause(self) -> None:
        self.paused = True

    def resume(self) -> None:
        self.paused = False

    def wait_between(self, source_seconds: float) -> None:
        if source_seconds < 0:
            raise ValueError("replay pacing delta cannot be negative")
        while self.paused:
            self._sleep(0.05)
        if self.speed is ReplaySpeed.MAX:
            return
        if self.speed is ReplaySpeed.STEP:
            self._step()
            return
        factor = 1 if self.speed is ReplaySpeed.ONE_X else 10
        if source_seconds:
            self._sleep(source_seconds / factor)

    def pace(self, points: Sequence[tuple[str, datetime]]) -> None:
        previous: datetime | None = None
        for _, current in sorted(points, key=lambda item: (item[1], item[0])):
            if previous is not None:
                self.wait_between((current - previous).total_seconds())
            elif self.speed is ReplaySpeed.STEP:
                self.wait_between(0)
            previous = current


def _default_decision_points(dataset: PointInTimeDataset) -> tuple[tuple[str, datetime], ...]:
    policy = DatasetAcceptancePolicy()
    points: list[tuple[str, datetime]] = []
    for market_id in dataset.market_ids:
        for boundary in dataset.market_boundaries(market_id):
            if policy.evaluate(dataset.as_of(boundary, market_id)).execution_eligible:
                points.append((market_id, boundary))
                break
    return tuple(sorted(points, key=lambda item: (item[1], item[0])))


def _settlement_times(dataset: PointInTimeDataset) -> Mapping[str, datetime]:
    result: dict[str, datetime] = {}
    for market_id in dataset.market_ids:
        metadata = next(
            (
                item
                for item in dataset.records
                if item.market_id == market_id and item.record_type is RecordType.MARKET_METADATA
            ),
            None,
        )
        if metadata is None or not isinstance(metadata.payload.get("interval_end"), str):
            continue
        interval_end = parse_utc_iso(metadata.payload["interval_end"], "interval_end")
        visible = [
            item.visible_at
            for item in dataset.records
            if item.market_id == market_id or item.record_type is RecordType.CHAINLINK_PRICE
        ]
        result[market_id] = max([interval_end, *visible]) + timedelta(milliseconds=1)
    return result


def run_no_trade_replay(
    version_directory: Path,
    expected_dataset_hash: str,
    *,
    speed: ReplaySpeed = ReplaySpeed.MAX,
    require_clean_normalizer: bool = True,
    pacer: ReplayPacer | None = None,
) -> BacktestResult:
    """Open a published dataset and delegate all decisions/accounting to ReplayEngine."""
    dataset = NormalizedDatasetBuilder.load(version_directory)
    points = _default_decision_points(dataset)
    if not points:
        raise ValueError("published dataset has no execution-eligible decision point")
    return run_strategy_replay(
        version_directory,
        expected_dataset_hash,
        strategy=NoTradeStrategy(points),
        speed=speed,
        require_clean_normalizer=require_clean_normalizer,
        pacer=pacer,
        dataset=dataset,
    )


def load_strategy_plugin(specification: str, dataset: PointInTimeDataset) -> Strategy:
    """Load an explicit research-only strategy factory as ``module:function``."""
    module_name, separator, factory_name = specification.partition(":")
    if not separator or not module_name or not factory_name:
        raise ValueError("strategy plugin must use module:function syntax")
    factory = getattr(importlib.import_module(module_name), factory_name, None)
    if not callable(factory):
        raise ValueError("strategy plugin factory is not callable")
    strategy = factory(dataset)
    for method in ("decision_points", "decide", "config_mapping"):
        if not callable(getattr(strategy, method, None)):
            raise ValueError(f"strategy plugin is missing {method}()")
    return cast(Strategy, strategy)


def run_strategy_replay(
    version_directory: Path,
    expected_dataset_hash: str,
    *,
    strategy: Strategy,
    speed: ReplaySpeed = ReplaySpeed.MAX,
    require_clean_normalizer: bool = True,
    pacer: ReplayPacer | None = None,
    dataset: PointInTimeDataset | None = None,
) -> BacktestResult:
    """Pace presentation, then delegate execution, fills, settlement and PnL to ReplayEngine."""
    loaded = dataset or NormalizedDatasetBuilder.load(version_directory)
    points = strategy.decision_points()
    if not points:
        raise ValueError("strategy has no decision points")
    controller = pacer or ReplayPacer(speed)
    controller.pace(points)
    policy = DatasetAcceptancePolicy()
    engine = ReplayEngine.open(
        version_directory,
        expected_dataset_hash=expected_dataset_hash,
        execution_model=ExecutionModel(
            ExecutionConfig(ExecutionScenario.TAKER_TOUCH_WITH_FEES),
            fee_model=FeeModel(
                FeeSchedule(version="runtime-no-trade-no-fee", historical_verified=False, rates=())
            ),
            acceptance_policy=policy,
        ),
        acceptance_policy=policy,
        require_clean_normalizer=require_clean_normalizer,
    )
    return engine.run(strategy, settlement_times=_settlement_times(loaded))


class PaperRuntimeGuard:
    """A deliberately non-instantiable live-client boundary for paper-only code."""

    @staticmethod
    def create_live_client() -> None:
        raise RuntimeError("paper runtime cannot construct a real trading client")


@dataclass(frozen=True, slots=True)
class InventoryFile:
    path: str
    size_bytes: int
    modified_time: str
    format: str
    classification: str
    partial_fingerprint: str
    hash_kind: str
    schema_sample: Mapping[str, object]
    sample_error: str | None


@dataclass(frozen=True, slots=True)
class InventoryReport:
    root: str
    file_count: int
    total_bytes: int
    formats: Mapping[str, int]
    classifications: Mapping[str, int]
    earliest_modified_time: str | None
    latest_modified_time: str | None
    likely_duplicate_groups: tuple[tuple[str, ...], ...]
    files: tuple[InventoryFile, ...]

    def to_mapping(self) -> dict[str, object]:
        return {
            "root": self.root,
            "file_count": self.file_count,
            "total_bytes": self.total_bytes,
            "formats": dict(sorted(self.formats.items())),
            "classifications": dict(sorted(self.classifications.items())),
            "earliest_modified_time": self.earliest_modified_time,
            "latest_modified_time": self.latest_modified_time,
            "likely_duplicate_groups": [list(group) for group in self.likely_duplicate_groups],
            "files": [
                {
                    "path": item.path,
                    "size_bytes": item.size_bytes,
                    "modified_time": item.modified_time,
                    "format": item.format,
                    "classification": item.classification,
                    "partial_fingerprint": item.partial_fingerprint,
                    "hash_kind": item.hash_kind,
                    "schema_sample": dict(item.schema_sample),
                    "sample_error": item.sample_error,
                }
                for item in self.files
            ],
        }


def _format(path: Path) -> str:
    lowered = path.name.lower()
    if lowered.endswith(".jsonl.gz"):
        return "jsonl.gz"
    suffix = path.suffix.lower().lstrip(".")
    return suffix or "no-extension"


def _classification(format_name: str) -> str:
    if format_name in {"jsonl", "jsonl.gz", "json", "csv", "parquet"}:
        return "NEEDS_CONVERSION"
    if format_name in {"db", "sqlite", "sqlite3"}:
        return "REFERENCE_ONLY"
    if format_name in {"md", "txt"}:
        return "REUSABLE_REFERENCE"
    return "UNKNOWN"


_SENSITIVE_PATH_MARKERS = frozenset(
    {
        "browser-profile",
        "cookies",
        "credential",
        "edge-prof",
        "login data",
        "mnemonic",
        "private key",
        "seed phrase",
        "wallet",
        "web data",
    }
)


def _content_read_forbidden(path: Path) -> bool:
    normalized_parts = {part.casefold() for part in path.parts}
    return any(marker in normalized_parts for marker in _SENSITIVE_PATH_MARKERS)


def _partial_fingerprint(path: Path, size: int) -> str:
    digest = sha256()
    digest.update(str(size).encode("ascii"))
    with path.open("rb") as handle:
        digest.update(handle.read(64 * 1024))
        if size > 64 * 1024:
            handle.seek(max(0, size - 64 * 1024))
            digest.update(handle.read(64 * 1024))
    return digest.hexdigest()


def _schema_sample(path: Path, format_name: str) -> tuple[Mapping[str, object], str | None]:
    try:
        if format_name in {"jsonl", "jsonl.gz"}:
            opener = gzip.open if format_name.endswith(".gz") else open
            with opener(path, "rt", encoding="utf-8", errors="strict") as handle:
                line = handle.readline(1024 * 1024 + 1)
                if len(line) > 1024 * 1024:
                    return ({"sample": "FIRST_LINE_EXCEEDS_1_MIB"}, None)
                value = json.loads(line)
            return ({"json_type": type(value).__name__, "keys": sorted(value) if isinstance(value, dict) else []}, None)
        if format_name == "json":
            if path.stat().st_size > 1024 * 1024:
                return ({"sample": "FULL_JSON_PARSE_SKIPPED_OVER_1_MIB"}, None)
            with path.open("r", encoding="utf-8") as handle:
                value = json.load(handle)
            return ({"json_type": type(value).__name__, "keys": sorted(value) if isinstance(value, dict) else []}, None)
        if format_name == "csv":
            with path.open("r", encoding="utf-8-sig", errors="strict") as handle:
                header = handle.readline().rstrip("\r\n").split(",")
            return ({"columns": header[:100], "column_count": len(header)}, None)
        return ({}, None)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        return ({}, f"{type(exc).__name__}: {exc}")


def inventory_directory(root: Path) -> InventoryReport:
    """Read metadata and bounded samples without modifying, moving, or hashing whole files."""
    canonical = root.resolve(strict=True)
    if not canonical.is_dir():
        raise ValueError("inventory root must be a directory")
    files: list[InventoryFile] = []
    formats: dict[str, int] = {}
    classifications: dict[str, int] = {}
    duplicate_index: dict[tuple[int, str], list[str]] = {}
    mtimes: list[datetime] = []
    for path in sorted(item for item in canonical.rglob("*") if item.is_file()):
        before = path.stat()
        format_name = _format(path)
        sensitive = _content_read_forbidden(path.relative_to(canonical))
        classification = "SENSITIVE_METADATA_ONLY" if sensitive else _classification(format_name)
        fingerprint = "NOT_READ_SENSITIVE_PATH" if sensitive else _partial_fingerprint(path, before.st_size)
        sample, error = ({}, "SKIPPED_SENSITIVE_PATH") if sensitive else _schema_sample(path, format_name)
        after = path.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise RuntimeError("inventory source changed during read-only scan")
        modified = datetime.fromtimestamp(before.st_mtime, tz=timezone.utc)
        mtimes.append(modified)
        relative_path = str(path.relative_to(canonical))
        files.append(
            InventoryFile(
                path=relative_path,
                size_bytes=before.st_size,
                modified_time=modified.isoformat().replace("+00:00", "Z"),
                format=format_name,
                classification=classification,
                partial_fingerprint=fingerprint,
                hash_kind=("NOT_HASHED_SENSITIVE_PATH" if sensitive else "PARTIAL_FINGERPRINT_NOT_SHA256"),
                schema_sample=sample,
                sample_error=error,
            )
        )
        formats[format_name] = formats.get(format_name, 0) + 1
        classifications[classification] = classifications.get(classification, 0) + 1
        if not sensitive:
            duplicate_index.setdefault((before.st_size, fingerprint), []).append(relative_path)
    duplicates = tuple(
        tuple(sorted(group))
        for group in duplicate_index.values()
        if len(group) > 1
    )
    return InventoryReport(
        root=str(canonical),
        file_count=len(files),
        total_bytes=sum(item.size_bytes for item in files),
        formats=formats,
        classifications=classifications,
        earliest_modified_time=(min(mtimes).isoformat().replace("+00:00", "Z") if mtimes else None),
        latest_modified_time=(max(mtimes).isoformat().replace("+00:00", "Z") if mtimes else None),
        likely_duplicate_groups=tuple(sorted(duplicates)),
        files=tuple(sorted(files, key=lambda item: (-item.size_bytes, item.path))),
    )
