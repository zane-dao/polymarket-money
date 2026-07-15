from __future__ import annotations

from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from pathlib import Path
import subprocess

from research.polymarket_money.normalized import NormalizedDatasetBuilder, NormalizerConfig
from research.polymarket_money.raw_events import RawEventEnvelopeV1
from tests.replay.test_normalized_dataset import verified_events


UTC = timezone.utc
PUBLISHED_START = datetime(2026, 7, 15, 0, 0, tzinfo=UTC)
PUBLISHED_END = PUBLISHED_START + timedelta(minutes=5)
PUBLISHED_UP = "3001"
PUBLISHED_DOWN = "3002"


def _iso(value: datetime) -> str:
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def raw_at(
    *,
    source: str,
    stream: str,
    event_type: str,
    event_id: str,
    raw_payload: str,
    receive_time: datetime,
    connection_id: str,
    market_id: str | None = None,
    condition_id: str | None = None,
    asset_id: str | None = None,
) -> RawEventEnvelopeV1:
    return RawEventEnvelopeV1.from_mapping(
        {
            "schema_version": "raw-event-v1",
            "event_id": event_id,
            "source": source,
            "stream": stream,
            "event_type": event_type,
            "connection_id": connection_id,
            "subscription_id": f"subscription-{source}",
            "market_id": market_id,
            "condition_id": condition_id,
            "asset_id": asset_id,
            "source_time": None,
            "server_time": None,
            "receive_time": _iso(receive_time),
            "process_time": _iso(receive_time + timedelta(milliseconds=1)),
            "persist_time": _iso(receive_time + timedelta(milliseconds=2)),
            "source_sequence": None,
            "source_hash": None,
            "raw_payload": raw_payload,
            "raw_sha256": sha256(raw_payload.encode("utf-8")).hexdigest(),
            "parser_status": "parsed",
            "parser_error": None,
        }
    )


def _book(asset_id: str, condition_id: str, bid: str, ask: str) -> str:
    return json.dumps(
        {
            "event_type": "book",
            "asset_id": asset_id,
            "market": condition_id,
            "bids": [{"price": bid, "size": "100"}],
            "asks": [{"price": ask, "size": "100"}],
            "timestamp": str(int(PUBLISHED_START.timestamp() * 1000)),
            "hash": f"book-{asset_id}-{bid}-{ask}",
        },
        separators=(",", ":"),
    )


def _chainlink(source_time: datetime, price: str) -> str:
    milliseconds = int(source_time.timestamp() * 1000)
    return (
        '{"topic":"crypto_prices_chainlink","type":"update",'
        f'"timestamp":{milliseconds + 1},"payload":{{"symbol":"btc/usd",'
        f'"timestamp":{milliseconds},"value":{price}}}}}'
    )


