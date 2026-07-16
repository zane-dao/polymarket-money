"""Deterministic quality summary for a manifest-verified public raw dataset."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
import json
from typing import Any, Iterable

from .raw_events import AnyRawEventEnvelope
from .replay import RawReplay, VerifiedDataset


CONTINUITY_LIMITATION = (
    "The source exposes no documented sequence cursor; the report can prove only that all "
    "received events were preserved, not that no upstream packet was lost."
)


def _wall_delta_ms(later: datetime, earlier: datetime) -> int:
    return round((later - earlier).total_seconds() * 1_000)


def _distribution(values: list[int]) -> dict[str, int] | None:
    if not values:
        return None
    ordered = sorted(values)
    p50 = ordered[(len(ordered) - 1) * 50 // 100]
    p95 = ordered[(len(ordered) - 1) * 95 // 100]
    return {"min": ordered[0], "p50": p50, "p95": p95, "max": ordered[-1]}


def _decimal(value: Any) -> Decimal:
    if isinstance(value, Decimal):
        result = value
    elif isinstance(value, str):
        try:
            result = Decimal(value)
        except InvalidOperation as exc:
            raise ValueError("invalid decimal") from exc
    else:
        raise ValueError("numeric market data must remain a decimal string")
    if not result.is_finite():
        raise ValueError("non-finite decimal")
    return result


def _inspect_clob_payload(
    payload: dict[str, Any],
    event: AnyRawEventEnvelope,
    known_asset_ids: frozenset[str],
    books: dict[tuple[str, str], dict[str, dict[Decimal, Decimal]]],
) -> tuple[int, int, int, int, int]:
    unknown_tokens = missing_snapshots = crossed = invalid = empty = 0
    event_type = payload.get("event_type")
    if event_type == "book":
        asset_id = payload.get("asset_id")
        if not isinstance(asset_id, str):
            return (0, 0, 0, 1, 0)
        if known_asset_ids and asset_id not in known_asset_ids:
            unknown_tokens += 1
        bids = payload.get("bids")
        asks = payload.get("asks")
        if not isinstance(bids, list) or not isinstance(asks, list):
            return (unknown_tokens, 0, 0, 1, 0)
        if not bids or not asks:
            empty += 1
        try:
            bid_levels: dict[Decimal, Decimal] = {}
            ask_levels: dict[Decimal, Decimal] = {}
            for level in [*bids, *asks]:
                if not isinstance(level, dict):
                    raise ValueError("invalid level")
                price = _decimal(level.get("price"))
                quantity = _decimal(level.get("size"))
                if price < 0 or price > 1 or quantity <= 0:
                    raise ValueError("illegal price or quantity")
            for level in bids:
                if not isinstance(level, dict):
                    raise ValueError("invalid bid level")
                bid_levels[_decimal(level["price"])] = _decimal(level["size"])
            for level in asks:
                if not isinstance(level, dict):
                    raise ValueError("invalid ask level")
                ask_levels[_decimal(level["price"])] = _decimal(level["size"])
            books[(event.connection_id, asset_id)] = {
                "BUY": bid_levels,
                "SELL": ask_levels,
            }
            if bid_levels and ask_levels and max(bid_levels) > min(ask_levels):
                crossed += 1
        except (KeyError, ValueError):
            invalid += 1
    elif event_type == "price_change" and isinstance(payload.get("price_changes"), list):
        for change in payload["price_changes"]:
            if not isinstance(change, dict) or not isinstance(change.get("asset_id"), str):
                invalid += 1
                continue
            asset_id = change["asset_id"]
            if known_asset_ids and asset_id not in known_asset_ids:
                unknown_tokens += 1
            book = books.get((event.connection_id, asset_id))
            if book is None:
                missing_snapshots += 1
                continue
            try:
                price = _decimal(change.get("price"))
                quantity = _decimal(change.get("size"))
                side = change.get("side")
                if price < 0 or price > 1 or quantity < 0 or side not in {"BUY", "SELL"}:
                    raise ValueError("illegal delta")
                levels = book[side]
                if quantity == 0:
                    levels.pop(price, None)
                else:
                    levels[price] = quantity
            except (KeyError, ValueError):
                invalid += 1
                continue
            bids = book["BUY"]
            asks = book["SELL"]
            if not bids or not asks:
                empty += 1
            if bids and asks and max(bids) > min(asks):
                crossed += 1
    return unknown_tokens, missing_snapshots, crossed, invalid, empty


@dataclass(frozen=True, slots=True)
class DataQualityReport:
    total_events: int
    event_type_counts: dict[str, int]
    parser_status_counts: dict[str, int]
    parse_success_rate: str
    unknown_event_count: int
    duplicate_raw_hash_count: int
    duplicate_event_id_count: int
    provider_source_to_local_wall_delta_ms: dict[str, int] | None
    provider_server_to_local_wall_delta_ms: dict[str, int] | None
    source_time_reversal_count: int
    missing_source_time_count: int
    market_identity_failure_count: int
    symbol_quarantine_count: int
    unknown_token_count: int
    unknown_token_evaluation: str
    missing_initial_snapshot_count: int
    reconnect_count: int
    stale_count: int
    crossed_book_count: int
    best_bid_greater_than_ask_count: int
    invalid_price_or_quantity_count: int
    empty_book_count: int
    segment_checksum_verified: bool
    manifest_consistent: bool
    verified_dataset_id: str | None
    continuity: str
    continuity_limitation: str

    def to_mapping(self) -> dict[str, Any]:
        return {field: getattr(self, field) for field in self.__dataclass_fields__}


def build_data_quality_report(
    events: Iterable[AnyRawEventEnvelope],
    *,
    known_asset_ids: frozenset[str] = frozenset(),
) -> DataQualityReport:
    return _build_data_quality_report(
        events,
        known_asset_ids=known_asset_ids,
        segment_checksum_verified=False,
        manifest_consistent=False,
        verified_dataset_id=None,
    )


def build_verified_data_quality_report(
    dataset: VerifiedDataset,
    *,
    known_asset_ids: frozenset[str] | None = None,
) -> DataQualityReport:
    """Build a quality report whose integrity flags derive from a verifier proof."""

    evaluated_asset_ids = dataset.asset_ids if known_asset_ids is None else known_asset_ids
    return _build_data_quality_report(
        RawReplay.iter_raw(dataset),
        known_asset_ids=evaluated_asset_ids,
        segment_checksum_verified=True,
        manifest_consistent=True,
        verified_dataset_id=dataset.dataset_id,
    )


def _build_data_quality_report(
    events: Iterable[AnyRawEventEnvelope],
    *,
    known_asset_ids: frozenset[str],
    segment_checksum_verified: bool,
    manifest_consistent: bool,
    verified_dataset_id: str | None,
) -> DataQualityReport:
    materialized = list(events)
    event_types = Counter(event.event_type for event in materialized)
    parser_statuses = Counter(event.parser_status for event in materialized)
    raw_hashes = Counter(event.raw_sha256 for event in materialized)
    event_ids = Counter(event.event_id for event in materialized)
    provider_source_wall_deltas: list[int] = []
    provider_server_wall_deltas: list[int] = []
    missing_source = 0
    reversals = 0
    last_source_time: dict[tuple[str, str, str | None], datetime] = {}
    books: dict[tuple[str, str], dict[str, dict[Decimal, Decimal]]] = {}
    unknown_tokens = missing_snapshots = crossed = invalid = empty = 0
    for event in materialized:
        if event.source_time is None:
            missing_source += 1
        else:
            provider_source_wall_deltas.append(
                _wall_delta_ms(event.receive_time, event.source_time)
            )
            key = (event.source, event.stream, event.asset_id)
            prior = last_source_time.get(key)
            if prior is not None and event.source_time < prior:
                reversals += 1
            last_source_time[key] = event.source_time
        if event.server_time is not None:
            provider_server_wall_deltas.append(
                _wall_delta_ms(event.receive_time, event.server_time)
            )
        if (
            event.source != "polymarket.clob.market"
            and event.asset_id is not None
            and known_asset_ids
            and event.asset_id not in known_asset_ids
        ):
            unknown_tokens += 1
        if event.source != "polymarket.clob.market":
            continue
        try:
            decoded = json.loads(event.raw_payload, parse_float=Decimal, parse_int=Decimal)
        except json.JSONDecodeError:
            continue
        payloads = decoded if isinstance(decoded, list) else [decoded]
        for payload in payloads:
            if not isinstance(payload, dict):
                continue
            observed = _inspect_clob_payload(payload, event, known_asset_ids, books)
            unknown_tokens += observed[0]
            missing_snapshots += observed[1]
            crossed += observed[2]
            invalid += observed[3]
            empty += observed[4]

    total = len(materialized)
    parsed = parser_statuses.get("parsed", 0)
    success_rate = "0" if total == 0 else str((Decimal(parsed) / Decimal(total)).quantize(Decimal("0.000001")))
    return DataQualityReport(
        total_events=total,
        event_type_counts=dict(sorted(event_types.items())),
        parser_status_counts=dict(sorted(parser_statuses.items())),
        parse_success_rate=success_rate,
        unknown_event_count=parser_statuses.get("unparsed", 0),
        duplicate_raw_hash_count=sum(count - 1 for count in raw_hashes.values() if count > 1),
        duplicate_event_id_count=sum(count - 1 for count in event_ids.values() if count > 1),
        provider_source_to_local_wall_delta_ms=_distribution(
            provider_source_wall_deltas
        ),
        provider_server_to_local_wall_delta_ms=_distribution(
            provider_server_wall_deltas
        ),
        source_time_reversal_count=reversals,
        missing_source_time_count=missing_source,
        market_identity_failure_count=sum(
            event.source == "polymarket.gamma"
            and event.parser_status in {"error", "quarantined"}
            for event in materialized
        ),
        symbol_quarantine_count=sum(
            event.source.startswith("polymarket.rtds.")
            and event.parser_status == "quarantined"
            for event in materialized
        ),
        unknown_token_count=unknown_tokens,
        unknown_token_evaluation="EVALUATED" if known_asset_ids else "NOT_EVALUATED",
        missing_initial_snapshot_count=missing_snapshots,
        reconnect_count=event_types.get("connection_open", 0) - min(event_types.get("connection_open", 0), 1),
        stale_count=event_types.get("connection_stale", 0),
        crossed_book_count=crossed,
        best_bid_greater_than_ask_count=crossed,
        invalid_price_or_quantity_count=invalid,
        empty_book_count=empty,
        segment_checksum_verified=segment_checksum_verified,
        manifest_consistent=manifest_consistent,
        verified_dataset_id=verified_dataset_id,
        continuity="UNVERIFIED",
        continuity_limitation=CONTINUITY_LIMITATION,
    )
