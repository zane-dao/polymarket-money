"""Language-neutral raw-event contract validation and offline RTDS parsing."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
import re
from typing import Any, Mapping


SCHEMA_VERSION = "raw-event-v1"
PARSER_STATUSES = frozenset({"parsed", "unparsed", "error", "quarantined"})
_CANONICAL_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
_WIRE_FIELDS = frozenset(
    {
        "schema_version",
        "event_id",
        "source",
        "stream",
        "event_type",
        "connection_id",
        "subscription_id",
        "market_id",
        "condition_id",
        "asset_id",
        "source_time",
        "server_time",
        "receive_time",
        "process_time",
        "persist_time",
        "source_sequence",
        "source_hash",
        "raw_payload",
        "raw_sha256",
        "parser_status",
        "parser_error",
    }
)


class RawContractViolation(ValueError):
    """A persisted record does not satisfy RawEventEnvelope v1."""


def _non_empty_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RawContractViolation(f"{field} must be a non-empty string")
    return value


def _nullable_string(value: Any, field: str) -> str | None:
    if value is None:
        return None
    return _non_empty_string(value, field)


def parse_utc_iso(value: Any, field: str) -> datetime:
    text = _non_empty_string(value, field)
    if _CANONICAL_UTC.fullmatch(text) is None:
        raise RawContractViolation(
            f"{field} must be canonical UTC YYYY-MM-DDTHH:mm:ss.SSSZ"
        )
    try:
        parsed = datetime.strptime(text, "%Y-%m-%dT%H:%M:%S.%fZ").replace(
            tzinfo=timezone.utc
        )
    except ValueError as exc:
        raise RawContractViolation(f"{field} is not a valid calendar timestamp") from exc
    return parsed


def _nullable_utc_iso(value: Any, field: str) -> datetime | None:
    return None if value is None else parse_utc_iso(value, field)


def utc_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass(frozen=True, slots=True)
class RawEventEnvelopeV1:
    schema_version: str
    event_id: str
    source: str
    stream: str
    event_type: str
    connection_id: str
    subscription_id: str
    market_id: str | None
    condition_id: str | None
    asset_id: str | None
    source_time: datetime | None
    server_time: datetime | None
    receive_time: datetime
    process_time: datetime
    persist_time: datetime
    source_sequence: str | None
    source_hash: str | None
    raw_payload: str
    raw_sha256: str
    parser_status: str
    parser_error: str | None

    @classmethod
    def from_json_line(cls, line: str) -> "RawEventEnvelopeV1":
        if not isinstance(line, str) or not line:
            raise RawContractViolation("JSONL record must not be empty")
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise RawContractViolation("JSONL record is not valid JSON") from exc
        if not isinstance(value, dict):
            raise RawContractViolation("JSONL record must be an object")
        return cls.from_mapping(value)

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "RawEventEnvelopeV1":
        fields = frozenset(value)
        missing = _WIRE_FIELDS - fields
        unknown = fields - _WIRE_FIELDS
        if missing:
            raise RawContractViolation(f"missing envelope fields: {sorted(missing)}")
        if unknown:
            raise RawContractViolation(f"unknown envelope fields: {sorted(unknown)}")

        schema_version = _non_empty_string(value["schema_version"], "schema_version")
        if schema_version != SCHEMA_VERSION:
            raise RawContractViolation(f"unsupported schema_version: {schema_version}")
        parser_status = _non_empty_string(value["parser_status"], "parser_status")
        if parser_status not in PARSER_STATUSES:
            raise RawContractViolation("invalid parser_status")
        parser_error = _nullable_string(value["parser_error"], "parser_error")
        if parser_status == "error" and parser_error is None:
            raise RawContractViolation("parser_error is required when parser_status=error")
        if parser_status != "error" and parser_error is not None:
            raise RawContractViolation("parser_error is only valid when parser_status=error")

        raw_payload = value["raw_payload"]
        if not isinstance(raw_payload, str):
            raise RawContractViolation("raw_payload must be the exact received string")
        raw_digest = _non_empty_string(value["raw_sha256"], "raw_sha256")
        if len(raw_digest) != 64 or any(ch not in "0123456789abcdef" for ch in raw_digest):
            raise RawContractViolation("raw_sha256 must be a lowercase SHA-256 hex digest")
        expected_digest = sha256(raw_payload.encode("utf-8")).hexdigest()
        if raw_digest != expected_digest:
            raise RawContractViolation("raw_sha256 does not match raw_payload bytes")

        receive_time = parse_utc_iso(value["receive_time"], "receive_time")
        process_time = parse_utc_iso(value["process_time"], "process_time")
        persist_time = parse_utc_iso(value["persist_time"], "persist_time")
        if process_time < receive_time:
            raise RawContractViolation("process_time must not precede receive_time")
        if persist_time < process_time:
            raise RawContractViolation("persist_time must not precede process_time")

        return cls(
            schema_version=schema_version,
            event_id=_non_empty_string(value["event_id"], "event_id"),
            source=_non_empty_string(value["source"], "source"),
            stream=_non_empty_string(value["stream"], "stream"),
            event_type=_non_empty_string(value["event_type"], "event_type"),
            connection_id=_non_empty_string(value["connection_id"], "connection_id"),
            subscription_id=_non_empty_string(value["subscription_id"], "subscription_id"),
            market_id=_nullable_string(value["market_id"], "market_id"),
            condition_id=_nullable_string(value["condition_id"], "condition_id"),
            asset_id=_nullable_string(value["asset_id"], "asset_id"),
            source_time=_nullable_utc_iso(value["source_time"], "source_time"),
            server_time=_nullable_utc_iso(value["server_time"], "server_time"),
            receive_time=receive_time,
            process_time=process_time,
            persist_time=persist_time,
            source_sequence=_nullable_string(value["source_sequence"], "source_sequence"),
            source_hash=_nullable_string(value["source_hash"], "source_hash"),
            raw_payload=raw_payload,
            raw_sha256=raw_digest,
            parser_status=parser_status,
            parser_error=parser_error,
        )

    def to_mapping(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "event_id": self.event_id,
            "source": self.source,
            "stream": self.stream,
            "event_type": self.event_type,
            "connection_id": self.connection_id,
            "subscription_id": self.subscription_id,
            "market_id": self.market_id,
            "condition_id": self.condition_id,
            "asset_id": self.asset_id,
            "source_time": utc_iso(self.source_time),
            "server_time": utc_iso(self.server_time),
            "receive_time": utc_iso(self.receive_time),
            "process_time": utc_iso(self.process_time),
            "persist_time": utc_iso(self.persist_time),
            "source_sequence": self.source_sequence,
            "source_hash": self.source_hash,
            "raw_payload": self.raw_payload,
            "raw_sha256": self.raw_sha256,
            "parser_status": self.parser_status,
            "parser_error": self.parser_error,
        }


@dataclass(frozen=True, slots=True)
class RtdsPriceObservation:
    source: str
    symbol: str | None
    value: Decimal | None
    source_time: datetime | None
    server_time: datetime | None
    parser_status: str
    raw_payload: str
    parser_error: str | None = None


def _milliseconds_to_utc(value: Any, field: str) -> datetime:
    if isinstance(value, bool):
        raise RawContractViolation(f"{field} must be Unix milliseconds")
    try:
        milliseconds = Decimal(value)
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise RawContractViolation(f"{field} must be Unix milliseconds") from exc
    if not milliseconds.is_finite() or milliseconds != milliseconds.to_integral_value():
        raise RawContractViolation(f"{field} must be integer Unix milliseconds")
    return datetime.fromtimestamp(int(milliseconds) / 1000, tz=timezone.utc)


def parse_rtds_price(raw_payload: str, *, expected_source: str) -> RtdsPriceObservation:
    """Parse public RTDS crypto data without converting price through binary float."""

    if expected_source not in {"chainlink", "binance"}:
        raise ValueError("expected_source must be chainlink or binance")
    try:
        message = json.loads(raw_payload, parse_float=Decimal, parse_int=Decimal)
    except json.JSONDecodeError as exc:
        raise RawContractViolation("RTDS payload is not valid JSON") from exc
    if not isinstance(message, dict) or not isinstance(message.get("payload"), dict):
        raise RawContractViolation("RTDS payload must contain a payload object")
    payload = message["payload"]
    expected_topic = "crypto_prices_chainlink" if expected_source == "chainlink" else "crypto_prices"
    expected_symbol = "btc/usd" if expected_source == "chainlink" else "btcusdt"
    topic = message.get("topic")
    message_type = message.get("type")
    symbol = payload.get("symbol")
    reasons: list[str] = []
    if topic != expected_topic:
        reasons.append(f"unexpected topic {topic!r}")
    if message_type != "update":
        reasons.append(f"unexpected message type {message_type!r}")
    if symbol != expected_symbol:
        reasons.append(f"unexpected symbol {symbol!r}")
    if reasons:
        value = payload.get("value")
        return RtdsPriceObservation(
            source=expected_source,
            symbol=symbol if isinstance(symbol, str) else None,
            value=value if isinstance(value, Decimal) and value.is_finite() else None,
            source_time=(
                _milliseconds_to_utc(payload.get("timestamp"), "payload.timestamp")
                if payload.get("timestamp") is not None
                else None
            ),
            server_time=(
                _milliseconds_to_utc(message.get("timestamp"), "timestamp")
                if message.get("timestamp") is not None
                else None
            ),
            parser_status="quarantined",
            raw_payload=raw_payload,
            parser_error="; ".join(reasons),
        )
    value = payload.get("value")
    if not isinstance(value, Decimal) or not value.is_finite() or value <= 0:
        raise RawContractViolation("RTDS value must be a positive Decimal")
    return RtdsPriceObservation(
        source=expected_source,
        symbol=str(symbol),
        value=value,
        source_time=_milliseconds_to_utc(payload.get("timestamp"), "payload.timestamp"),
        server_time=_milliseconds_to_utc(message.get("timestamp"), "timestamp"),
        parser_status="parsed",
        raw_payload=raw_payload,
        parser_error=None,
    )
