from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal

from research.polymarket_money.domain import OrderIntent, Side
from research.polymarket_money.normalized import (
    NormalizedRecord,
    PointInTimeDataset,
    QuarantineRecord,
    RawLineage,
    RecordType,
)


UTC = timezone.utc
START = datetime(2026, 7, 16, 0, 0, tzinfo=UTC)
END = START + timedelta(minutes=5)
MARKET_ID = "fixture-market"
CONDITION_ID = "0x" + "1" * 64
UP_TOKEN = "1001"
DOWN_TOKEN = "1002"


def lineage(index: int, visible_at: datetime, *, manifest: str = "fixture-manifest") -> RawLineage:
    return RawLineage(
        source_manifest_id=manifest,
        source_manifest_sha256=f"{index + 1:064x}",
        segment_sha256=f"{index + 100:064x}",
        segment_ordinal=0,
        line_ordinal=index,
        message_ordinal=0,
        event_id=f"event-{manifest}-{index}",
        raw_sha256=f"{index + 200:064x}",
        raw_persist_time=visible_at,
        visible_at=visible_at,
    )


def record(
    record_type: RecordType,
    business_key: str,
    visible_at: datetime,
    payload: dict[str, object],
    *,
    index: int,
    market_id: str = MARKET_ID,
    asset_id: str | None = None,
    source_time: datetime | None = None,
    connection_id: str = "connection-1",
    valid_from: datetime | None = None,
    observed_at: datetime | None = None,
    manifest: str = "fixture-manifest",
) -> NormalizedRecord:
    return NormalizedRecord.create(
        record_type=record_type,
        business_key=business_key,
        market_id=market_id,
        condition_id=CONDITION_ID,
        asset_id=asset_id,
        source="fixture.public",
        source_time=source_time,
        server_time=None,
        receive_time=visible_at - timedelta(milliseconds=3),
        process_time=visible_at - timedelta(milliseconds=2),
        persist_time=visible_at - timedelta(milliseconds=1),
        visible_at=visible_at,
        continuity="UNVERIFIED",
        connection_id=connection_id,
        parser_state="parsed",
        observed_at=observed_at,
        valid_from=valid_from,
        payload=payload,
        lineage=(lineage(index, visible_at, manifest=manifest),),
    )


def base_records(
    *,
    connection_state: str = "CONNECTED",
    up_bids: tuple[tuple[str, str], ...] = (("0.48", "10"),),
    up_asks: tuple[tuple[str, str], ...] = (("0.52", "10"),),
    down_bids: tuple[tuple[str, str], ...] = (("0.47", "10"),),
    down_asks: tuple[tuple[str, str], ...] = (("0.53", "10"),),
    include_up_book: bool = True,
    include_down_book: bool = True,
) -> list[NormalizedRecord]:
    def levels(values: tuple[tuple[str, str], ...]) -> list[dict[str, str]]:
        return [{"price": price, "size": size} for price, size in values]

    records = [
        record(
            RecordType.MARKET_METADATA,
            "metadata",
            START + timedelta(milliseconds=10),
            {
                "slug": f"btc-updown-5m-{int(START.timestamp())}",
                "interval_start": START,
                "interval_end": END,
                "oracle_provider": "Chainlink",
                "oracle_pair": "BTC/USD",
                "identity_valid": True,
                "active": True,
                "closed": False,
                "accepting_orders": True,
                "collectible": True,
            },
            index=0,
            valid_from=START,
            observed_at=START + timedelta(milliseconds=10),
        ),
        record(
            RecordType.OUTCOME_TOKEN_MAPPING,
            "mapping",
            START + timedelta(milliseconds=20),
            {"up_token_id": UP_TOKEN, "down_token_id": DOWN_TOKEN},
            index=1,
            valid_from=START,
            observed_at=START + timedelta(milliseconds=20),
        ),
        record(
            RecordType.CONNECTION_STATE,
            "connection",
            START + timedelta(milliseconds=30),
            {"state": connection_state},
            index=2,
        ),
        record(
            RecordType.CHAINLINK_BTC_USD,
            "chainlink-open",
            START + timedelta(milliseconds=35),
            {"symbol": "btc/usd", "price": "60000"},
            index=3,
            source_time=START,
        ),
    ]
    if include_up_book:
        records.append(
            record(
                RecordType.CLOB_BOOK_STATE,
                "up-book",
                START + timedelta(milliseconds=40),
                {
                    "bids": levels(up_bids),
                    "asks": levels(up_asks),
                    "snapshot_received": True,
                    "provider_timestamp_raw": None,
                },
                index=4,
                asset_id=UP_TOKEN,
            )
        )
    if include_down_book:
        records.append(
            record(
                RecordType.CLOB_BOOK_STATE,
                "down-book",
                START + timedelta(milliseconds=41),
                {
                    "bids": levels(down_bids),
                    "asks": levels(down_asks),
                    "snapshot_received": True,
                    "provider_timestamp_raw": None,
                },
                index=5,
                asset_id=DOWN_TOKEN,
            )
        )
    records.append(
        record(
            RecordType.CHAINLINK_BTC_USD,
            "chainlink-close",
            END + timedelta(milliseconds=30),
            {"symbol": "btc/usd", "price": "60000"},
            index=6,
            source_time=END,
        )
    )
    return records


def dataset(
    *,
    stale_after: timedelta = timedelta(seconds=1),
    quarantines: tuple[QuarantineRecord, ...] = (),
    **kwargs: object,
) -> PointInTimeDataset:
    return PointInTimeDataset(
        base_records(**kwargs),
        quarantines=quarantines,
        stale_after=stale_after,
        dataset_hash="a" * 64,
    )


def intent(
    *,
    side: Side = Side.BUY,
    quantity: str = "2",
    limit_price: str = "1",
    decision_time: datetime = START + timedelta(milliseconds=100),
    token_id: str = UP_TOKEN,
) -> OrderIntent:
    return OrderIntent(
        intent_id=f"intent-{side.value}-{quantity}-{decision_time.isoformat()}",
        idempotency_key=f"key-{side.value}-{quantity}-{decision_time.isoformat()}",
        decision_id=f"decision-{side.value}-{decision_time.isoformat()}",
        market_id=MARKET_ID,
        token_id=token_id,
        side=side,
        limit_price=Decimal(limit_price),
        quantity=Decimal(quantity),
        decision_time=decision_time,
        order_send_time=None,
    )
