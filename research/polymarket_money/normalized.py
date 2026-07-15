"""Deterministic point-in-time normalization over manifest-verified raw data.

The module deliberately uses canonical JSONL instead of an analytical framework.  It keeps
Decimal lexemes and UTC millisecond timestamps lossless, has no runtime dependency, and makes
causal visibility reviewable at the wire boundary.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from enum import Enum
import ctypes
import errno
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from typing import Any, Iterable, Mapping, Sequence

from .market_identity import discover_btc_five_minute_market
from .raw_events import RawContractViolation, RawEventEnvelopeV1, parse_rtds_price, parse_utc_iso, utc_iso
from .replay import ManifestVerificationError, RawReplay, VerifiedDataset


NORMALIZED_SCHEMA_VERSION = "normalized-record-v1"
NORMALIZED_MANIFEST_VERSION = "normalized-dataset-manifest-v1"
CONTINUITY = "UNVERIFIED"
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_COMMIT = re.compile(r"^(?:UNCOMMITTED|[0-9a-f]{7,64})$")
_SAFE_PART = re.compile(r"^[A-Za-z0-9._-]+$")
_DRVFS_ROOT = re.compile(r"^/mnt/[a-zA-Z](?:/|$)")
_WINDOWS_BACKED_FILESYSTEMS = frozenset({"9p", "drvfs", "fuseblk", "ntfs", "ntfs3"})
_PARSER_STATES = frozenset({"parsed", "unparsed", "error", "quarantined"})
_CLOB_AUDIT_NOOPS = frozenset(
    {"subscription_sent", "heartbeat_ping", "heartbeat_pong"}
)
_CLOB_AUDIT_STATES = {
    "connection_open": "CONNECTED",
    "connection_error": "DISCONNECTED",
    "connection_closed_early": "DISCONNECTED",
    "capture_timeout": "DISCONNECTED",
    "capture_complete": "DISCONNECTED",
}
_CLOB_AUDIT_EVENTS = frozenset((*_CLOB_AUDIT_NOOPS, *_CLOB_AUDIT_STATES))
_PERMANENT_QUARANTINE_REASONS = frozenset(
    {
        "CONFLICTING_BUSINESS_KEY",
        "INVALID_MARKET_IDENTITY",
        "MARKET_IDENTITY_REVISION_CONFLICT",
        "MARKET_IDENTITY_COLLISION",
        "GAMMA_IDENTITY_BINDING_MISMATCH",
    }
)
_BUILD_PROOF = object()
_UNSET = object()
_REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
_NORMALIZER_CONTRACT_PATHS = (
    _REPOSITORY_ROOT / "contracts" / "raw-event-v1.schema.json",
    _REPOSITORY_ROOT / "contracts" / "normalized-record-v1.schema.json",
    _REPOSITORY_ROOT / "contracts" / "normalized-dataset-manifest-v1.schema.json",
)
_NORMALIZER_CODE_PATHS = tuple(
    sorted((_REPOSITORY_ROOT / "research" / "polymarket_money").glob("*.py"))
) + _NORMALIZER_CONTRACT_PATHS
try:
    _LOADED_NORMALIZER_SOURCES = {
        path: path.read_bytes() for path in _NORMALIZER_CODE_PATHS
    }
except OSError as exc:  # pragma: no cover - import cannot proceed without its source contract
    raise RuntimeError("normalizer source snapshot cannot be captured") from exc
_NORMALIZED_MANIFEST_FIELDS = frozenset(
    {
        "schema_version",
        "normalized_schema_version",
        "dataset_id",
        "dataset_hash",
        "continuity",
        "normalizer_git_commit",
        "normalizer_code_sha256",
        "normalizer_worktree_state",
        "config",
        "raw_inputs",
        "row_counts",
        "quarantine_count",
        "quality_counts",
        "min_source_time",
        "max_source_time",
        "min_visible_at",
        "max_visible_at",
        "outputs",
    }
)


class RecordType(str, Enum):
    MARKET_METADATA = "market_metadata"
    OUTCOME_TOKEN_MAPPING = "outcome_token_mapping"
    CLOB_BOOK_STATE = "clob_book_state"
    CHAINLINK_BTC_USD = "chainlink_btc_usd"
    BINANCE_BTC_USDT = "binance_btc_usdt"
    CONNECTION_STATE = "connection_state"
    QUALITY_INTERVAL = "quality_interval"


class BookState(str, Enum):
    WAITING_FOR_SNAPSHOT = "WAITING_FOR_SNAPSHOT"
    ACTIVE_UNVERIFIED = "ACTIVE_UNVERIFIED"
    STALE = "STALE"
    DISCONNECTED = "DISCONNECTED"
    RESET_REQUIRED = "RESET_REQUIRED"
    UNTRADEABLE = "UNTRADEABLE"


class DatasetPublicationError(RuntimeError):
    """A normalized build cannot be safely published or loaded."""


def _require_text(value: str, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} must be a non-empty string")
    return value


def _require_digest(value: str, field_name: str) -> str:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be a lowercase SHA-256 digest")
    return value


def _require_utc(value: datetime, field_name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError(f"{field_name} must be an aware UTC datetime")
    if value.microsecond % 1_000:
        raise ValueError(f"{field_name} must use exact millisecond precision")
    return value


def _json_value(value: Any, field_name: str = "payload") -> Any:
    """Return a canonical JSON value without ever converting through binary float."""

    if isinstance(value, float):
        raise ValueError(f"{field_name} must not contain a binary float")
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError(f"{field_name} contains a non-finite Decimal")
        return format(value, "f")
    if isinstance(value, datetime):
        _require_utc(value, field_name)
        return utc_iso(value)
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for key in sorted(value):
            if not isinstance(key, str) or not key:
                raise ValueError(f"{field_name} keys must be non-empty strings")
            result[key] = _json_value(value[key], f"{field_name}.{key}")
        return result
    if isinstance(value, (list, tuple)):
        return [_json_value(item, f"{field_name}[{index}]") for index, item in enumerate(value)]
    raise ValueError(f"{field_name} contains unsupported value {type(value).__name__}")


def _canonical_json(value: Any) -> str:
    return json.dumps(
        _json_value(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )


def _rename_no_replace(source: Path, destination: Path) -> None:
    """Atomically publish a directory without replacing even an empty destination."""

    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        raise DatasetPublicationError(
            "Linux renameat2(RENAME_NOREPLACE) is required for atomic publication"
        )
    renameat2.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    renameat2.restype = ctypes.c_int
    at_fdcwd = -100
    rename_noreplace = 1
    result = renameat2(
        at_fdcwd,
        os.fsencode(source),
        at_fdcwd,
        os.fsencode(destination),
        rename_noreplace,
    )
    if result == 0:
        return
    error_number = ctypes.get_errno()
    if error_number == errno.EEXIST:
        raise DatasetPublicationError(
            "completed normalized dataset version already exists"
        )
    raise OSError(error_number, os.strerror(error_number), str(destination))


def _mount_filesystem_type(path: Path, mountinfo_text: str | None = None) -> str:
    """Return the longest-prefix Linux mount type, including bind-mounted DrvFS/9p."""

    try:
        text = (
            Path("/proc/self/mountinfo").read_text(encoding="utf-8")
            if mountinfo_text is None
            else mountinfo_text
        )
    except OSError as exc:
        raise DatasetPublicationError("filesystem type cannot be verified") from exc

    def unescape(value: str) -> str:
        return re.sub(
            r"\\([0-7]{3})",
            lambda match: chr(int(match.group(1), 8)),
            value,
        )

    best: tuple[int, str] | None = None
    for line in text.splitlines():
        fields = line.split()
        try:
            separator = fields.index("-")
            mount_point = Path(unescape(fields[4]))
            filesystem_type = fields[separator + 1]
            path.relative_to(mount_point)
        except (ValueError, IndexError):
            continue
        candidate = (len(mount_point.parts), filesystem_type)
        if best is None or candidate[0] > best[0]:
            best = candidate
    if best is None:
        raise DatasetPublicationError("filesystem type cannot be verified")
    return best[1]


def _normalizer_repository_state() -> tuple[str, str, str]:
    """Bind a build to the actual Git HEAD and exact normalizer source bytes."""

    repository = _REPOSITORY_ROOT
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repository,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        status = subprocess.run(
            [
                "git",
                "status",
                "--porcelain",
                "--untracked-files=all",
                "--",
                "research/polymarket_money",
                "contracts/raw-event-v1.schema.json",
                "contracts/normalized-record-v1.schema.json",
                "contracts/normalized-dataset-manifest-v1.schema.json",
            ],
            cwd=repository,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ManifestVerificationError(
            "normalizer repository provenance cannot be verified"
        ) from exc
    if _SHA256.fullmatch(commit) is None and not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ManifestVerificationError("normalizer repository HEAD is invalid")
    digest = sha256()
    try:
        for path in _NORMALIZER_CODE_PATHS:
            content = path.read_bytes()
            if content != _LOADED_NORMALIZER_SOURCES[path]:
                raise ManifestVerificationError(
                    "normalizer source changed after import; restart before building"
                )
            relative = path.relative_to(repository).as_posix().encode("utf-8")
            digest.update(relative)
            digest.update(b"\0")
            digest.update(content)
            digest.update(b"\0")
    except KeyError as exc:
        raise ManifestVerificationError("normalizer loaded-source snapshot is incomplete") from exc
    except OSError as exc:
        raise ManifestVerificationError("normalizer source bytes are unreadable") from exc
    return commit, "DIRTY" if status else "CLEAN", digest.hexdigest()


def _parse_time(value: Any, field_name: str) -> datetime:
    try:
        return parse_utc_iso(value, field_name)
    except RawContractViolation as exc:
        raise ValueError(str(exc)) from exc


def _nullable_time(value: Any, field_name: str) -> datetime | None:
    return None if value is None else _parse_time(value, field_name)


@dataclass(frozen=True, slots=True)
class RawLineage:
    source_manifest_id: str
    source_manifest_sha256: str
    segment_sha256: str
    event_id: str
    raw_sha256: str
    visible_at: datetime
    raw_persist_time: datetime | None = None
    segment_ordinal: int = 0
    line_ordinal: int = 0
    message_ordinal: int = 0

    def __post_init__(self) -> None:
        _require_text(self.source_manifest_id, "source_manifest_id")
        _require_digest(self.source_manifest_sha256, "source_manifest_sha256")
        _require_digest(self.segment_sha256, "segment_sha256")
        _require_text(self.event_id, "event_id")
        _require_digest(self.raw_sha256, "raw_sha256")
        _require_utc(self.visible_at, "lineage.visible_at")
        raw_persist_time = self.raw_persist_time or self.visible_at
        _require_utc(raw_persist_time, "lineage.raw_persist_time")
        if raw_persist_time > self.visible_at:
            raise ValueError("raw_persist_time must not be later than lineage visible_at")
        object.__setattr__(self, "raw_persist_time", raw_persist_time)
        for field_name, value in (
            ("segment_ordinal", self.segment_ordinal),
            ("line_ordinal", self.line_ordinal),
            ("message_ordinal", self.message_ordinal),
        ):
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"{field_name} must be a non-negative integer")

    @property
    def order_key(self) -> tuple[datetime, str, str, int, int, int, str, str]:
        return (
            self.raw_persist_time,
            self.source_manifest_id,
            self.source_manifest_sha256,
            self.segment_ordinal,
            self.line_ordinal,
            self.message_ordinal,
            self.segment_sha256,
            self.event_id,
        )

    def to_mapping(self) -> dict[str, Any]:
        return {
            "source_manifest_id": self.source_manifest_id,
            "source_manifest_sha256": self.source_manifest_sha256,
            "segment_sha256": self.segment_sha256,
            "segment_ordinal": self.segment_ordinal,
            "line_ordinal": self.line_ordinal,
            "message_ordinal": self.message_ordinal,
            "event_id": self.event_id,
            "raw_sha256": self.raw_sha256,
            "raw_persist_time": utc_iso(self.raw_persist_time),
            "visible_at": utc_iso(self.visible_at),
        }

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "RawLineage":
        expected = {
            "source_manifest_id",
            "source_manifest_sha256",
            "segment_sha256",
            "segment_ordinal",
            "line_ordinal",
            "message_ordinal",
            "event_id",
            "raw_sha256",
            "raw_persist_time",
            "visible_at",
        }
        if set(value) != expected:
            raise ValueError("raw lineage fields do not match normalized-record-v1")
        return cls(
            source_manifest_id=value["source_manifest_id"],
            source_manifest_sha256=value["source_manifest_sha256"],
            segment_sha256=value["segment_sha256"],
            segment_ordinal=value["segment_ordinal"],
            line_ordinal=value["line_ordinal"],
            message_ordinal=value["message_ordinal"],
            event_id=value["event_id"],
            raw_sha256=value["raw_sha256"],
            raw_persist_time=_parse_time(
                value["raw_persist_time"], "lineage.raw_persist_time"
            ),
            visible_at=_parse_time(value["visible_at"], "lineage.visible_at"),
        )


_RECORD_FIELDS = frozenset(
    {
        "schema_version",
        "record_id",
        "record_type",
        "business_key",
        "market_id",
        "condition_id",
        "asset_id",
        "source",
        "source_time",
        "server_time",
        "receive_time",
        "process_time",
        "persist_time",
        "visible_at",
        "continuity",
        "connection_id",
        "parser_state",
        "observed_at",
        "valid_from",
        "payload",
        "duplicate_count",
        "raw_lineage",
        "dependency_lineage",
    }
)


@dataclass(frozen=True, slots=True)
class NormalizedRecord:
    record_id: str
    record_type: RecordType
    business_key: str
    market_id: str | None
    condition_id: str | None
    asset_id: str | None
    source: str
    source_time: datetime | None
    server_time: datetime | None
    receive_time: datetime
    process_time: datetime
    persist_time: datetime
    visible_at: datetime
    continuity: str
    connection_id: str
    parser_state: str
    observed_at: datetime | None
    valid_from: datetime | None
    payload_json: str = field(repr=False)
    lineage: tuple[RawLineage, ...]
    dependency_lineage: tuple[RawLineage, ...]

    @classmethod
    def create(
        cls,
        *,
        record_type: RecordType,
        business_key: str,
        market_id: str | None,
        condition_id: str | None,
        asset_id: str | None,
        source: str,
        source_time: datetime | None,
        server_time: datetime | None,
        receive_time: datetime,
        process_time: datetime,
        persist_time: datetime,
        visible_at: datetime,
        continuity: str,
        connection_id: str,
        parser_state: str,
        payload: Mapping[str, Any],
        lineage: Sequence[RawLineage],
        dependency_lineage: Sequence[RawLineage] = (),
        observed_at: datetime | None = None,
        valid_from: datetime | None = None,
    ) -> "NormalizedRecord":
        if not isinstance(record_type, RecordType):
            try:
                record_type = RecordType(record_type)
            except (TypeError, ValueError) as exc:
                raise ValueError("unsupported normalized record_type") from exc
        _require_text(business_key, "business_key")
        _require_text(source, "source")
        _require_text(connection_id, "connection_id")
        for field_name, item in (
            ("market_id", market_id),
            ("condition_id", condition_id),
            ("asset_id", asset_id),
        ):
            if item is not None:
                _require_text(item, field_name)
        for field_name, item in (
            ("source_time", source_time),
            ("server_time", server_time),
            ("observed_at", observed_at),
            ("valid_from", valid_from),
        ):
            if item is not None:
                _require_utc(item, field_name)
        for field_name, item in (
            ("receive_time", receive_time),
            ("process_time", process_time),
            ("persist_time", persist_time),
            ("visible_at", visible_at),
        ):
            _require_utc(item, field_name)
        if process_time < receive_time or persist_time < process_time:
            raise ValueError("normalized ingress clocks must be monotonic")
        if visible_at < max(receive_time, process_time, persist_time):
            raise ValueError("visible_at must not precede any ingress clock")
        if observed_at is not None and observed_at > visible_at:
            raise ValueError("observed_at must not be later than visible_at")
        if continuity != CONTINUITY:
            raise ValueError("public normalized continuity must remain UNVERIFIED")
        if parser_state not in _PARSER_STATES:
            raise ValueError("invalid parser_state")
        if not lineage:
            raise ValueError("normalized records require raw lineage")
        ordered_lineage = tuple(
            sorted(
                set(lineage),
                key=lambda item: (*item.order_key, item.raw_sha256),
            )
        )
        ordered_dependencies = tuple(
            sorted(
                set(dependency_lineage),
                key=lambda item: (*item.order_key, item.raw_sha256),
            )
        )
        if min(item.visible_at for item in ordered_lineage) < persist_time:
            raise ValueError("raw lineage visibility cannot precede record persistence")
        if visible_at != min(item.visible_at for item in ordered_lineage):
            raise ValueError("visible_at must equal the earliest usable lineage time")
        if any(item.visible_at > visible_at for item in ordered_dependencies):
            raise ValueError("dependency lineage must be visible before the normalized fact")
        payload_json = _canonical_json(payload)
        semantic = {
            "record_type": record_type.value,
            "business_key": business_key,
            "market_id": market_id,
            "condition_id": condition_id,
            "asset_id": asset_id,
            "source": source,
            "source_time": utc_iso(source_time),
            "server_time": utc_iso(server_time),
            "continuity": continuity,
            "connection_id": connection_id,
            "parser_state": parser_state,
            "observed_at": utc_iso(observed_at),
            "valid_from": utc_iso(valid_from),
            "payload": json.loads(payload_json),
        }
        record_id = sha256(_canonical_json(semantic).encode("utf-8")).hexdigest()
        return cls(
            record_id=record_id,
            record_type=record_type,
            business_key=business_key,
            market_id=market_id,
            condition_id=condition_id,
            asset_id=asset_id,
            source=source,
            source_time=source_time,
            server_time=server_time,
            receive_time=receive_time,
            process_time=process_time,
            persist_time=persist_time,
            visible_at=visible_at,
            continuity=continuity,
            connection_id=connection_id,
            parser_state=parser_state,
            observed_at=observed_at,
            valid_from=valid_from,
            payload_json=payload_json,
            lineage=ordered_lineage,
            dependency_lineage=ordered_dependencies,
        )

    @property
    def payload(self) -> dict[str, Any]:
        value = json.loads(self.payload_json)
        if not isinstance(value, dict):
            raise ValueError("normalized payload must be an object")
        return value

    @property
    def duplicate_count(self) -> int:
        return len(self.lineage)

    def to_mapping(self) -> dict[str, Any]:
        return {
            "schema_version": NORMALIZED_SCHEMA_VERSION,
            "record_id": self.record_id,
            "record_type": self.record_type.value,
            "business_key": self.business_key,
            "market_id": self.market_id,
            "condition_id": self.condition_id,
            "asset_id": self.asset_id,
            "source": self.source,
            "source_time": utc_iso(self.source_time),
            "server_time": utc_iso(self.server_time),
            "receive_time": utc_iso(self.receive_time),
            "process_time": utc_iso(self.process_time),
            "persist_time": utc_iso(self.persist_time),
            "visible_at": utc_iso(self.visible_at),
            "continuity": self.continuity,
            "connection_id": self.connection_id,
            "parser_state": self.parser_state,
            "observed_at": utc_iso(self.observed_at),
            "valid_from": utc_iso(self.valid_from),
            "payload": self.payload,
            "duplicate_count": self.duplicate_count,
            "raw_lineage": [item.to_mapping() for item in self.lineage],
            "dependency_lineage": [
                item.to_mapping() for item in self.dependency_lineage
            ],
        }

    def to_json_line(self) -> str:
        return _canonical_json(self.to_mapping())

    @classmethod
    def from_json_line(cls, line: str) -> "NormalizedRecord":
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError("normalized JSONL line is invalid") from exc
        if not isinstance(value, dict) or set(value) != _RECORD_FIELDS:
            raise ValueError("normalized record fields do not match schema")
        if value["schema_version"] != NORMALIZED_SCHEMA_VERSION:
            raise ValueError("unsupported normalized schema")
        lineages = value["raw_lineage"]
        dependencies = value["dependency_lineage"]
        if not isinstance(lineages, list) or not isinstance(dependencies, list):
            raise ValueError("raw_lineage and dependency_lineage must be lists")
        record = cls.create(
            record_type=RecordType(value["record_type"]),
            business_key=value["business_key"],
            market_id=value["market_id"],
            condition_id=value["condition_id"],
            asset_id=value["asset_id"],
            source=value["source"],
            source_time=_nullable_time(value["source_time"], "source_time"),
            server_time=_nullable_time(value["server_time"], "server_time"),
            receive_time=_parse_time(value["receive_time"], "receive_time"),
            process_time=_parse_time(value["process_time"], "process_time"),
            persist_time=_parse_time(value["persist_time"], "persist_time"),
            visible_at=_parse_time(value["visible_at"], "visible_at"),
            continuity=value["continuity"],
            connection_id=value["connection_id"],
            parser_state=value["parser_state"],
            observed_at=_nullable_time(value["observed_at"], "observed_at"),
            valid_from=_nullable_time(value["valid_from"], "valid_from"),
            payload=value["payload"],
            lineage=tuple(RawLineage.from_mapping(item) for item in lineages),
            dependency_lineage=tuple(
                RawLineage.from_mapping(item) for item in dependencies
            ),
        )
        if value["record_id"] != record.record_id:
            raise ValueError("normalized record_id does not match semantic content")
        if value["duplicate_count"] != record.duplicate_count:
            raise ValueError("duplicate_count does not match raw_lineage")
        return record

    def with_business_key(self, business_key: str) -> "NormalizedRecord":
        return self.create(
            record_type=self.record_type,
            business_key=business_key,
            market_id=self.market_id,
            condition_id=self.condition_id,
            asset_id=self.asset_id,
            source=self.source,
            source_time=self.source_time,
            server_time=self.server_time,
            receive_time=self.receive_time,
            process_time=self.process_time,
            persist_time=self.persist_time,
            visible_at=self.visible_at,
            continuity=self.continuity,
            connection_id=self.connection_id,
            parser_state=self.parser_state,
            observed_at=self.observed_at,
            valid_from=self.valid_from,
            payload=self.payload,
            lineage=self.lineage,
            dependency_lineage=self.dependency_lineage,
        )

    def with_lineage(
        self,
        lineage: Sequence[RawLineage],
        dependency_lineage: Sequence[RawLineage] = (),
    ) -> "NormalizedRecord":
        combined = tuple(set((*self.lineage, *lineage)))
        combined_dependencies = tuple(
            set((*self.dependency_lineage, *dependency_lineage))
        )
        earliest = min(combined, key=lambda item: item.visible_at)
        return replace(
            self,
            visible_at=min(self.visible_at, earliest.visible_at),
            lineage=tuple(
                sorted(
                    combined,
                    key=lambda item: (*item.order_key, item.raw_sha256),
                )
            ),
            dependency_lineage=tuple(
                sorted(
                    combined_dependencies,
                    key=lambda item: (*item.order_key, item.raw_sha256),
                )
            ),
        )

    def at_time(self, decision_time: datetime) -> "NormalizedRecord":
        visible_lineage = tuple(item for item in self.lineage if item.visible_at <= decision_time)
        if not visible_lineage:
            raise ValueError("record has no lineage visible at decision_time")
        visible_dependencies = tuple(
            item for item in self.dependency_lineage if item.visible_at <= decision_time
        )
        return replace(
            self,
            lineage=visible_lineage,
            dependency_lineage=visible_dependencies,
        )


_QUARANTINE_FIELDS = frozenset(
    {
        "schema_version",
        "quarantine_id",
        "reason_code",
        "business_key",
        "market_id",
        "asset_id",
        "visible_at",
        "affected_record_ids",
        "raw_lineage",
        "dependency_lineage",
    }
)


@dataclass(frozen=True, slots=True)
class QuarantineRecord:
    quarantine_id: str
    reason_code: str
    business_key: str
    market_id: str | None
    asset_id: str | None
    visible_at: datetime
    affected_record_ids: tuple[str, ...]
    lineage: tuple[RawLineage, ...]
    dependency_lineage: tuple[RawLineage, ...]

    @classmethod
    def create(
        cls,
        *,
        reason_code: str,
        business_key: str,
        market_id: str | None,
        asset_id: str | None,
        visible_at: datetime,
        affected_record_ids: Sequence[str],
        lineage: Sequence[RawLineage],
        dependency_lineage: Sequence[RawLineage] = (),
    ) -> "QuarantineRecord":
        _require_text(reason_code, "reason_code")
        _require_text(business_key, "business_key")
        for field_name, value in (("market_id", market_id), ("asset_id", asset_id)):
            if value is not None:
                _require_text(value, field_name)
        _require_utc(visible_at, "visible_at")
        ordered_ids = tuple(sorted(set(affected_record_ids)))
        for affected_record_id in ordered_ids:
            _require_digest(affected_record_id, "affected_record_id")
        ordered_lineage = tuple(
            sorted(
                set(lineage),
                key=lambda item: item.order_key,
            )
        )
        if not ordered_lineage:
            raise ValueError("quarantine requires raw lineage")
        if max(item.visible_at for item in ordered_lineage) != visible_at:
            raise ValueError(
                "quarantine visible_at must equal its triggering raw lineage time"
            )
        ordered_dependencies = tuple(
            sorted(set(dependency_lineage), key=lambda item: item.order_key)
        )
        if any(item.visible_at > visible_at for item in ordered_dependencies):
            raise ValueError("quarantine dependency lineage must already be visible")
        identity = {
            "reason_code": reason_code,
            "business_key": business_key,
            "market_id": market_id,
            "asset_id": asset_id,
            "visible_at": utc_iso(visible_at),
            "affected_record_ids": ordered_ids,
            "raw_lineage": [item.to_mapping() for item in ordered_lineage],
            "dependency_lineage": [
                item.to_mapping() for item in ordered_dependencies
            ],
        }
        return cls(
            quarantine_id=sha256(_canonical_json(identity).encode("utf-8")).hexdigest(),
            reason_code=reason_code,
            business_key=business_key,
            market_id=market_id,
            asset_id=asset_id,
            visible_at=visible_at,
            affected_record_ids=ordered_ids,
            lineage=ordered_lineage,
            dependency_lineage=ordered_dependencies,
        )

    def to_mapping(self) -> dict[str, Any]:
        return {
            "schema_version": NORMALIZED_SCHEMA_VERSION,
            "quarantine_id": self.quarantine_id,
            "reason_code": self.reason_code,
            "business_key": self.business_key,
            "market_id": self.market_id,
            "asset_id": self.asset_id,
            "visible_at": utc_iso(self.visible_at),
            "affected_record_ids": list(self.affected_record_ids),
            "raw_lineage": [item.to_mapping() for item in self.lineage],
            "dependency_lineage": [
                item.to_mapping() for item in self.dependency_lineage
            ],
        }

    def to_json_line(self) -> str:
        return _canonical_json(self.to_mapping())

    def at_time(self, decision_time: datetime) -> "QuarantineRecord":
        visible_lineage = tuple(item for item in self.lineage if item.visible_at <= decision_time)
        if not visible_lineage:
            raise ValueError("quarantine has no lineage visible at decision_time")
        visible_dependencies = tuple(
            item for item in self.dependency_lineage if item.visible_at <= decision_time
        )
        return replace(
            self,
            lineage=visible_lineage,
            dependency_lineage=visible_dependencies,
        )

    @classmethod
    def from_json_line(cls, line: str) -> "QuarantineRecord":
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError("quarantine JSONL line is invalid") from exc
        if not isinstance(value, dict) or set(value) != _QUARANTINE_FIELDS:
            raise ValueError("quarantine record fields do not match schema")
        if value["schema_version"] != NORMALIZED_SCHEMA_VERSION:
            raise ValueError("unsupported quarantine schema")
        if not isinstance(value["raw_lineage"], list) or not isinstance(
            value["dependency_lineage"], list
        ):
            raise ValueError("quarantine lineage fields must be lists")
        if not isinstance(value["affected_record_ids"], list):
            raise ValueError("affected_record_ids must be a list")
        result = cls.create(
            reason_code=value["reason_code"],
            business_key=value["business_key"],
            market_id=value["market_id"],
            asset_id=value["asset_id"],
            visible_at=_parse_time(value["visible_at"], "visible_at"),
            affected_record_ids=value["affected_record_ids"],
            lineage=tuple(RawLineage.from_mapping(item) for item in value["raw_lineage"]),
            dependency_lineage=tuple(
                RawLineage.from_mapping(item)
                for item in value["dependency_lineage"]
            ),
        )
        if result.quarantine_id != value["quarantine_id"]:
            raise ValueError("quarantine_id does not match content")
        return result


def canonicalize_records(
    records: Iterable[NormalizedRecord],
) -> tuple[tuple[NormalizedRecord, ...], tuple[QuarantineRecord, ...]]:
    """Merge identical facts and quarantine conflicting facts without last-write-wins."""

    groups: dict[str, list[NormalizedRecord]] = {}
    for record in records:
        groups.setdefault(record.business_key, []).append(record)
    canonical: list[NormalizedRecord] = []
    quarantines: list[QuarantineRecord] = []
    for business_key, group in sorted(groups.items()):
        ordered = sorted(
            group,
            key=lambda item: (
                item.visible_at,
                item.record_id,
                item.receive_time,
                item.process_time,
                item.persist_time,
                item.lineage[0].order_key,
            ),
        )
        baseline_id = ordered[0].record_id
        same = [item for item in ordered if item.record_id == baseline_id]
        conflicts = [item for item in ordered if item.record_id != baseline_id]
        merged = same[0]
        for duplicate in same[1:]:
            merged = merged.with_lineage(
                duplicate.lineage, duplicate.dependency_lineage
            )
        canonical.append(merged)
        for conflict in conflicts:
            causal_baseline_lineage = tuple(
                item for item in merged.lineage if item.visible_at <= conflict.visible_at
            )
            causal_dependencies = tuple(
                item
                for item in (*merged.dependency_lineage, *conflict.dependency_lineage)
                if item.visible_at <= conflict.visible_at
            )
            quarantines.append(
                QuarantineRecord.create(
                    reason_code="CONFLICTING_BUSINESS_KEY",
                    business_key=business_key,
                    market_id=ordered[0].market_id,
                    asset_id=ordered[0].asset_id,
                    visible_at=conflict.visible_at,
                    affected_record_ids=[merged.record_id, conflict.record_id],
                    lineage=(*causal_baseline_lineage, *conflict.lineage),
                    dependency_lineage=causal_dependencies,
                )
            )
    return (
        tuple(sorted(canonical, key=lambda item: (item.visible_at, item.record_type.value, item.business_key))),
        tuple(sorted(quarantines, key=lambda item: (item.visible_at, item.quarantine_id))),
    )


def outcome_token_mapping(labels: Sequence[str], token_ids: Sequence[str]) -> dict[str, str]:
    if len(labels) != 2 or len(token_ids) != 2 or len(set(token_ids)) != 2:
        raise ValueError("exactly two distinct outcome tokens are required")
    mapped: dict[str, str] = {}
    for label, token_id in zip(labels, token_ids, strict=True):
        folded = _require_text(label, "outcome label").strip().casefold()
        if folded not in {"up", "down"}:
            raise ValueError("outcome labels must be Up and Down")
        if folded in mapped:
            raise ValueError("duplicate outcome label")
        mapped[f"{folded}_token_id"] = _require_text(token_id, "token_id")
    if set(mapped) != {"up_token_id", "down_token_id"}:
        raise ValueError("outcome labels must contain Up and Down")
    return mapped


def _decimal(value: Any, field_name: str, *, positive: bool = False) -> Decimal:
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be a decimal string")
    try:
        result = Decimal(value)
    except InvalidOperation as exc:
        raise ValueError(f"{field_name} is not a valid Decimal") from exc
    if not result.is_finite() or (positive and result <= 0):
        raise ValueError(f"{field_name} is outside its valid Decimal range")
    return result


def _canonical_decimal(value: Any, field_name: str, *, positive: bool = False) -> str:
    return format(_decimal(value, field_name, positive=positive), "f")


def _levels(value: Any, side: str) -> tuple[tuple[Decimal, Decimal], ...]:
    if not isinstance(value, list):
        raise ValueError(f"{side} must be a list")
    result: dict[Decimal, Decimal] = {}
    for index, item in enumerate(value):
        if not isinstance(item, dict) or set(item) != {"price", "size"}:
            raise ValueError(f"{side}[{index}] must contain price and size")
        price = _decimal(item["price"], f"{side}[{index}].price")
        size = _decimal(item["size"], f"{side}[{index}].size", positive=True)
        if price < 0 or price > 1 or price in result:
            raise ValueError(f"{side}[{index}] has an invalid or duplicate price")
        result[price] = size
    reverse = side == "bids"
    return tuple(sorted(result.items(), key=lambda item: item[0], reverse=reverse))


@dataclass(frozen=True, slots=True)
class BookView:
    asset_id: str
    state: BookState
    bids: tuple[tuple[Decimal, Decimal], ...]
    asks: tuple[tuple[Decimal, Decimal], ...]
    best_bid: Decimal | None
    best_ask: Decimal | None
    midpoint: Decimal | None
    execution_eligible: bool
    continuity: str
    connection_id: str | None
    lineage_count: int


@dataclass(frozen=True, slots=True)
class PointInTimeView:
    decision_time: datetime
    market_id: str
    metadata: dict[str, Any] | None
    token_by_outcome: dict[str, str]
    books: dict[str, BookView]
    chainlink_price: Decimal | None
    binance_price: Decimal | None
    continuity: str
    quarantines: tuple[QuarantineRecord, ...]


class PointInTimeDataset:
    def __init__(
        self,
        records: Iterable[NormalizedRecord],
        *,
        quarantines: Iterable[QuarantineRecord] = (),
        stale_after: timedelta = timedelta(seconds=1),
        dataset_hash: str | None = None,
    ) -> None:
        if stale_after <= timedelta(0):
            raise ValueError("stale_after must be positive")
        self._records = tuple(sorted(records, key=lambda item: (item.visible_at, item.record_id)))
        self._quarantines = tuple(
            sorted(quarantines, key=lambda item: (item.visible_at, item.quarantine_id))
        )
        self._stale_after = stale_after
        self.dataset_hash = dataset_hash

    @staticmethod
    def _record_order(record: NormalizedRecord) -> tuple[Any, ...]:
        return (record.visible_at, *max(item.order_key for item in record.lineage))

    @staticmethod
    def _causal_frontier(record: NormalizedRecord | QuarantineRecord) -> tuple[datetime, datetime]:
        return (
            record.visible_at,
            max(item.raw_persist_time for item in record.lineage),
        )

    @staticmethod
    def _manifest_identity(
        record: NormalizedRecord | QuarantineRecord,
    ) -> tuple[str, str]:
        tail = max(record.lineage, key=lambda item: item.order_key)
        return tail.source_manifest_id, tail.source_manifest_sha256

    @staticmethod
    def _causally_not_before(
        candidate: NormalizedRecord | QuarantineRecord,
        baseline: NormalizedRecord | QuarantineRecord,
    ) -> bool:
        candidate_frontier = PointInTimeDataset._causal_frontier(candidate)
        baseline_frontier = PointInTimeDataset._causal_frontier(baseline)
        if candidate_frontier != baseline_frontier:
            return candidate_frontier > baseline_frontier
        candidate_tail = max(candidate.lineage, key=lambda item: item.order_key)
        baseline_tail = max(baseline.lineage, key=lambda item: item.order_key)
        if (
            candidate_tail.source_manifest_id,
            candidate_tail.source_manifest_sha256,
        ) != (
            baseline_tail.source_manifest_id,
            baseline_tail.source_manifest_sha256,
        ):
            return False
        return candidate_tail.order_key >= baseline_tail.order_key

    @staticmethod
    def _latest(records: Iterable[NormalizedRecord]) -> NormalizedRecord | None:
        materialized = list(records)
        if not materialized:
            return None
        return max(
            materialized,
            key=lambda item: (
                item.valid_from or item.visible_at,
                item.observed_at or item.visible_at,
                item.visible_at,
                PointInTimeDataset._record_order(item),
                item.record_id,
            ),
        )

    def as_of(self, decision_time: datetime, market_id: str) -> PointInTimeView:
        _require_utc(decision_time, "decision_time")
        _require_text(market_id, "market_id")
        visible_quarantine = tuple(
            item.at_time(decision_time)
            for item in self._quarantines
            if item.visible_at <= decision_time and item.market_id == market_id
        )
        conflict_keys = {
            item.business_key
            for item in visible_quarantine
            if item.reason_code == "CONFLICTING_BUSINESS_KEY"
        }
        visible = [
            item.at_time(decision_time)
            for item in self._records
            if item.visible_at <= decision_time
            and item.market_id == market_id
            and (item.source_time is None or item.source_time <= decision_time)
            and item.business_key not in conflict_keys
        ]
        metadata_record = self._latest(
            item
            for item in visible
            if item.record_type is RecordType.MARKET_METADATA
            and (item.valid_from is None or item.valid_from <= decision_time)
        )
        mapping_record = self._latest(
            item
            for item in visible
            if item.record_type is RecordType.OUTCOME_TOKEN_MAPPING
            and (item.valid_from is None or item.valid_from <= decision_time)
        )
        metadata = metadata_record.payload if metadata_record is not None else None
        mapping_payload = mapping_record.payload if mapping_record is not None else {}
        token_by_outcome = {
            outcome: mapping_payload[key]
            for outcome, key in (("up", "up_token_id"), ("down", "down_token_id"))
            if isinstance(mapping_payload.get(key), str)
        }
        connection_candidates = [
            item for item in visible if item.record_type is RecordType.CONNECTION_STATE
        ]
        latest_connection = self._latest(connection_candidates)
        connection_ambiguous = False
        if latest_connection is not None:
            frontier = self._causal_frontier(latest_connection)
            contenders = [
                item
                for item in connection_candidates
                if self._causal_frontier(item) == frontier
            ]
            contender_manifests = {
                self._manifest_identity(item) for item in contenders
            }
            contender_states = {
                (item.connection_id, item.payload.get("state")) for item in contenders
            }
            connection_ambiguous = bool(
                len(contender_manifests) > 1 and len(contender_states) > 1
            )
        connection_state = (
            latest_connection.payload.get("state") if latest_connection is not None else "DISCONNECTED"
        )
        if connection_ambiguous:
            connection_state = "RESET_REQUIRED"
        connection_id = latest_connection.connection_id if latest_connection is not None else None

        def quarantine_is_active(item: QuarantineRecord) -> bool:
            return bool(
                item.reason_code in _PERMANENT_QUARANTINE_REASONS
                or latest_connection is None
                or not self._causally_not_before(latest_connection, item)
            )

        market_quarantine = any(
            item.market_id == market_id
            and item.asset_id is None
            and quarantine_is_active(item)
            for item in visible_quarantine
        )
        expected_assets = set(token_by_outcome.values())
        latest_books_by_asset: dict[str, NormalizedRecord | None] = {}
        ambiguous_books: set[str] = set()
        for asset_id in expected_assets:
            candidates = [
                item
                for item in visible
                if item.record_type is RecordType.CLOB_BOOK_STATE
                and item.asset_id == asset_id
                and item.connection_id == connection_id
                and (
                    latest_connection is None
                    or self._causally_not_before(item, latest_connection)
                )
            ]
            latest_book = self._latest(candidates)
            latest_books_by_asset[asset_id] = latest_book
            if latest_book is not None:
                frontier = self._causal_frontier(latest_book)
                contenders = [
                    item
                    for item in candidates
                    if self._causal_frontier(item) == frontier
                ]
                contender_manifests = {
                    self._manifest_identity(item) for item in contenders
                }
                contender_payloads = {
                    (item.connection_id, item.payload_json) for item in contenders
                }
                if len(contender_manifests) > 1 and len(contender_payloads) > 1:
                    ambiguous_books.add(asset_id)
        parsed_books: dict[
            str,
            tuple[
                tuple[tuple[Decimal, Decimal], ...],
                tuple[tuple[Decimal, Decimal], ...],
                bool,
                bool,
                int,
            ],
        ] = {}
        relevant_quarantine_by_asset: dict[str, bool] = {}
        for asset_id in expected_assets:
            latest_book = latest_books_by_asset[asset_id]
            relevant_quarantine_by_asset[asset_id] = market_quarantine or any(
                item.asset_id == asset_id
                or (latest_book is not None and item.business_key == latest_book.business_key)
                for item in visible_quarantine
                if quarantine_is_active(item)
            )
            bids: tuple[tuple[Decimal, Decimal], ...] = ()
            asks: tuple[tuple[Decimal, Decimal], ...] = ()
            contract_valid = True
            lineage_count = 0
            if latest_book is not None:
                lineage_count = latest_book.duplicate_count
                try:
                    bids = _levels(latest_book.payload.get("bids"), "bids")
                    asks = _levels(latest_book.payload.get("asks"), "asks")
                except ValueError:
                    contract_valid = False
            crossed = bool(
                contract_valid and bids and asks and bids[0][0] > asks[0][0]
            )
            parsed_books[asset_id] = (
                bids,
                asks,
                contract_valid,
                crossed,
                lineage_count,
            )

        snapshots_ready = bool(expected_assets) and all(
            item is not None and item.payload.get("snapshot_received") is True
            for item in latest_books_by_asset.values()
        )
        market_reset_required = bool(
            connection_state == "RESET_REQUIRED"
            or any(relevant_quarantine_by_asset.values())
            or ambiguous_books
            or any(
                not contract_valid or crossed
                for _, _, contract_valid, crossed, _ in parsed_books.values()
            )
        )
        market_stale = bool(
            connection_state == "STALE"
            or any(
                latest_book is not None
                and decision_time - latest_book.receive_time >= self._stale_after
                for latest_book in latest_books_by_asset.values()
            )
        )
        market_has_empty_side = bool(
            snapshots_ready
            and any(not bids or not asks for bids, asks, _, _, _ in parsed_books.values())
        )
        if market_reset_required:
            market_book_state = BookState.RESET_REQUIRED
        elif connection_state == "STALE":
            market_book_state = BookState.STALE
        elif connection_state != "CONNECTED":
            market_book_state = BookState.DISCONNECTED
        elif not snapshots_ready:
            market_book_state = BookState.WAITING_FOR_SNAPSHOT
        elif market_stale:
            market_book_state = BookState.STALE
        elif market_has_empty_side:
            market_book_state = BookState.UNTRADEABLE
        else:
            market_book_state = BookState.ACTIVE_UNVERIFIED

        books: dict[str, BookView] = {}
        for asset_id in sorted(expected_assets):
            bids, asks, _, _, lineage_count = parsed_books[asset_id]
            best_bid = bids[0][0] if bids else None
            best_ask = asks[0][0] if asks else None
            midpoint = (
                (best_bid + best_ask) / Decimal(2)
                if best_bid is not None and best_ask is not None
                else None
            )
            interval_start: datetime | None = None
            interval_end: datetime | None = None
            if metadata is not None:
                try:
                    interval_start = _parse_time(
                        metadata.get("interval_start"), "metadata.interval_start"
                    )
                    interval_end = _parse_time(
                        metadata.get("interval_end"), "metadata.interval_end"
                    )
                except ValueError:
                    interval_start = interval_end = None
            lifecycle_eligible = bool(
                metadata is not None
                and metadata.get("active") is True
                and metadata.get("closed") is False
                and metadata.get("accepting_orders") is True
                and interval_start is not None
                and interval_end is not None
                and interval_start <= decision_time < interval_end
            )
            execution_eligible = bool(
                market_book_state is BookState.ACTIVE_UNVERIFIED
                and best_bid is not None
                and best_ask is not None
                and metadata is not None
                and metadata.get("identity_valid") is True
                and lifecycle_eligible
                and mapping_record is not None
            )
            books[asset_id] = BookView(
                asset_id=asset_id,
                state=market_book_state,
                bids=bids,
                asks=asks,
                best_bid=best_bid,
                best_ask=best_ask,
                midpoint=midpoint,
                execution_eligible=execution_eligible,
                continuity=CONTINUITY,
                connection_id=connection_id,
                lineage_count=lineage_count,
            )

        def latest_price(record_type: RecordType) -> Decimal | None:
            candidates = [item for item in visible if item.record_type is record_type]
            record = (
                max(
                    candidates,
                    key=lambda item: (
                        item.source_time or item.visible_at,
                        item.visible_at,
                        self._record_order(item),
                        item.record_id,
                    ),
                )
                if candidates
                else None
            )
            if record is None:
                return None
            return _decimal(record.payload.get("price"), "price", positive=True)

        return PointInTimeView(
            decision_time=decision_time,
            market_id=market_id,
            metadata=metadata,
            token_by_outcome=token_by_outcome,
            books=books,
            chainlink_price=latest_price(RecordType.CHAINLINK_BTC_USD),
            binance_price=latest_price(RecordType.BINANCE_BTC_USDT),
            continuity=CONTINUITY,
            quarantines=visible_quarantine,
        )

    @classmethod
    def load(cls, version_directory: Path) -> "PointInTimeDataset":
        return NormalizedDatasetBuilder.load(version_directory)


@dataclass(frozen=True, slots=True)
class NormalizerConfig:
    book_stale_after_ms: int = 1_000
    allow_binance_all_symbols_fallback: bool = False

    def __post_init__(self) -> None:
        if (
            isinstance(self.book_stale_after_ms, bool)
            or not isinstance(self.book_stale_after_ms, int)
            or self.book_stale_after_ms <= 0
        ):
            raise ValueError("book_stale_after_ms must be a positive integer")
        if not isinstance(self.allow_binance_all_symbols_fallback, bool):
            raise ValueError("allow_binance_all_symbols_fallback must be boolean")

    def to_mapping(self) -> dict[str, Any]:
        return {
            "book_stale_after_ms": self.book_stale_after_ms,
            "binance_default_transport_scope": "btc-only",
            "allow_binance_all_symbols_fallback": self.allow_binance_all_symbols_fallback,
            "storage_coordination": "single-writer",
            "supported_filesystem": "linux-native",
        }


@dataclass(frozen=True, slots=True)
class NormalizedBuild:
    dataset_id: str
    dataset_hash: str
    records: tuple[NormalizedRecord, ...]
    quarantines: tuple[QuarantineRecord, ...]
    records_bytes: bytes = field(repr=False)
    quarantine_bytes: bytes = field(repr=False)
    manifest: dict[str, Any]
    manifest_bytes: bytes = field(repr=False)
    _proof: object = field(repr=False, compare=False)

    def __post_init__(self) -> None:
        if self._proof is not _BUILD_PROOF:
            raise DatasetPublicationError(
                "NormalizedBuild can only be created from manifest-verified raw data"
            )


@dataclass(frozen=True, slots=True)
class _RawObservation:
    dataset: VerifiedDataset
    segment_ordinal: int
    line_ordinal: int
    segment_sha256: str
    event: RawEventEnvelopeV1
    message_ordinal: int = 0

    @property
    def lineage(self) -> RawLineage:
        return RawLineage(
            source_manifest_id=self.dataset.dataset_id,
            source_manifest_sha256=self.dataset.manifest_sha256,
            segment_sha256=self.segment_sha256,
            event_id=self.event.event_id,
            raw_sha256=self.event.raw_sha256,
            visible_at=self.event.persist_time,
            raw_persist_time=self.event.persist_time,
            segment_ordinal=self.segment_ordinal,
            line_ordinal=self.line_ordinal,
            message_ordinal=self.message_ordinal,
        )


@dataclass(frozen=True, slots=True)
class _PendingGammaBindingClaim:
    observation: _RawObservation
    payload_market_id: str
    claimed_market_id: str | None
    claimed_condition_id: str | None
    claimed_asset_id: str | None
    claimed_slug: str | None


@dataclass(slots=True)
class _MutableBook:
    bids: dict[Decimal, Decimal]
    asks: dict[Decimal, Decimal]


def _raw_observations(dataset: VerifiedDataset) -> list[_RawObservation]:
    RawReplay._assert_verified(dataset)
    result: list[_RawObservation] = []
    for segment in sorted(dataset.segments, key=lambda item: item.ordinal):
        text = segment.raw_bytes.decode("utf-8")
        for line_ordinal, line in enumerate(text[:-1].split("\n")):
            result.append(
                _RawObservation(
                    dataset=dataset,
                    segment_ordinal=segment.ordinal,
                    line_ordinal=line_ordinal,
                    segment_sha256=segment.sha256,
                    event=RawEventEnvelopeV1.from_json_line(line),
                )
            )
    return result


def _record_from_event(
    observation: _RawObservation,
    *,
    record_type: RecordType,
    business_key: str,
    payload: Mapping[str, Any],
    market_id: str | None = None,
    condition_id: str | None = None,
    asset_id: str | None = None,
    source_time: datetime | None = None,
    server_time: datetime | None = None,
    visible_at: datetime | None = None,
    observed_at: datetime | None = None,
    valid_from: datetime | None = None,
    dependency_lineage: Sequence[RawLineage] = (),
) -> NormalizedRecord:
    event = observation.event
    effective_visible_at = visible_at or event.persist_time
    return NormalizedRecord.create(
        record_type=record_type,
        business_key=business_key,
        market_id=market_id if market_id is not None else event.market_id,
        condition_id=condition_id if condition_id is not None else event.condition_id,
        asset_id=asset_id if asset_id is not None else event.asset_id,
        source=event.source,
        source_time=source_time if source_time is not None else event.source_time,
        server_time=server_time if server_time is not None else event.server_time,
        receive_time=event.receive_time,
        process_time=event.process_time,
        persist_time=event.persist_time,
        visible_at=effective_visible_at,
        continuity=CONTINUITY,
        connection_id=event.connection_id,
        parser_state=event.parser_status,
        observed_at=observed_at,
        valid_from=valid_from,
        payload=payload,
        lineage=(replace(observation.lineage, visible_at=effective_visible_at),),
        dependency_lineage=tuple(dependency_lineage),
    )


def _quarantine_from_event(
    observation: _RawObservation,
    reason_code: str,
    *,
    business_key: str | None = None,
    market_id: Any = _UNSET,
    asset_id: Any = _UNSET,
    visible_at: datetime | None = None,
    dependency_lineage: Sequence[RawLineage] = (),
) -> QuarantineRecord:
    event = observation.event
    effective_visible_at = visible_at or event.persist_time
    return QuarantineRecord.create(
        reason_code=reason_code,
        business_key=business_key or f"raw:{event.event_id}",
        market_id=event.market_id if market_id is _UNSET else market_id,
        asset_id=event.asset_id if asset_id is _UNSET else asset_id,
        visible_at=effective_visible_at,
        affected_record_ids=(),
        lineage=(replace(observation.lineage, visible_at=effective_visible_at),),
        dependency_lineage=dependency_lineage,
    )


class NormalizedDatasetBuilder:
    @staticmethod
    def _assert_current(dataset: VerifiedDataset) -> None:
        RawReplay._assert_verified(dataset)
        if (
            dataset.manifest_path is None
            or not dataset.manifest_bytes
            or not dataset.manifest_sha256
        ):
            raise ManifestVerificationError("verified dataset lacks manifest provenance")
        try:
            if dataset.manifest_path.is_symlink():
                raise ManifestVerificationError("verified manifest became a symlink")
            current_manifest = dataset.manifest_path.read_bytes()
        except OSError as exc:
            raise ManifestVerificationError("verified manifest is no longer readable") from exc
        if (
            current_manifest != dataset.manifest_bytes
            or sha256(current_manifest).hexdigest() != dataset.manifest_sha256
        ):
            raise ManifestVerificationError("raw manifest changed after verification")
        for segment in dataset.segments:
            path = dataset.root / segment.relative_path
            try:
                if path.is_symlink():
                    raise ManifestVerificationError("verified segment became a symlink")
                current = path.read_bytes()
            except OSError as exc:
                raise ManifestVerificationError("verified segment is no longer readable") from exc
            if current != segment.raw_bytes or sha256(current).hexdigest() != segment.sha256:
                raise ManifestVerificationError("raw segment changed after verification")

    @classmethod
    def normalize_verified(
        cls,
        datasets: Sequence[VerifiedDataset],
        dataset_id: str,
        normalizer_commit: str,
        config: NormalizerConfig,
    ) -> NormalizedBuild:
        if not datasets:
            raise ValueError("at least one verified raw dataset is required")
        if not isinstance(config, NormalizerConfig):
            raise ValueError("config must be NormalizerConfig")
        if _SAFE_PART.fullmatch(dataset_id) is None or dataset_id in {".", ".."}:
            raise ValueError("dataset_id must be path-safe")
        input_dataset_ids = [item.dataset_id for item in datasets]
        if len(set(input_dataset_ids)) != len(input_dataset_ids):
            raise ManifestVerificationError("raw input dataset_id values must be unique")
        if _COMMIT.fullmatch(normalizer_commit) is None:
            raise ValueError("normalizer_commit must be a Git object ID or UNCOMMITTED")
        actual_commit, worktree_state, code_sha256 = _normalizer_repository_state()
        if normalizer_commit != actual_commit:
            raise ValueError(
                "normalizer_commit must equal the repository HEAD used for this build"
            )
        for dataset in datasets:
            cls._assert_current(dataset)
            if dataset.continuity != CONTINUITY:
                raise ManifestVerificationError("raw continuity cannot be upgraded")
            if dataset.source == "polymarket.rtds.binance":
                raw_config = json.loads(dataset.sanitized_config_json)
                scope = raw_config.get("transportScope")
                if scope == "all-symbols-quarantine" and not config.allow_binance_all_symbols_fallback:
                    raise ManifestVerificationError(
                        "all-symbols Binance fallback requires explicit normalized config"
                    )

        observations = sorted(
            (item for dataset in datasets for item in _raw_observations(dataset)),
            key=lambda item: (
                item.event.persist_time,
                item.dataset.dataset_id,
                item.segment_ordinal,
                item.line_ordinal,
                item.segment_sha256,
                item.event.event_id,
            ),
        )
        raw_event_fingerprints: dict[tuple[str, str], str] = {}
        for observation in observations:
            event = observation.event
            fingerprint = sha256(
                _canonical_json(event.to_mapping()).encode("utf-8")
            ).hexdigest()
            key = (event.source, event.event_id)
            prior = raw_event_fingerprints.setdefault(key, fingerprint)
            if prior != fingerprint:
                raise ManifestVerificationError(
                    "cross-manifest raw event_id has conflicting content"
                )
        records: list[NormalizedRecord] = []
        quarantines: list[QuarantineRecord] = []
        markets: dict[str, dict[str, Any]] = {}
        token_to_market: dict[str, str] = {}
        condition_to_market: dict[str, str] = {}
        slug_to_market: dict[str, str] = {}
        partition_to_market: dict[tuple[datetime, datetime], str] = {}
        pending_gamma_binding_claims: list[_PendingGammaBindingClaim] = []

        # Identity is normalized first only to establish explicit dependencies.  A fact enriched
        # by metadata receives max(raw persist, metadata visible) as visible_at, so this pass does
        # not make later metadata visible in an earlier point-in-time view.
        for observation in observations:
            event = observation.event
            if event.source != "polymarket.gamma" or event.parser_status != "parsed":
                continue
            result = discover_btc_five_minute_market(event.raw_payload)
            if not result.accepted or result.market is None or result.normalized_mapping is None:
                quarantines.append(_quarantine_from_event(observation, "INVALID_MARKET_IDENTITY"))
                continue
            market = result.market
            mapping = result.normalized_mapping
            subscription = json.loads(observation.dataset.subscription_json)
            subscription_slug = subscription.get("slug")
            binding_mismatch = bool(
                (event.market_id is not None and event.market_id != market.market_id)
                or (
                    event.condition_id is not None
                    and event.condition_id != market.condition_id
                )
                or event.asset_id is not None
                or subscription_slug != market.slug
            )
            if binding_mismatch:
                pending_gamma_binding_claims.append(
                    _PendingGammaBindingClaim(
                        observation=observation,
                        payload_market_id=market.market_id,
                        claimed_market_id=(
                            event.market_id
                            if event.market_id != market.market_id
                            else None
                        ),
                        claimed_condition_id=(
                            event.condition_id
                            if event.condition_id != market.condition_id
                            else None
                        ),
                        claimed_asset_id=event.asset_id,
                        claimed_slug=(
                            subscription_slug
                            if subscription_slug != market.slug
                            else None
                        ),
                    )
                )
                existing_binding_ids = {
                    existing_market_id
                    for existing_market_id in (
                        event.market_id if event.market_id in markets else None,
                        condition_to_market.get(event.condition_id),
                        slug_to_market.get(subscription_slug),
                    )
                    if existing_market_id is not None
                }
                for existing_market_id in sorted(existing_binding_ids):
                    quarantines.append(
                        _quarantine_from_event(
                            observation,
                            "GAMMA_IDENTITY_BINDING_MISMATCH",
                            market_id=existing_market_id,
                            dependency_lineage=(
                                markets[existing_market_id]["lineage"],
                            ),
                        )
                    )
                quarantines.append(
                    _quarantine_from_event(
                        observation,
                        "GAMMA_IDENTITY_BINDING_MISMATCH",
                        market_id=market.market_id,
                        dependency_lineage=tuple(
                            markets[item]["lineage"]
                            for item in sorted(existing_binding_ids)
                        ),
                    )
                )
                continue
            conflicting_market_ids = {
                existing_market_id
                for existing_market_id in (
                    condition_to_market.get(market.condition_id),
                    slug_to_market.get(market.slug),
                    partition_to_market.get(
                        (market.interval_start, market.interval_end)
                    ),
                    *(
                        token_to_market.get(token.token_id)
                        for token in market.outcome_tokens
                    ),
                )
                if existing_market_id not in {None, market.market_id}
            }
            if conflicting_market_ids:
                for conflicting_market_id in sorted(conflicting_market_ids):
                    quarantines.append(
                        _quarantine_from_event(
                            observation,
                            "MARKET_IDENTITY_COLLISION",
                            market_id=conflicting_market_id,
                            dependency_lineage=(
                                markets[conflicting_market_id]["lineage"],
                            ),
                        )
                    )
                quarantines.append(
                    _quarantine_from_event(
                        observation,
                        "MARKET_IDENTITY_COLLISION",
                        market_id=market.market_id,
                        dependency_lineage=tuple(
                            markets[item]["lineage"]
                            for item in sorted(conflicting_market_ids)
                        ),
                    )
                )
                continue
            prior_identity = markets.get(market.market_id)
            if prior_identity is not None:
                prior_market = prior_identity["market"]
                if (
                    prior_market.condition_id != market.condition_id
                    or prior_market.slug != market.slug
                    or prior_market.interval_start != market.interval_start
                    or prior_market.interval_end != market.interval_end
                    or prior_market.oracle != market.oracle
                    or prior_market.outcome_tokens != market.outcome_tokens
                ):
                    quarantines.append(
                        _quarantine_from_event(
                            observation,
                            "MARKET_IDENTITY_REVISION_CONFLICT",
                            market_id=market.market_id,
                            dependency_lineage=(prior_identity["lineage"],),
                        )
                    )
                    continue
            else:
                # Identity fields define the immutable five-minute partition.  Later Gamma
                # observations may revise lifecycle metadata, but cannot rewrite this mapping.
                markets[market.market_id] = {
                    "market": market,
                    "mapping": mapping,
                    "visible_at": event.persist_time,
                    "lineage": observation.lineage,
                }
            condition_to_market.setdefault(market.condition_id, market.market_id)
            slug_to_market.setdefault(market.slug, market.market_id)
            partition_to_market.setdefault(
                (market.interval_start, market.interval_end),
                market.market_id,
            )
            for token in market.outcome_tokens:
                token_to_market.setdefault(token.token_id, market.market_id)
            records.append(
                _record_from_event(
                    observation,
                    record_type=RecordType.MARKET_METADATA,
                    business_key=f"market-metadata:{market.market_id}:{utc_iso(event.persist_time)}",
                    market_id=market.market_id,
                    condition_id=market.condition_id,
                    observed_at=event.persist_time,
                    valid_from=market.interval_start,
                    payload={
                        "slug": market.slug,
                        "interval_start": market.interval_start,
                        "interval_end": market.interval_end,
                        "oracle_provider": "Chainlink",
                        "oracle_pair": "BTC/USD",
                        "identity_valid": True,
                        "active": result.active,
                        "closed": result.closed,
                        "accepting_orders": result.accepting_orders,
                        "collectible": result.collectible,
                    },
                )
            )
            token_map = {token.outcome.value: token.token_id for token in market.outcome_tokens}
            records.append(
                _record_from_event(
                    observation,
                    record_type=RecordType.OUTCOME_TOKEN_MAPPING,
                    business_key=f"token-mapping:{market.market_id}:{utc_iso(event.persist_time)}",
                    market_id=market.market_id,
                    condition_id=market.condition_id,
                    observed_at=event.persist_time,
                    valid_from=market.interval_start,
                    payload={
                        "up_token_id": token_map["up"],
                        "down_token_id": token_map["down"],
                    },
                )
            )

        # A malformed Gamma envelope can claim an identity that is only learned from a later
        # manifest. Resolve those claims after the identity pass, but lift their visibility to
        # the later identity dependency. This prevents a future market from escaping a prior
        # binding quarantine without leaking that future identity into an earlier view.
        for claim in pending_gamma_binding_claims:
            claimed_market_ids = {
                item
                for item in (
                    (
                        claim.claimed_market_id
                        if claim.claimed_market_id in markets
                        else None
                    ),
                    condition_to_market.get(claim.claimed_condition_id),
                    token_to_market.get(claim.claimed_asset_id),
                    slug_to_market.get(claim.claimed_slug),
                )
                if item is not None and item != claim.payload_market_id
            }
            for claimed_market_id in sorted(claimed_market_ids):
                dependency = markets[claimed_market_id]
                quarantines.append(
                    _quarantine_from_event(
                        claim.observation,
                        "GAMMA_IDENTITY_BINDING_MISMATCH",
                        market_id=claimed_market_id,
                        visible_at=max(
                            claim.observation.event.persist_time,
                            dependency["visible_at"],
                        ),
                        dependency_lineage=(dependency["lineage"],),
                    )
                )

        connections: dict[tuple[str, str], str] = {}
        books: dict[tuple[str, str, str], _MutableBook] = {}

        def market_for_event(
            event: RawEventEnvelopeV1,
            payload: Mapping[str, Any] | None = None,
        ) -> str | None:
            claims: set[str] = set()
            invalid_claim = False

            def add_claim(value: Any, mapping: Mapping[str, str], *, present: bool) -> None:
                nonlocal invalid_claim
                if not present or value is None:
                    return
                if not isinstance(value, str) or value not in mapping:
                    invalid_claim = True
                    return
                claims.add(mapping[value])

            add_claim(
                event.market_id,
                {market_id: market_id for market_id in markets},
                present=event.market_id is not None,
            )
            add_claim(
                event.condition_id,
                condition_to_market,
                present=event.condition_id is not None,
            )
            add_claim(
                event.asset_id,
                token_to_market,
                present=event.asset_id is not None,
            )
            if payload is not None:
                add_claim(
                    payload.get("market"),
                    condition_to_market,
                    present="market" in payload,
                )
                add_claim(
                    payload.get("condition_id"),
                    condition_to_market,
                    present="condition_id" in payload,
                )
                add_claim(
                    payload.get("asset_id"),
                    token_to_market,
                    present="asset_id" in payload,
                )
            if invalid_claim or len(claims) != 1:
                return None
            return next(iter(claims))

        def subscription_market_for_observation(
            observation: _RawObservation,
        ) -> str | None:
            candidates = {
                token_to_market[asset]
                for asset in observation.dataset.asset_ids
                if asset in token_to_market
            }
            return next(iter(candidates)) if len(candidates) == 1 else None

        def classified_quarantine(
            observation: _RawObservation,
            reason_code: str,
            *,
            market_id: str | None,
            asset_id: str | None = None,
        ) -> QuarantineRecord:
            if market_id is None or market_id not in markets:
                return _quarantine_from_event(
                    observation,
                    reason_code,
                    market_id=market_id,
                    asset_id=asset_id,
                )
            dependency_visible = max(
                observation.event.persist_time,
                markets[market_id]["visible_at"],
            )
            return _quarantine_from_event(
                observation,
                reason_code,
                market_id=market_id,
                asset_id=asset_id,
                visible_at=dependency_visible,
                dependency_lineage=(markets[market_id]["lineage"],),
            )

        def reset_connection_for_market(
            observation: _RawObservation,
            market_id: str,
        ) -> None:
            event = observation.event
            market = markets[market_id]["market"]
            dependency_visible = max(
                event.persist_time,
                markets[market_id]["visible_at"],
            )
            connections[(event.connection_id, market_id)] = "RESET_REQUIRED"
            records.append(
                _record_from_event(
                    observation,
                    record_type=RecordType.CONNECTION_STATE,
                    business_key=(
                        f"connection:{event.connection_id}:reset:{event.event_id}"
                    ),
                    market_id=market_id,
                    condition_id=market.condition_id,
                    visible_at=dependency_visible,
                    payload={"state": "RESET_REQUIRED"},
                    dependency_lineage=(markets[market_id]["lineage"],),
                )
            )

        for observation in observations:
            event = observation.event
            if event.source == "polymarket.gamma":
                if event.parser_status != "parsed":
                    quarantines.append(_quarantine_from_event(observation, "RAW_PARSER_REJECTED"))
                continue
            if event.parser_status != "parsed":
                market_id = (
                    market_for_event(event)
                    or subscription_market_for_observation(observation)
                    if event.source == "polymarket.clob.market"
                    else None
                )
                quarantines.append(
                    classified_quarantine(
                        observation,
                        "RAW_PARSER_REJECTED",
                        market_id=market_id,
                    )
                )
                continue

            if event.source in {"polymarket.rtds.chainlink", "polymarket.rtds.binance"}:
                expected = "chainlink" if event.source.endswith("chainlink") else "binance"
                try:
                    parsed = parse_rtds_price(event.raw_payload, expected_source=expected)
                except (RawContractViolation, ValueError):
                    quarantines.append(_quarantine_from_event(observation, "INVALID_PRICE_OBSERVATION"))
                    continue
                if parsed.parser_status != "parsed" or parsed.value is None or parsed.source_time is None:
                    quarantines.append(_quarantine_from_event(observation, "OFF_TOPIC_PRICE_OBSERVATION"))
                    continue
                matches = [
                    item
                    for item in markets.values()
                    if item["market"].interval_start
                    <= parsed.source_time
                    < item["market"].interval_end
                ]
                if not matches:
                    quarantines.append(_quarantine_from_event(observation, "NO_MATCHING_MARKET_WINDOW"))
                    continue
                for item in matches:
                    market = item["market"]
                    visible_at = max(event.persist_time, item["visible_at"])
                    source_name = "chainlink" if expected == "chainlink" else "binance"
                    records.append(
                        _record_from_event(
                            observation,
                            record_type=(
                                RecordType.CHAINLINK_BTC_USD
                                if expected == "chainlink"
                                else RecordType.BINANCE_BTC_USDT
                            ),
                            business_key=(
                                f"{source_name}:{market.market_id}:{utc_iso(parsed.source_time)}"
                            ),
                            market_id=market.market_id,
                            condition_id=market.condition_id,
                            source_time=parsed.source_time,
                            server_time=parsed.server_time,
                            visible_at=visible_at,
                            payload={
                                "symbol": parsed.symbol,
                                "price": parsed.value,
                            },
                            dependency_lineage=(item["lineage"],),
                        )
                    )
                continue

            if event.source != "polymarket.clob.market":
                quarantines.append(_quarantine_from_event(observation, "UNSUPPORTED_RAW_SOURCE"))
                continue

            if event.event_type in _CLOB_AUDIT_EVENTS:
                try:
                    audit_payload = json.loads(event.raw_payload)
                except json.JSONDecodeError:
                    audit_payload = None
                audit_valid = bool(
                    isinstance(audit_payload, dict)
                    and set(audit_payload) == {"audit_event", "details"}
                    and audit_payload.get("audit_event") == event.event_type
                    and isinstance(audit_payload.get("details"), dict)
                )
                subscription_markets = {
                    token_to_market[asset]
                    for asset in observation.dataset.asset_ids
                    if asset in token_to_market
                }
                envelope_has_identity = any(
                    value is not None
                    for value in (event.market_id, event.condition_id, event.asset_id)
                )
                envelope_market = market_for_event(event)
                matching_markets = set(subscription_markets)
                if envelope_market is not None:
                    matching_markets.add(envelope_market)
                identity_invalid = (
                    (envelope_has_identity and envelope_market is None)
                    or len(matching_markets) != 1
                )
                if not audit_valid or identity_invalid:
                    targets = matching_markets or subscription_markets
                    reason = (
                        "INVALID_CONNECTION_AUDIT"
                        if not audit_valid
                        else "INCONSISTENT_CONNECTION_IDENTITY"
                    )
                    if targets:
                        for market_id in sorted(targets):
                            quarantines.append(
                                classified_quarantine(
                                    observation,
                                    reason,
                                    market_id=market_id,
                                )
                            )
                            reset_connection_for_market(observation, market_id)
                    else:
                        quarantines.append(
                            _quarantine_from_event(
                                observation,
                                reason,
                            )
                        )
                    continue
                if event.event_type in _CLOB_AUDIT_NOOPS:
                    continue
                state = _CLOB_AUDIT_STATES[event.event_type]
                for market_id in sorted(matching_markets):
                    market = markets[market_id]["market"]
                    if event.event_type == "connection_open":
                        for key in [
                            key
                            for key in books
                            if key[0] == event.connection_id and key[1] == market_id
                        ]:
                            del books[key]
                    connections[(event.connection_id, market_id)] = state
                    dependency_visible = max(
                        event.persist_time,
                        markets[market_id]["visible_at"],
                    )
                    records.append(
                        _record_from_event(
                            observation,
                            record_type=RecordType.CONNECTION_STATE,
                            business_key=f"connection:{event.connection_id}:{event.event_id}",
                            market_id=market_id,
                            condition_id=market.condition_id,
                            visible_at=dependency_visible,
                            payload={"state": state},
                            dependency_lineage=(markets[market_id]["lineage"],),
                        )
                    )
                    if state != "CONNECTED":
                        records.append(
                            _record_from_event(
                                observation,
                                record_type=RecordType.QUALITY_INTERVAL,
                                business_key=f"quality:{event.connection_id}:{event.event_id}",
                                market_id=market_id,
                                condition_id=market.condition_id,
                                visible_at=dependency_visible,
                                observed_at=event.persist_time,
                                valid_from=event.persist_time,
                                payload={
                                    "quality_state": state,
                                    "interval_start": event.persist_time,
                                    "interval_end": None,
                                },
                                dependency_lineage=(markets[market_id]["lineage"],),
                            )
                        )
                continue

            try:
                decoded = json.loads(event.raw_payload)
            except json.JSONDecodeError:
                market_id = (
                    market_for_event(event)
                    or subscription_market_for_observation(observation)
                )
                quarantines.append(
                    classified_quarantine(
                        observation,
                        "INVALID_CLOB_JSON",
                        market_id=market_id,
                    )
                )
                if market_id is not None:
                    reset_connection_for_market(observation, market_id)
                continue
            messages = decoded if isinstance(decoded, list) else [decoded]
            for message_ordinal, message in enumerate(messages):
                observation = replace(
                    observation,
                    message_ordinal=message_ordinal,
                )
                if not isinstance(message, dict):
                    market_id = (
                        market_for_event(event)
                        or subscription_market_for_observation(observation)
                    )
                    quarantines.append(
                        classified_quarantine(
                            observation,
                            "INVALID_CLOB_MESSAGE",
                            market_id=market_id,
                        )
                    )
                    if market_id is not None:
                        reset_connection_for_market(observation, market_id)
                    continue
                event_type = message.get("event_type")
                market_id = market_for_event(event, message)
                if market_id is None:
                    fallback_market_id = (
                        market_for_event(event)
                        or subscription_market_for_observation(observation)
                    )
                    quarantines.append(
                        classified_quarantine(
                            observation,
                            "UNKNOWN_MARKET_IDENTITY",
                            market_id=fallback_market_id,
                        )
                    )
                    if fallback_market_id is not None:
                        reset_connection_for_market(observation, fallback_market_id)
                    continue
                market = markets[market_id]["market"]
                dependency_visible = max(event.persist_time, markets[market_id]["visible_at"])
                if connections.get((event.connection_id, market_id)) != "CONNECTED":
                    quarantines.append(
                        classified_quarantine(
                            observation,
                            "BOOK_EVENT_WITHOUT_ACTIVE_CONNECTION",
                            market_id=market_id,
                        )
                    )
                    continue
                if event_type == "book":
                    asset_id = message.get("asset_id")
                    if not isinstance(asset_id, str) or token_to_market.get(asset_id) != market_id:
                        quarantines.append(
                            classified_quarantine(
                                observation, "UNKNOWN_OUTCOME_TOKEN", market_id=market_id
                            )
                        )
                        reset_connection_for_market(observation, market_id)
                        continue
                    try:
                        bid_levels = dict(_levels(message.get("bids"), "bids"))
                        ask_levels = dict(_levels(message.get("asks"), "asks"))
                    except ValueError:
                        quarantines.append(
                            classified_quarantine(
                                observation,
                                "INVALID_BOOK_SNAPSHOT",
                                market_id=market_id,
                                asset_id=asset_id,
                            )
                        )
                        reset_connection_for_market(observation, market_id)
                        continue
                    if bid_levels and ask_levels and max(bid_levels) > min(ask_levels):
                        quarantines.append(
                            classified_quarantine(
                                observation,
                                "CROSSED_BOOK",
                                market_id=market_id,
                                asset_id=asset_id,
                            )
                        )
                        reset_connection_for_market(observation, market_id)
                        continue
                    key = (event.connection_id, market_id, asset_id)
                    books[key] = _MutableBook(bids=bid_levels, asks=ask_levels)
                    source_key = message.get("hash") or message.get("timestamp") or event.raw_sha256
                    records.append(
                        _record_from_event(
                            observation,
                            record_type=RecordType.CLOB_BOOK_STATE,
                            business_key=f"clob-book:{event.connection_id}:{asset_id}:{source_key}",
                            market_id=market_id,
                            condition_id=market.condition_id,
                            asset_id=asset_id,
                            visible_at=dependency_visible,
                            payload={
                                "bids": [
                                    {"price": format(price, "f"), "size": format(size, "f")}
                                    for price, size in sorted(bid_levels.items(), reverse=True)
                                ],
                                "asks": [
                                    {"price": format(price, "f"), "size": format(size, "f")}
                                    for price, size in sorted(ask_levels.items())
                                ],
                                "snapshot_received": True,
                                "provider_timestamp_raw": message.get("timestamp"),
                            },
                            dependency_lineage=(markets[market_id]["lineage"],),
                        )
                    )
                elif event_type == "price_change":
                    changes = message.get("price_changes")
                    if not isinstance(changes, list) or not changes:
                        quarantines.append(
                            classified_quarantine(
                                observation, "INVALID_BOOK_DELTA", market_id=market_id
                            )
                        )
                        reset_connection_for_market(observation, market_id)
                        continue
                    staged: dict[str, _MutableBook] = {}
                    failed = False
                    try:
                        for change in changes:
                            if not isinstance(change, dict):
                                raise ValueError("delta must be an object")
                            asset_id = change.get("asset_id")
                            if not isinstance(asset_id, str) or token_to_market.get(asset_id) != market_id:
                                raise ValueError("unknown outcome token")
                            current = books.get((event.connection_id, market_id, asset_id))
                            if current is None:
                                raise ValueError("delta before current snapshot")
                            staged.setdefault(
                                asset_id,
                                _MutableBook(bids=dict(current.bids), asks=dict(current.asks)),
                            )
                            price = _decimal(change.get("price"), "delta.price")
                            size = _decimal(change.get("size"), "delta.size")
                            side = change.get("side")
                            if price < 0 or price > 1 or size < 0 or side not in {"BUY", "SELL"}:
                                raise ValueError("invalid delta")
                            levels = staged[asset_id].bids if side == "BUY" else staged[asset_id].asks
                            if size == 0:
                                levels.pop(price, None)
                            else:
                                levels[price] = size
                        for asset_id, staged_book in staged.items():
                            if (
                                staged_book.bids
                                and staged_book.asks
                                and max(staged_book.bids) > min(staged_book.asks)
                            ):
                                raise ValueError("crossed delta")
                    except ValueError:
                        failed = True
                    if failed:
                        affected_assets = {
                            change.get("asset_id")
                            for change in changes
                            if isinstance(change, dict)
                            and isinstance(change.get("asset_id"), str)
                        }
                        if not affected_assets:
                            affected_assets = {None}
                        for affected_asset in affected_assets:
                            quarantines.append(
                                classified_quarantine(
                                    observation,
                                    "INVALID_BOOK_DELTA",
                                    market_id=market_id,
                                    asset_id=affected_asset,
                                )
                            )
                        reset_connection_for_market(observation, market_id)
                        continue
                    for asset_id, staged_book in sorted(staged.items()):
                        books[(event.connection_id, market_id, asset_id)] = staged_book
                        source_key = message.get("timestamp") or event.raw_sha256
                        records.append(
                            _record_from_event(
                                observation,
                                record_type=RecordType.CLOB_BOOK_STATE,
                                business_key=f"clob-book:{event.connection_id}:{asset_id}:{source_key}",
                                market_id=market_id,
                                condition_id=market.condition_id,
                                asset_id=asset_id,
                                visible_at=dependency_visible,
                                payload={
                                    "bids": [
                                        {"price": format(price, "f"), "size": format(size, "f")}
                                        for price, size in sorted(staged_book.bids.items(), reverse=True)
                                    ],
                                    "asks": [
                                        {"price": format(price, "f"), "size": format(size, "f")}
                                        for price, size in sorted(staged_book.asks.items())
                                    ],
                                    "snapshot_received": True,
                                    "provider_timestamp_raw": message.get("timestamp"),
                                },
                                dependency_lineage=(markets[market_id]["lineage"],),
                            )
                        )
                else:
                    quarantines.append(
                        classified_quarantine(
                            observation, "UNSUPPORTED_NORMALIZED_CLOB_EVENT", market_id=market_id
                        )
                    )
                    reset_connection_for_market(observation, market_id)

        canonical, conflicts = canonicalize_records(records)
        all_quarantines = tuple(
            sorted(
                {*quarantines, *conflicts},
                key=lambda item: (item.visible_at, item.quarantine_id),
            )
        )
        return cls._assemble(
            dataset_id=dataset_id,
            normalizer_commit=normalizer_commit,
            normalizer_code_sha256=code_sha256,
            normalizer_worktree_state=worktree_state,
            config=config,
            inputs=datasets,
            records=canonical,
            quarantines=all_quarantines,
        )

    @staticmethod
    def _assemble(
        *,
        dataset_id: str,
        normalizer_commit: str,
        normalizer_code_sha256: str,
        normalizer_worktree_state: str,
        config: NormalizerConfig,
        inputs: Sequence[VerifiedDataset],
        records: Sequence[NormalizedRecord],
        quarantines: Sequence[QuarantineRecord],
    ) -> NormalizedBuild:
        records_bytes = b"".join((item.to_json_line() + "\n").encode("utf-8") for item in records)
        quarantine_bytes = b"".join(
            (item.to_json_line() + "\n").encode("utf-8") for item in quarantines
        )
        raw_inputs = [
            {
                "dataset_id": item.dataset_id,
                "manifest_sha256": item.manifest_sha256,
                "source": item.source,
                "stream": item.stream,
                "collector_git_commit": item.collector_git_commit,
                "continuity": item.continuity,
                "subscription": json.loads(item.subscription_json),
                "sanitized_config": json.loads(item.sanitized_config_json),
                "segments": [
                    {
                        "ordinal": segment.ordinal,
                        "relative_path": segment.relative_path,
                        "sha256": segment.sha256,
                    }
                    for segment in item.segments
                ],
            }
            for item in sorted(inputs, key=lambda candidate: (candidate.dataset_id, candidate.manifest_sha256))
        ]
        source_times = [item.source_time for item in records if item.source_time is not None]
        visible_times = [
            *(item.visible_at for item in records),
            *(item.visible_at for item in quarantines),
        ]
        row_counts: dict[str, int] = {}
        for item in records:
            row_counts[item.record_type.value] = row_counts.get(item.record_type.value, 0) + 1
        quality_counts: dict[str, int] = {}
        for item in quarantines:
            quality_counts[item.reason_code] = quality_counts.get(item.reason_code, 0) + 1
        outputs = {
            "records.jsonl": {
                "sha256": sha256(records_bytes).hexdigest(),
                "byte_count": len(records_bytes),
                "row_count": len(records),
            },
            "quarantine.jsonl": {
                "sha256": sha256(quarantine_bytes).hexdigest(),
                "byte_count": len(quarantine_bytes),
                "row_count": len(quarantines),
            },
        }
        core = {
            "schema_version": NORMALIZED_MANIFEST_VERSION,
            "normalized_schema_version": NORMALIZED_SCHEMA_VERSION,
            "dataset_id": dataset_id,
            "continuity": CONTINUITY,
            "normalizer_git_commit": normalizer_commit,
            "normalizer_code_sha256": normalizer_code_sha256,
            "normalizer_worktree_state": normalizer_worktree_state,
            "config": config.to_mapping(),
            "raw_inputs": raw_inputs,
            "row_counts": dict(sorted(row_counts.items())),
            "quarantine_count": len(quarantines),
            "quality_counts": dict(sorted(quality_counts.items())),
            "min_source_time": utc_iso(min(source_times)) if source_times else None,
            "max_source_time": utc_iso(max(source_times)) if source_times else None,
            "min_visible_at": utc_iso(min(visible_times)) if visible_times else None,
            "max_visible_at": utc_iso(max(visible_times)) if visible_times else None,
            "outputs": outputs,
        }
        dataset_hash = sha256(_canonical_json(core).encode("utf-8")).hexdigest()
        manifest = {**core, "dataset_hash": dataset_hash}
        manifest_bytes = (_canonical_json(manifest) + "\n").encode("utf-8")
        return NormalizedBuild(
            dataset_id=dataset_id,
            dataset_hash=dataset_hash,
            records=tuple(records),
            quarantines=tuple(quarantines),
            records_bytes=records_bytes,
            quarantine_bytes=quarantine_bytes,
            manifest=manifest,
            manifest_bytes=manifest_bytes,
            _proof=_BUILD_PROOF,
        )

    @staticmethod
    def _reject_unsupported_root(data_root: Path) -> Path:
        absolute = data_root.absolute()
        if _DRVFS_ROOT.match(str(absolute)):
            raise DatasetPublicationError("DrvFS paths are unsupported; use a Linux-native filesystem")
        current = absolute
        while current != current.parent:
            if current.exists() and current.is_symlink():
                raise DatasetPublicationError("normalized data root must not traverse symlinks")
            current = current.parent
        if _mount_filesystem_type(absolute) in _WINDOWS_BACKED_FILESYSTEMS:
            raise DatasetPublicationError(
                "DrvFS/Windows-backed filesystems are unsupported; use a Linux-native filesystem"
            )
        return absolute

    @staticmethod
    def _validate_build_artifact(build: NormalizedBuild) -> None:
        """Revalidate the complete in-memory artifact immediately before publication."""

        records_bytes = b"".join(
            (item.to_json_line() + "\n").encode("utf-8") for item in build.records
        )
        quarantine_bytes = b"".join(
            (item.to_json_line() + "\n").encode("utf-8")
            for item in build.quarantines
        )
        if records_bytes != build.records_bytes or quarantine_bytes != build.quarantine_bytes:
            raise DatasetPublicationError("normalized build rows changed after assembly")
        if not isinstance(build.manifest, dict) or set(build.manifest) != _NORMALIZED_MANIFEST_FIELDS:
            raise DatasetPublicationError("normalized build manifest fields are invalid")
        expected_manifest_bytes = (
            _canonical_json(build.manifest) + "\n"
        ).encode("utf-8")
        if expected_manifest_bytes != build.manifest_bytes:
            raise DatasetPublicationError("normalized build manifest changed after assembly")
        if build.manifest.get("dataset_id") != build.dataset_id:
            raise DatasetPublicationError("normalized build dataset_id mismatch")
        if build.manifest.get("dataset_hash") != build.dataset_hash:
            raise DatasetPublicationError("normalized build dataset_hash mismatch")
        if _SHA256.fullmatch(build.dataset_hash) is None:
            raise DatasetPublicationError("normalized build dataset_hash is invalid")
        core = {
            key: value
            for key, value in build.manifest.items()
            if key != "dataset_hash"
        }
        if sha256(_canonical_json(core).encode("utf-8")).hexdigest() != build.dataset_hash:
            raise DatasetPublicationError("normalized build manifest hash mismatch")
        expected_outputs = {
            "records.jsonl": {
                "sha256": sha256(records_bytes).hexdigest(),
                "byte_count": len(records_bytes),
                "row_count": len(build.records),
            },
            "quarantine.jsonl": {
                "sha256": sha256(quarantine_bytes).hexdigest(),
                "byte_count": len(quarantine_bytes),
                "row_count": len(build.quarantines),
            },
        }
        if build.manifest.get("outputs") != expected_outputs:
            raise DatasetPublicationError("normalized build output inventory mismatch")

    @classmethod
    def publish(cls, build: NormalizedBuild, poly_data_root: Path) -> Path:
        if not isinstance(build, NormalizedBuild) or build._proof is not _BUILD_PROOF:
            raise DatasetPublicationError("publish requires a verified normalized build")
        cls._validate_build_artifact(build)
        root = cls._reject_unsupported_root(poly_data_root)
        normalized_root = root / "normalized"
        dataset_root = normalized_root / f"dataset_id={build.dataset_id}"
        destination = dataset_root / f"version={build.dataset_hash}"
        normalized_root.mkdir(parents=True, exist_ok=True)
        dataset_root.mkdir(parents=True, exist_ok=True)
        cls._reject_unsupported_root(dataset_root)
        if os.path.lexists(destination):
            raise DatasetPublicationError("completed normalized dataset version already exists")
        lock_path = dataset_root / ".single-writer.lock"
        try:
            lock_fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError as exc:
            raise DatasetPublicationError("another single writer is active") from exc
        temporary: Path | None = None
        try:
            temporary = Path(tempfile.mkdtemp(prefix=".partial-", dir=dataset_root))
            os.write(lock_fd, f"pid={os.getpid()}\n".encode("ascii"))
            os.fsync(lock_fd)
            for name, content in (
                ("records.jsonl", build.records_bytes),
                ("quarantine.jsonl", build.quarantine_bytes),
                ("manifest.json", build.manifest_bytes),
            ):
                path = temporary / name
                with path.open("xb") as handle:
                    handle.write(content)
                    handle.flush()
                    os.fsync(handle.fileno())
            directory_fd = os.open(temporary, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
            if os.path.lexists(destination):
                raise DatasetPublicationError("completed normalized dataset version already exists")
            _rename_no_replace(temporary, destination)
            parent_fd = os.open(dataset_root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(parent_fd)
            finally:
                os.close(parent_fd)
            return destination
        except DatasetPublicationError:
            raise
        except OSError as exc:
            raise DatasetPublicationError("normalized dataset atomic publication failed") from exc
        finally:
            os.close(lock_fd)
            try:
                lock_path.unlink()
            except FileNotFoundError:
                pass
            if temporary is not None and temporary.exists():
                shutil.rmtree(temporary)

    @classmethod
    def load(cls, version_directory: Path) -> PointInTimeDataset:
        directory = cls._reject_unsupported_root(version_directory)
        try:
            if directory.is_symlink() or not directory.is_dir():
                raise DatasetPublicationError("normalized version must be a final directory")
            manifest_path = directory / "manifest.json"
            if manifest_path.is_symlink():
                raise DatasetPublicationError("normalized manifest must not be a symlink")
            manifest_bytes = manifest_path.read_bytes()
            manifest = json.loads(manifest_bytes.decode("utf-8"))
        except DatasetPublicationError:
            raise
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DatasetPublicationError("normalized manifest is unreadable") from exc
        if (
            not isinstance(manifest, dict)
            or set(manifest) != _NORMALIZED_MANIFEST_FIELDS
            or manifest.get("schema_version") != NORMALIZED_MANIFEST_VERSION
            or manifest.get("normalized_schema_version") != NORMALIZED_SCHEMA_VERSION
            or manifest.get("continuity") != CONTINUITY
        ):
            raise DatasetPublicationError("unsupported normalized manifest")
        if manifest_bytes != (_canonical_json(manifest) + "\n").encode("utf-8"):
            raise DatasetPublicationError("normalized manifest is not canonical JSON")
        dataset_hash = manifest.get("dataset_hash")
        if not isinstance(dataset_hash, str) or _SHA256.fullmatch(dataset_hash) is None:
            raise DatasetPublicationError("normalized dataset_hash is invalid")
        normalizer_commit = manifest.get("normalizer_git_commit")
        if not isinstance(normalizer_commit, str) or _COMMIT.fullmatch(normalizer_commit) is None:
            raise DatasetPublicationError("normalized normalizer_git_commit is invalid")
        normalizer_code_sha256 = manifest.get("normalizer_code_sha256")
        if (
            not isinstance(normalizer_code_sha256, str)
            or _SHA256.fullmatch(normalizer_code_sha256) is None
        ):
            raise DatasetPublicationError("normalized normalizer_code_sha256 is invalid")
        if manifest.get("normalizer_worktree_state") not in {"CLEAN", "DIRTY"}:
            raise DatasetPublicationError("normalized normalizer_worktree_state is invalid")
        core = {key: value for key, value in manifest.items() if key != "dataset_hash"}
        if sha256(_canonical_json(core).encode("utf-8")).hexdigest() != dataset_hash:
            raise DatasetPublicationError("normalized manifest hash mismatch")
        if directory.name != f"version={dataset_hash}":
            raise DatasetPublicationError("normalized version directory does not match dataset_hash")
        outputs = manifest.get("outputs")
        if not isinstance(outputs, dict) or set(outputs) != {
            "records.jsonl",
            "quarantine.jsonl",
        }:
            raise DatasetPublicationError("normalized output inventory is missing")
        loaded: dict[str, bytes] = {}
        for name in ("records.jsonl", "quarantine.jsonl"):
            expected = outputs.get(name)
            if not isinstance(expected, dict) or set(expected) != {
                "sha256",
                "byte_count",
                "row_count",
            }:
                raise DatasetPublicationError("normalized output inventory is incomplete")
            try:
                output_path = directory / name
                if output_path.is_symlink():
                    raise DatasetPublicationError("normalized output must not be a symlink")
                content = output_path.read_bytes()
            except DatasetPublicationError:
                raise
            except OSError as exc:
                raise DatasetPublicationError("normalized output is unreadable") from exc
            if (
                sha256(content).hexdigest() != expected.get("sha256")
                or len(content) != expected.get("byte_count")
            ):
                raise DatasetPublicationError("normalized output checksum or byte count mismatch")
            loaded[name] = content

        def lines(content: bytes) -> list[str]:
            if not content:
                return []
            if not content.endswith(b"\n"):
                raise DatasetPublicationError("normalized JSONL must end with LF")
            try:
                return content[:-1].decode("utf-8").split("\n")
            except UnicodeDecodeError as exc:
                raise DatasetPublicationError("normalized JSONL must be UTF-8") from exc

        try:
            records = tuple(
                NormalizedRecord.from_json_line(line) for line in lines(loaded["records.jsonl"])
            )
            quarantines = tuple(
                QuarantineRecord.from_json_line(line)
                for line in lines(loaded["quarantine.jsonl"])
            )
        except ValueError as exc:
            raise DatasetPublicationError("normalized output contract validation failed") from exc
        if len(records) != outputs["records.jsonl"].get("row_count"):
            raise DatasetPublicationError("normalized record row count mismatch")
        if len(quarantines) != outputs["quarantine.jsonl"].get("row_count"):
            raise DatasetPublicationError("normalized quarantine row count mismatch")
        computed_rows: dict[str, int] = {}
        for record in records:
            computed_rows[record.record_type.value] = (
                computed_rows.get(record.record_type.value, 0) + 1
            )
        computed_quality: dict[str, int] = {}
        for quarantine in quarantines:
            computed_quality[quarantine.reason_code] = (
                computed_quality.get(quarantine.reason_code, 0) + 1
            )
        if manifest.get("row_counts") != dict(sorted(computed_rows.items())):
            raise DatasetPublicationError("normalized manifest row_counts mismatch")
        if manifest.get("quarantine_count") != len(quarantines):
            raise DatasetPublicationError("normalized manifest quarantine_count mismatch")
        if manifest.get("quality_counts") != dict(sorted(computed_quality.items())):
            raise DatasetPublicationError("normalized manifest quality_counts mismatch")
        source_times = [record.source_time for record in records if record.source_time is not None]
        visible_times = [
            *(record.visible_at for record in records),
            *(quarantine.visible_at for quarantine in quarantines),
        ]
        expected_ranges = {
            "min_source_time": utc_iso(min(source_times)) if source_times else None,
            "max_source_time": utc_iso(max(source_times)) if source_times else None,
            "min_visible_at": utc_iso(min(visible_times)) if visible_times else None,
            "max_visible_at": utc_iso(max(visible_times)) if visible_times else None,
        }
        if any(manifest.get(key) != value for key, value in expected_ranges.items()):
            raise DatasetPublicationError("normalized manifest time range mismatch")
        raw_inputs = manifest.get("raw_inputs")
        if not isinstance(raw_inputs, list) or not raw_inputs:
            raise DatasetPublicationError("normalized raw input provenance is missing")
        allowed_lineage = {
            (
                item.get("dataset_id"),
                item.get("manifest_sha256"),
                segment.get("sha256"),
                segment.get("ordinal"),
            )
            for item in raw_inputs
            if isinstance(item, dict)
            for segment in item.get("segments", [])
            if isinstance(segment, dict)
        }
        for lineage in (
            item
            for record in records
            for item in (*record.lineage, *record.dependency_lineage)
        ):
            if (
                lineage.source_manifest_id,
                lineage.source_manifest_sha256,
                lineage.segment_sha256,
                lineage.segment_ordinal,
            ) not in allowed_lineage:
                raise DatasetPublicationError("normalized record lineage is absent from raw_inputs")
        for lineage in (
            item
            for quarantine in quarantines
            for item in (*quarantine.lineage, *quarantine.dependency_lineage)
        ):
            if (
                lineage.source_manifest_id,
                lineage.source_manifest_sha256,
                lineage.segment_sha256,
                lineage.segment_ordinal,
            ) not in allowed_lineage:
                raise DatasetPublicationError("normalized quarantine lineage is absent from raw_inputs")
        config = manifest.get("config")
        if not isinstance(config, dict) or set(config) != {
            "book_stale_after_ms",
            "binance_default_transport_scope",
            "allow_binance_all_symbols_fallback",
            "storage_coordination",
            "supported_filesystem",
        }:
            raise DatasetPublicationError("normalized config is missing")
        stale_ms = config.get("book_stale_after_ms")
        if isinstance(stale_ms, bool) or not isinstance(stale_ms, int) or stale_ms <= 0:
            raise DatasetPublicationError("normalized stale configuration is invalid")
        if (
            config.get("binance_default_transport_scope") != "btc-only"
            or not isinstance(config.get("allow_binance_all_symbols_fallback"), bool)
            or config.get("storage_coordination") != "single-writer"
            or config.get("supported_filesystem") != "linux-native"
        ):
            raise DatasetPublicationError("normalized configuration contract is invalid")
        return PointInTimeDataset(
            records,
            quarantines=quarantines,
            stale_after=timedelta(milliseconds=stale_ms),
            dataset_hash=dataset_hash,
        )
