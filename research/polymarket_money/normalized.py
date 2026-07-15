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
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import shutil
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
_PARSER_STATES = frozenset({"parsed", "unparsed", "error", "quarantined"})


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

    def __post_init__(self) -> None:
        _require_text(self.source_manifest_id, "source_manifest_id")
        _require_digest(self.source_manifest_sha256, "source_manifest_sha256")
        _require_digest(self.segment_sha256, "segment_sha256")
        _require_text(self.event_id, "event_id")
        _require_digest(self.raw_sha256, "raw_sha256")
        _require_utc(self.visible_at, "lineage.visible_at")

    def to_mapping(self) -> dict[str, Any]:
        return {
            "source_manifest_id": self.source_manifest_id,
            "source_manifest_sha256": self.source_manifest_sha256,
            "segment_sha256": self.segment_sha256,
            "event_id": self.event_id,
            "raw_sha256": self.raw_sha256,
            "visible_at": utc_iso(self.visible_at),
        }

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "RawLineage":
        expected = {
            "source_manifest_id",
            "source_manifest_sha256",
            "segment_sha256",
            "event_id",
            "raw_sha256",
            "visible_at",
        }
        if set(value) != expected:
            raise ValueError("raw lineage fields do not match normalized-record-v1")
        return cls(
            source_manifest_id=value["source_manifest_id"],
            source_manifest_sha256=value["source_manifest_sha256"],
            segment_sha256=value["segment_sha256"],
            event_id=value["event_id"],
            raw_sha256=value["raw_sha256"],
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
        if continuity != CONTINUITY:
            raise ValueError("public normalized continuity must remain UNVERIFIED")
        if parser_state not in _PARSER_STATES:
            raise ValueError("invalid parser_state")
        if not lineage:
            raise ValueError("normalized records require raw lineage")
        ordered_lineage = tuple(
            sorted(
                set(lineage),
                key=lambda item: (
                    item.visible_at,
                    item.source_manifest_id,
                    item.segment_sha256,
                    item.event_id,
                    item.raw_sha256,
                ),
            )
        )
        if min(item.visible_at for item in ordered_lineage) < persist_time:
            raise ValueError("raw lineage visibility cannot precede record persistence")
        if visible_at != min(item.visible_at for item in ordered_lineage):
            raise ValueError("visible_at must equal the earliest usable lineage time")
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
        if not isinstance(lineages, list):
            raise ValueError("raw_lineage must be a list")
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
        )

    def with_lineage(self, lineage: Sequence[RawLineage]) -> "NormalizedRecord":
        combined = tuple(set((*self.lineage, *lineage)))
        earliest = min(combined, key=lambda item: item.visible_at)
        return replace(
            self,
            visible_at=min(self.visible_at, earliest.visible_at),
            lineage=tuple(
                sorted(
                    combined,
                    key=lambda item: (
                        item.visible_at,
                        item.source_manifest_id,
                        item.segment_sha256,
                        item.event_id,
                        item.raw_sha256,
                    ),
                )
            ),
        )

    def at_time(self, decision_time: datetime) -> "NormalizedRecord":
        visible_lineage = tuple(item for item in self.lineage if item.visible_at <= decision_time)
        if not visible_lineage:
            raise ValueError("record has no lineage visible at decision_time")
        return replace(self, lineage=visible_lineage)


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
    ) -> "QuarantineRecord":
        _require_text(reason_code, "reason_code")
        _require_text(business_key, "business_key")
        _require_utc(visible_at, "visible_at")
        ordered_ids = tuple(sorted(set(affected_record_ids)))
        ordered_lineage = tuple(
            sorted(
                set(lineage),
                key=lambda item: (
                    item.visible_at,
                    item.source_manifest_id,
                    item.segment_sha256,
                    item.event_id,
                ),
            )
        )
        if not ordered_lineage:
            raise ValueError("quarantine requires raw lineage")
        identity = {
            "reason_code": reason_code,
            "business_key": business_key,
            "market_id": market_id,
            "asset_id": asset_id,
            "visible_at": utc_iso(visible_at),
            "affected_record_ids": ordered_ids,
            "raw_lineage": [item.to_mapping() for item in ordered_lineage],
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
        }

    def to_json_line(self) -> str:
        return _canonical_json(self.to_mapping())

    def at_time(self, decision_time: datetime) -> "QuarantineRecord":
        visible_lineage = tuple(item for item in self.lineage if item.visible_at <= decision_time)
        if not visible_lineage:
            raise ValueError("quarantine has no lineage visible at decision_time")
        return replace(self, lineage=visible_lineage)

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
        result = cls.create(
            reason_code=value["reason_code"],
            business_key=value["business_key"],
            market_id=value["market_id"],
            asset_id=value["asset_id"],
            visible_at=_parse_time(value["visible_at"], "visible_at"),
            affected_record_ids=value["affected_record_ids"],
            lineage=tuple(RawLineage.from_mapping(item) for item in value["raw_lineage"]),
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
                item.lineage[0].source_manifest_id,
                item.lineage[0].segment_sha256,
                item.lineage[0].event_id,
            ),
        )
        baseline_id = ordered[0].record_id
        same = [item for item in ordered if item.record_id == baseline_id]
        conflicts = [item for item in ordered if item.record_id != baseline_id]
        merged = same[0]
        for duplicate in same[1:]:
            merged = merged.with_lineage(duplicate.lineage)
        canonical.append(merged)
        for conflict in conflicts:
            causal_baseline_lineage = tuple(
                item for item in merged.lineage if item.visible_at <= conflict.visible_at
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
                item.record_id,
            ),
        )

    def as_of(self, decision_time: datetime, market_id: str) -> PointInTimeView:
        _require_utc(decision_time, "decision_time")
        _require_text(market_id, "market_id")
        visible_quarantine = tuple(
            item.at_time(decision_time)
            for item in self._quarantines
            if item.visible_at <= decision_time and item.market_id in {None, market_id}
        )
        market_quarantine = any(
            item.market_id == market_id and item.asset_id is None
            for item in visible_quarantine
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
        latest_connection = self._latest(
            item for item in visible if item.record_type is RecordType.CONNECTION_STATE
        )
        connection_state = (
            latest_connection.payload.get("state") if latest_connection is not None else "DISCONNECTED"
        )
        connection_id = latest_connection.connection_id if latest_connection is not None else None
        books: dict[str, BookView] = {}
        for asset_id in sorted(set(token_by_outcome.values())):
            candidates = [
                item
                for item in visible
                if item.record_type is RecordType.CLOB_BOOK_STATE
                and item.asset_id == asset_id
                and item.connection_id == connection_id
            ]
            latest_book = self._latest(candidates)
            relevant_quarantine = market_quarantine or any(
                item.asset_id == asset_id
                or (latest_book is not None and item.business_key == latest_book.business_key)
                for item in visible_quarantine
            )
            state = BookState.DISCONNECTED
            bids: tuple[tuple[Decimal, Decimal], ...] = ()
            asks: tuple[tuple[Decimal, Decimal], ...] = ()
            lineage_count = 0
            if connection_state == "RESET_REQUIRED" or relevant_quarantine:
                state = BookState.RESET_REQUIRED
            elif connection_state == "STALE":
                state = BookState.STALE
            elif connection_state != "CONNECTED":
                state = BookState.DISCONNECTED
            elif latest_book is None:
                state = BookState.WAITING_FOR_SNAPSHOT
            elif latest_book.payload.get("snapshot_received") is not True:
                state = BookState.WAITING_FOR_SNAPSHOT
            else:
                lineage_count = latest_book.duplicate_count
                try:
                    bids = _levels(latest_book.payload.get("bids"), "bids")
                    asks = _levels(latest_book.payload.get("asks"), "asks")
                except ValueError:
                    state = BookState.RESET_REQUIRED
                else:
                    crossed = bool(bids and asks and bids[0][0] > asks[0][0])
                    if crossed:
                        state = BookState.RESET_REQUIRED
                    elif decision_time - latest_book.receive_time >= self._stale_after:
                        state = BookState.STALE
                    else:
                        state = BookState.ACTIVE_UNVERIFIED
            best_bid = bids[0][0] if bids else None
            best_ask = asks[0][0] if asks else None
            midpoint = (
                (best_bid + best_ask) / Decimal(2)
                if best_bid is not None and best_ask is not None
                else None
            )
            execution_eligible = bool(
                state is BookState.ACTIVE_UNVERIFIED
                and best_bid is not None
                and best_ask is not None
                and metadata is not None
                and metadata.get("identity_valid") is True
                and mapping_record is not None
            )
            books[asset_id] = BookView(
                asset_id=asset_id,
                state=state,
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
            record = self._latest(item for item in visible if item.record_type is record_type)
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


@dataclass(frozen=True, slots=True)
class _RawObservation:
    dataset: VerifiedDataset
    segment_sha256: str
    event: RawEventEnvelopeV1

    @property
    def lineage(self) -> RawLineage:
        return RawLineage(
            source_manifest_id=self.dataset.dataset_id,
            source_manifest_sha256=self.dataset.manifest_sha256,
            segment_sha256=self.segment_sha256,
            event_id=self.event.event_id,
            raw_sha256=self.event.raw_sha256,
            visible_at=self.event.persist_time,
        )


@dataclass(slots=True)
class _MutableBook:
    bids: dict[Decimal, Decimal]
    asks: dict[Decimal, Decimal]


def _raw_observations(dataset: VerifiedDataset) -> list[_RawObservation]:
    RawReplay._assert_verified(dataset)
    result: list[_RawObservation] = []
    for segment in sorted(dataset.segments, key=lambda item: item.ordinal):
        text = segment.raw_bytes.decode("utf-8")
        for line in text[:-1].split("\n"):
            result.append(
                _RawObservation(
                    dataset=dataset,
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
    )


def _quarantine_from_event(
    observation: _RawObservation,
    reason_code: str,
    *,
    business_key: str | None = None,
    market_id: str | None = None,
    asset_id: str | None = None,
) -> QuarantineRecord:
    event = observation.event
    return QuarantineRecord.create(
        reason_code=reason_code,
        business_key=business_key or f"raw:{event.event_id}",
        market_id=market_id if market_id is not None else event.market_id,
        asset_id=asset_id if asset_id is not None else event.asset_id,
        visible_at=event.persist_time,
        affected_record_ids=(),
        lineage=(observation.lineage,),
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
        if _COMMIT.fullmatch(normalizer_commit) is None:
            raise ValueError("normalizer_commit must be a Git object ID or UNCOMMITTED")
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
                item.segment_sha256,
                item.event.event_id,
            ),
        )
        records: list[NormalizedRecord] = []
        quarantines: list[QuarantineRecord] = []
        markets: dict[str, dict[str, Any]] = {}
        token_to_market: dict[str, str] = {}
        condition_to_market: dict[str, str] = {}

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
                }
            condition_to_market[market.condition_id] = market.market_id
            for token in market.outcome_tokens:
                token_to_market[token.token_id] = market.market_id
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

        connections: dict[str, str] = {}
        books: dict[tuple[str, str, str], _MutableBook] = {}

        def market_for_event(event: RawEventEnvelopeV1, payload: Mapping[str, Any] | None = None) -> str | None:
            if event.market_id in markets:
                return event.market_id
            condition = event.condition_id
            asset = event.asset_id
            if payload is not None:
                raw_condition = payload.get("market", payload.get("condition_id"))
                raw_asset = payload.get("asset_id")
                if isinstance(raw_condition, str):
                    condition = raw_condition
                if isinstance(raw_asset, str):
                    asset = raw_asset
            if condition in condition_to_market:
                return condition_to_market[condition]
            if asset in token_to_market:
                return token_to_market[asset]
            return None

        for observation in observations:
            event = observation.event
            if event.source == "polymarket.gamma":
                if event.parser_status != "parsed":
                    quarantines.append(_quarantine_from_event(observation, "RAW_PARSER_REJECTED"))
                continue
            if event.parser_status != "parsed":
                quarantines.append(_quarantine_from_event(observation, "RAW_PARSER_REJECTED"))
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
                    <= item["market"].interval_end
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
                        )
                    )
                continue

            if event.source != "polymarket.clob.market":
                quarantines.append(_quarantine_from_event(observation, "UNSUPPORTED_RAW_SOURCE"))
                continue

            if event.event_type in {
                "connection_open",
                "connection_stale",
                "connection_error",
                "connection_closed_early",
                "capture_timeout",
            }:
                state = {
                    "connection_open": "CONNECTED",
                    "connection_stale": "STALE",
                    "connection_error": "DISCONNECTED",
                    "connection_closed_early": "DISCONNECTED",
                    "capture_timeout": "DISCONNECTED",
                }[event.event_type]
                connections[event.connection_id] = state
                matching_markets = {
                    token_to_market[asset]
                    for asset in observation.dataset.asset_ids
                    if asset in token_to_market
                }
                if event.market_id in markets:
                    matching_markets.add(event.market_id)
                for market_id in sorted(matching_markets):
                    market = markets[market_id]["market"]
                    records.append(
                        _record_from_event(
                            observation,
                            record_type=RecordType.CONNECTION_STATE,
                            business_key=f"connection:{event.connection_id}:{event.event_id}",
                            market_id=market_id,
                            condition_id=market.condition_id,
                            payload={"state": state},
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
                                observed_at=event.persist_time,
                                valid_from=event.persist_time,
                                payload={
                                    "quality_state": state,
                                    "interval_start": event.persist_time,
                                    "interval_end": None,
                                },
                            )
                        )
                continue

            try:
                decoded = json.loads(event.raw_payload)
            except json.JSONDecodeError:
                quarantines.append(_quarantine_from_event(observation, "INVALID_CLOB_JSON"))
                continue
            messages = decoded if isinstance(decoded, list) else [decoded]
            for message in messages:
                if not isinstance(message, dict):
                    quarantines.append(_quarantine_from_event(observation, "INVALID_CLOB_MESSAGE"))
                    continue
                event_type = message.get("event_type")
                market_id = market_for_event(event, message)
                if market_id is None:
                    quarantines.append(_quarantine_from_event(observation, "UNKNOWN_MARKET_IDENTITY"))
                    continue
                market = markets[market_id]["market"]
                dependency_visible = max(event.persist_time, markets[market_id]["visible_at"])
                if connections.get(event.connection_id) != "CONNECTED":
                    quarantines.append(
                        _quarantine_from_event(
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
                            _quarantine_from_event(
                                observation, "UNKNOWN_OUTCOME_TOKEN", market_id=market_id
                            )
                        )
                        continue
                    try:
                        bid_levels = dict(_levels(message.get("bids"), "bids"))
                        ask_levels = dict(_levels(message.get("asks"), "asks"))
                    except ValueError:
                        quarantines.append(
                            _quarantine_from_event(
                                observation,
                                "INVALID_BOOK_SNAPSHOT",
                                market_id=market_id,
                                asset_id=asset_id,
                            )
                        )
                        connections[event.connection_id] = "RESET_REQUIRED"
                        records.append(
                            _record_from_event(
                                observation,
                                record_type=RecordType.CONNECTION_STATE,
                                business_key=f"connection:{event.connection_id}:reset:{event.event_id}",
                                market_id=market_id,
                                condition_id=market.condition_id,
                                payload={"state": "RESET_REQUIRED"},
                            )
                        )
                        continue
                    if bid_levels and ask_levels and max(bid_levels) > min(ask_levels):
                        quarantines.append(
                            _quarantine_from_event(
                                observation,
                                "CROSSED_BOOK",
                                market_id=market_id,
                                asset_id=asset_id,
                            )
                        )
                        connections[event.connection_id] = "RESET_REQUIRED"
                        records.append(
                            _record_from_event(
                                observation,
                                record_type=RecordType.CONNECTION_STATE,
                                business_key=f"connection:{event.connection_id}:reset:{event.event_id}",
                                market_id=market_id,
                                condition_id=market.condition_id,
                                payload={"state": "RESET_REQUIRED"},
                            )
                        )
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
                            },
                        )
                    )
                elif event_type == "price_change":
                    changes = message.get("price_changes")
                    if not isinstance(changes, list) or not changes:
                        quarantines.append(
                            _quarantine_from_event(
                                observation, "INVALID_BOOK_DELTA", market_id=market_id
                            )
                        )
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
                                _quarantine_from_event(
                                    observation,
                                    "INVALID_BOOK_DELTA",
                                    market_id=market_id,
                                    asset_id=affected_asset,
                                )
                            )
                        connections[event.connection_id] = "RESET_REQUIRED"
                        records.append(
                            _record_from_event(
                                observation,
                                record_type=RecordType.CONNECTION_STATE,
                                business_key=f"connection:{event.connection_id}:reset:{event.event_id}",
                                market_id=market_id,
                                condition_id=market.condition_id,
                                payload={"state": "RESET_REQUIRED"},
                            )
                        )
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
                                },
                            )
                        )
                else:
                    quarantines.append(
                        _quarantine_from_event(
                            observation, "UNSUPPORTED_NORMALIZED_CLOB_EVENT", market_id=market_id
                        )
                    )

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
        return absolute

    @classmethod
    def publish(cls, build: NormalizedBuild, poly_data_root: Path) -> Path:
        root = cls._reject_unsupported_root(poly_data_root)
        normalized_root = root / "normalized"
        dataset_root = normalized_root / f"dataset_id={build.dataset_id}"
        destination = dataset_root / f"version={build.dataset_hash}"
        normalized_root.mkdir(parents=True, exist_ok=True)
        dataset_root.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            raise DatasetPublicationError("completed normalized dataset version already exists")
        lock_path = dataset_root / ".single-writer.lock"
        try:
            lock_fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError as exc:
            raise DatasetPublicationError("another single writer is active") from exc
        temporary = Path(tempfile.mkdtemp(prefix=".partial-", dir=dataset_root))
        try:
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
            if destination.exists():
                raise DatasetPublicationError("completed normalized dataset version already exists")
            os.rename(temporary, destination)
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
            if temporary.exists():
                shutil.rmtree(temporary)

    @classmethod
    def load(cls, version_directory: Path) -> PointInTimeDataset:
        directory = cls._reject_unsupported_root(version_directory)
        try:
            if directory.is_symlink() or not directory.is_dir():
                raise DatasetPublicationError("normalized version must be a final directory")
            manifest_bytes = (directory / "manifest.json").read_bytes()
            manifest = json.loads(manifest_bytes.decode("utf-8"))
        except DatasetPublicationError:
            raise
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DatasetPublicationError("normalized manifest is unreadable") from exc
        if not isinstance(manifest, dict) or manifest.get("schema_version") != NORMALIZED_MANIFEST_VERSION:
            raise DatasetPublicationError("unsupported normalized manifest")
        dataset_hash = manifest.get("dataset_hash")
        if not isinstance(dataset_hash, str) or _SHA256.fullmatch(dataset_hash) is None:
            raise DatasetPublicationError("normalized dataset_hash is invalid")
        core = {key: value for key, value in manifest.items() if key != "dataset_hash"}
        if sha256(_canonical_json(core).encode("utf-8")).hexdigest() != dataset_hash:
            raise DatasetPublicationError("normalized manifest hash mismatch")
        if directory.name != f"version={dataset_hash}":
            raise DatasetPublicationError("normalized version directory does not match dataset_hash")
        outputs = manifest.get("outputs")
        if not isinstance(outputs, dict):
            raise DatasetPublicationError("normalized output inventory is missing")
        loaded: dict[str, bytes] = {}
        for name in ("records.jsonl", "quarantine.jsonl"):
            expected = outputs.get(name)
            if not isinstance(expected, dict):
                raise DatasetPublicationError("normalized output inventory is incomplete")
            try:
                content = (directory / name).read_bytes()
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
        config = manifest.get("config")
        if not isinstance(config, dict):
            raise DatasetPublicationError("normalized config is missing")
        stale_ms = config.get("book_stale_after_ms")
        if isinstance(stale_ms, bool) or not isinstance(stale_ms, int) or stale_ms <= 0:
            raise DatasetPublicationError("normalized stale configuration is invalid")
        return PointInTimeDataset(
            records,
            quarantines=quarantines,
            stale_after=timedelta(milliseconds=stale_ms),
            dataset_hash=dataset_hash,
        )