def publish_backtest_fixture(
    root: Path,
    *,
    market_id: str,
    initial_up_bid: str,
    initial_up_ask: str,
    initial_down_bid: str,
    initial_down_ask: str,
    open_price: str,
    close_price: str,
    updates: tuple[tuple[int, str, str, str], ...] = (),
) -> tuple[Path, str]:
    condition_id = "0x" + sha256(market_id.encode("utf-8")).hexdigest()
    gamma_template = json.loads(
        (Path(__file__).resolve().parents[2] / "data/fixtures/batch-2/gamma-btc-5m.json").read_text(
            encoding="utf-8"
        )
    )
    gamma_template.update(
        {
            "id": market_id,
            "conditionId": condition_id,
            "slug": f"btc-updown-5m-{int(PUBLISHED_START.timestamp())}",
            "eventStartTime": "2026-07-15T00:00:00Z",
            "endDate": "2026-07-15T00:05:00Z",
            "clobTokenIds": json.dumps([PUBLISHED_UP, PUBLISHED_DOWN]),
            "active": True,
            "closed": False,
            "acceptingOrders": True,
        }
    )
    gamma_payload = json.dumps(gamma_template, separators=(",", ":"))
    gamma_event = raw_at(
        source="polymarket.gamma",
        stream="market-by-slug",
        event_type="market_metadata",
        event_id=f"gamma-{market_id}",
        raw_payload=gamma_payload,
        receive_time=PUBLISHED_START + timedelta(milliseconds=10),
        connection_id=f"gamma-{market_id}",
        market_id=market_id,
        condition_id=condition_id,
    )
    audit_payload = json.dumps(
        {"audit_event": "connection_open", "details": {"public": True}},
        separators=(",", ":"),
    )
    clob_events = [
        raw_at(
            source="polymarket.clob.market",
            stream="market-channel",
            event_type="connection_open",
            event_id=f"open-{market_id}",
            raw_payload=audit_payload,
            receive_time=PUBLISHED_START + timedelta(milliseconds=20),
            connection_id=f"clob-{market_id}",
            market_id=market_id,
            condition_id=condition_id,
        ),
        raw_at(
            source="polymarket.clob.market",
            stream="market-channel",
            event_type="book",
            event_id=f"up-initial-{market_id}",
            raw_payload=_book(PUBLISHED_UP, condition_id, initial_up_bid, initial_up_ask),
            receive_time=PUBLISHED_START + timedelta(milliseconds=30),
            connection_id=f"clob-{market_id}",
            market_id=market_id,
            condition_id=condition_id,
            asset_id=PUBLISHED_UP,
        ),
        raw_at(
            source="polymarket.clob.market",
            stream="market-channel",
            event_type="book",
            event_id=f"down-initial-{market_id}",
            raw_payload=_book(PUBLISHED_DOWN, condition_id, initial_down_bid, initial_down_ask),
            receive_time=PUBLISHED_START + timedelta(milliseconds=31),
            connection_id=f"clob-{market_id}",
            market_id=market_id,
            condition_id=condition_id,
            asset_id=PUBLISHED_DOWN,
        ),
    ]
    for ordinal, (milliseconds, asset_id, bid, ask) in enumerate(updates):
        clob_events.append(
            raw_at(
                source="polymarket.clob.market",
                stream="market-channel",
                event_type="book",
                event_id=f"update-{market_id}-{ordinal}",
                raw_payload=_book(asset_id, condition_id, bid, ask),
                receive_time=PUBLISHED_START + timedelta(milliseconds=milliseconds),
                connection_id=f"clob-{market_id}",
                market_id=market_id,
                condition_id=condition_id,
                asset_id=asset_id,
            )
        )
    chainlink_events = [
        raw_at(
            source="polymarket.rtds.chainlink",
            stream="crypto-prices-chainlink",
            event_type="crypto_price",
            event_id=f"chainlink-open-{market_id}",
            raw_payload=_chainlink(PUBLISHED_START, open_price),
            receive_time=PUBLISHED_START + timedelta(milliseconds=40),
            connection_id=f"chainlink-{market_id}",
        ),
        raw_at(
            source="polymarket.rtds.chainlink",
            stream="crypto-prices-chainlink",
            event_type="crypto_price",
            event_id=f"chainlink-close-{market_id}",
            raw_payload=_chainlink(PUBLISHED_END, close_price),
            receive_time=PUBLISHED_END + timedelta(milliseconds=10),
            connection_id=f"chainlink-{market_id}",
        ),
    ]
    raw_root = root / "raw"
    gamma = verified_events(
        raw_root,
        dataset_id=f"gamma-{market_id}",
        source="polymarket.gamma",
        stream="market-by-slug",
        events=[gamma_event],
        subscription={"endpoint": "gamma-market-by-slug", "slug": gamma_template["slug"]},
        sanitized_config={"endpointClass": "public-read-only"},
    )
    clob = verified_events(
        raw_root,
        dataset_id=f"clob-{market_id}",
        source="polymarket.clob.market",
        stream="market-channel",
        events=clob_events,
        subscription={
            "assets_ids": [PUBLISHED_UP, PUBLISHED_DOWN],
            "type": "market",
            "custom_feature_enabled": True,
        },
        sanitized_config={"endpointClass": "public-read-only", "customFeatures": True},
        declared_asset_ids=[PUBLISHED_UP, PUBLISHED_DOWN],
    )
    chainlink = verified_events(
        raw_root,
        dataset_id=f"chainlink-{market_id}",
        source="polymarket.rtds.chainlink",
        stream="crypto-prices-chainlink",
        events=chainlink_events,
        subscription={
            "action": "subscribe",
            "subscriptions": [
                {
                    "topic": "crypto_prices_chainlink",
                    "type": "*",
                    "filters": '{"symbol":"btc/usd"}',
                }
            ],
        },
        sanitized_config={"endpointClass": "public-read-only", "symbolFilter": "btc/usd"},
    )
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=Path(__file__).resolve().parents[2],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    build = NormalizedDatasetBuilder.normalize_verified(
        [gamma, clob, chainlink],
        f"normalized-{market_id}",
        commit,
        NormalizerConfig(book_stale_after_ms=300_000),
    )
    version = NormalizedDatasetBuilder.publish(build, root / "published")
    return version, build.dataset_hash
