from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from hashlib import sha256
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import research.polymarket_money.normalized as normalized_module
from research.polymarket_money.normalized import (
    DatasetPublicationError,
    NormalizedBuild,
    NormalizedDatasetBuilder,
    NormalizerConfig,
    PointInTimeDataset,
)
from research.polymarket_money.raw_events import RawEventEnvelopeV1
from research.polymarket_money.replay import ManifestVerificationError, ManifestVerifier


ROOT = Path(__file__).resolve().parents[2]
GAMMA = ROOT / "data" / "fixtures" / "batch-2" / "gamma-btc-5m.json"
NORMALIZER_COMMIT = subprocess.run(
    ["git", "rev-parse", "HEAD"],
    cwd=ROOT,
    check=True,
    capture_output=True,
    text=True,
).stdout.strip()


def utc(milliseconds: int) -> datetime:
    return datetime(2026, 7, 15, 0, 0, 0, milliseconds * 1_000, tzinfo=timezone.utc)


def socket_audit_payload(event_type: str) -> str:
    return json.dumps(
        {"audit_event": event_type, "details": {"public": True}},
        separators=(",", ":"),
    )


def raw_gamma_event(*, event_id: str = "gamma-1", receive_ms: int = 100) -> RawEventEnvelopeV1:
    payload = GAMMA.read_text(encoding="utf-8")
    return RawEventEnvelopeV1.from_mapping(
        {
            "schema_version": "raw-event-v1",
            "event_id": event_id,
            "source": "polymarket.gamma",
            "stream": "market-by-slug",
            "event_type": "market_metadata",
            "connection_id": "gamma-http-1",
            "subscription_id": "gamma-subscription-1",
            "market_id": "1822773",
            "condition_id": "0x29789033e9636c68c85f55bc4731d6ffbe8f41d37caf0df655a383b626e29c23",
            "asset_id": None,
            "source_time": None,
            "server_time": None,
            "receive_time": f"2026-07-15T00:00:00.{receive_ms:03d}Z",
            "process_time": f"2026-07-15T00:00:00.{receive_ms + 10:03d}Z",
            "persist_time": f"2026-07-15T00:00:00.{receive_ms + 20:03d}Z",
            "source_sequence": None,
            "source_hash": None,
            "raw_payload": payload,
            "raw_sha256": sha256(payload.encode("utf-8")).hexdigest(),
            "parser_status": "parsed",
            "parser_error": None,
        }
    )


def verified_gamma(
    root: Path,
    *,
    event: RawEventEnvelopeV1 | None = None,
    dataset_id: str | None = None,
):
    envelope = event or raw_gamma_event()
    effective_dataset_id = dataset_id or f"gamma-{envelope.event_id}"
    line = json.dumps(envelope.to_mapping(), ensure_ascii=False, separators=(",", ":")) + "\n"
    raw = line.encode("utf-8")
    relative = Path("polymarket.gamma/2026-07-15/market-by-slug/segment-000.jsonl")
    segment = root / relative
    segment.parent.mkdir(parents=True, exist_ok=True)
    segment.write_bytes(raw)
    manifest = {
        "dataset_id": effective_dataset_id,
        "schema_version": "dataset-manifest-v1",
        "source": "polymarket.gamma",
        "stream": "market-by-slug",
        "subscription": {
            "endpoint": "gamma-market-by-slug",
            "slug": "btc-updown-5m-1775181000",
        },
        "collector_git_commit": "a" * 40,
        "collection_start": envelope.receive_time.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "collection_end": envelope.persist_time.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "segments": [
            {
                "ordinal": 0,
                "relative_path": str(relative),
                "sha256": sha256(raw).hexdigest(),
                "byte_count": len(raw),
                "event_count": 1,
                "parse_error_count": 0,
                "unknown_event_count": 0,
                "first_receive_time": envelope.receive_time.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "last_receive_time": envelope.receive_time.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            }
        ],
        "event_count": 1,
        "parse_error_count": 0,
        "unknown_event_count": 0,
        "first_receive_time": envelope.receive_time.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "last_receive_time": envelope.receive_time.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "market_ids": ["1822773"],
        "asset_ids": [],
        "continuity": "UNVERIFIED",
        "sanitized_config": {"endpointClass": "public-read-only"},
    }
    manifest_path = root / "manifests" / f"{effective_dataset_id}.manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
    return ManifestVerifier.verify(manifest_path, root), manifest_path, segment


def raw_event(
    *,
    source: str,
    stream: str,
    event_type: str,
    event_id: str,
    raw_payload: str,
    receive_ms: int,
    connection_id: str,
    market_id: str | None = None,
    condition_id: str | None = None,
    asset_id: str | None = None,
    parser_status: str = "parsed",
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
            "receive_time": f"2026-07-15T00:00:00.{receive_ms:03d}Z",
            "process_time": f"2026-07-15T00:00:00.{receive_ms + 10:03d}Z",
            "persist_time": f"2026-07-15T00:00:00.{receive_ms + 20:03d}Z",
            "source_sequence": None,
            "source_hash": None,
            "raw_payload": raw_payload,
            "raw_sha256": sha256(raw_payload.encode("utf-8")).hexdigest(),
            "parser_status": parser_status,
            "parser_error": None,
        }
    )


def verified_events(
    root: Path,
    *,
    dataset_id: str,
    source: str,
    stream: str,
    events: list[RawEventEnvelopeV1],
    subscription: dict[str, object],
    sanitized_config: dict[str, object],
    declared_asset_ids: list[str] | None = None,
):
    data = b"".join(
        (
            json.dumps(event.to_mapping(), ensure_ascii=False, separators=(",", ":"))
            + "\n"
        ).encode("utf-8")
        for event in events
    )
    relative = Path(source) / "2026-07-15" / stream / f"{dataset_id}.jsonl"
    segment = root / relative
    segment.parent.mkdir(parents=True, exist_ok=True)
    segment.write_bytes(data)
    receive_times = [
        event.receive_time.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        for event in events
    ]
    persist_times = [
        event.persist_time.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        for event in events
    ]
    market_ids = sorted({event.market_id for event in events if event.market_id is not None})
    asset_ids = sorted(
        {
            *(event.asset_id for event in events if event.asset_id is not None),
            *(declared_asset_ids or []),
        }
    )
    error_count = sum(event.parser_status == "error" for event in events)
    unknown_count = sum(event.parser_status == "unparsed" for event in events)
    manifest = {
        "dataset_id": dataset_id,
        "schema_version": "dataset-manifest-v1",
        "source": source,
        "stream": stream,
        "subscription": subscription,
        "collector_git_commit": "a" * 40,
        "collection_start": min(receive_times),
        "collection_end": max(persist_times),
        "segments": [
            {
                "ordinal": 0,
                "relative_path": str(relative),
                "sha256": sha256(data).hexdigest(),
                "byte_count": len(data),
                "event_count": len(events),
                "parse_error_count": error_count,
                "unknown_event_count": unknown_count,
                "first_receive_time": min(receive_times),
                "last_receive_time": max(receive_times),
            }
        ],
        "event_count": len(events),
        "parse_error_count": error_count,
        "unknown_event_count": unknown_count,
        "first_receive_time": min(receive_times),
        "last_receive_time": max(receive_times),
        "market_ids": market_ids,
        "asset_ids": asset_ids,
        "continuity": "UNVERIFIED",
        "sanitized_config": sanitized_config,
    }
    manifest_path = root / "manifests" / f"{dataset_id}.manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
    return ManifestVerifier.verify(manifest_path, root)


class NormalizedDatasetReplayTest(unittest.TestCase):
    def test_normalized_build_proof_cannot_be_forged(self) -> None:
        with self.assertRaisesRegex(DatasetPublicationError, "manifest-verified"):
            NormalizedBuild(
                dataset_id="forged",
                dataset_hash="0" * 64,
                records=(),
                quarantines=(),
                records_bytes=b"",
                quarantine_bytes=b"",
                manifest={},
                manifest_bytes=b"{}\n",
                _proof=object(),
            )

    def test_normalized_contract_schemas_are_valid_versioned_json(self) -> None:
        record_schema = json.loads(
            (ROOT / "contracts" / "normalized-record-v1.schema.json").read_text(encoding="utf-8")
        )
        manifest_schema = json.loads(
            (ROOT / "contracts" / "normalized-dataset-manifest-v1.schema.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(record_schema["$defs"]["fact"]["properties"]["continuity"]["const"], "UNVERIFIED")
        self.assertEqual(manifest_schema["properties"]["schema_version"]["const"], "normalized-dataset-manifest-v1")
        self.assertIn("normalizer_code_sha256", manifest_schema["required"])
        self.assertIn("normalizer_worktree_state", manifest_schema["required"])

    def test_verified_clob_and_chainlink_build_a_fail_closed_point_in_time_view(self) -> None:
        gamma_payload = json.loads(GAMMA.read_text(encoding="utf-8"))
        up_token, down_token = json.loads(gamma_payload["clobTokenIds"])
        condition_id = gamma_payload["conditionId"]
        market_id = gamma_payload["id"]
        connection_payload = socket_audit_payload("connection_open")
        book_payload = json.dumps(
            {
                "event_type": "book",
                "asset_id": up_token,
                "market": condition_id,
                "bids": [{"price": "0.49", "size": "10.000"}],
                "asks": [{"price": "0.51", "size": "12.500"}],
                "timestamp": "1775181060000",
                "hash": "public-book-hash",
            },
            separators=(",", ":"),
        )
        chainlink_payload = (
            '{"topic":"crypto_prices_chainlink","type":"update",'
            '"timestamp":1775181060020,"payload":{"symbol":"btc/usd",'
            '"timestamp":1775181060000,"value":67234.50000001}}'
        )
        with TemporaryDirectory() as directory:
            root = Path(directory)
            gamma, _, _ = verified_gamma(root)
            clob = verified_events(
                root,
                dataset_id="clob-public",
                source="polymarket.clob.market",
                stream="market-channel",
                events=[
                    raw_event(
                        source="polymarket.clob.market",
                        stream="market-channel",
                        event_type="connection_open",
                        event_id="clob-open",
                        raw_payload=connection_payload,
                        receive_ms=130,
                        connection_id="clob-connection",
                        market_id=market_id,
                        condition_id=condition_id,
                    ),
                    raw_event(
                        source="polymarket.clob.market",
                        stream="market-channel",
                        event_type="book",
                        event_id="clob-book",
                        raw_payload=book_payload,
                        receive_ms=160,
                        connection_id="clob-connection",
                        market_id=market_id,
                        condition_id=condition_id,
                        asset_id=up_token,
                    ),
                ],
                subscription={
                    "assets_ids": [up_token, down_token],
                    "type": "market",
                    "custom_feature_enabled": True,
                },
                sanitized_config={
                    "endpointClass": "public-read-only",
                    "customFeatures": True,
                },
                declared_asset_ids=[up_token, down_token],
            )
            chainlink = verified_events(
                root,
                dataset_id="chainlink-public",
                source="polymarket.rtds.chainlink",
                stream="crypto-prices-chainlink",
                events=[
                    raw_event(
                        source="polymarket.rtds.chainlink",
                        stream="crypto-prices-chainlink",
                        event_type="crypto_price",
                        event_id="chainlink-price",
                        raw_payload=chainlink_payload,
                        receive_ms=200,
                        connection_id="chainlink-connection",
                    )
                ],
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
                sanitized_config={
                    "endpointClass": "public-read-only",
                    "symbolFilter": "btc/usd",
                },
            )
            build = NormalizedDatasetBuilder.normalize_verified(
                [gamma, clob, chainlink],
                "integrated",
                NORMALIZER_COMMIT,
                NormalizerConfig(),
            )
            view = PointInTimeDataset(
                build.records, quarantines=build.quarantines
            ).as_of(utc(999), market_id)
            self.assertEqual(view.chainlink_price, Decimal("67234.50000001"))
            self.assertEqual(view.books[up_token].best_bid, Decimal("0.49"))
            self.assertEqual(view.books[up_token].best_ask, Decimal("0.51"))
            self.assertEqual(view.books[up_token].state.value, "WAITING_FOR_SNAPSHOT")
            self.assertFalse(view.books[up_token].execution_eligible)
            self.assertEqual(view.books[up_token].continuity, "UNVERIFIED")
            chainlink_record = next(
                item
                for item in build.records
                if item.record_type.value == "chainlink_btc_usd"
            )
            self.assertEqual(
                {item.event_id for item in chainlink_record.dependency_lineage},
                {"gamma-1"},
            )
            self.assertEqual(chainlink_record.dependency_lineage[0].visible_at, utc(120))
            book_record = next(
                item
                for item in build.records
                if item.record_type.value == "clob_book_state"
            )
            self.assertIsNone(book_record.source_time)
            self.assertEqual(book_record.payload["provider_timestamp_raw"], "1775181060000")

    def test_equal_millisecond_connection_events_preserve_raw_append_order(self) -> None:
        gamma_payload = json.loads(GAMMA.read_text(encoding="utf-8"))
        up_token, down_token = json.loads(gamma_payload["clobTokenIds"])
        condition_id = gamma_payload["conditionId"]
        market_id = gamma_payload["id"]
        book_payload = json.dumps(
            {
                "event_type": "book",
                "asset_id": up_token,
                "market": condition_id,
                "bids": [{"price": "0.49", "size": "10"}],
                "asks": [{"price": "0.51", "size": "10"}],
                "timestamp": "1775181060000",
                "hash": "same-ms-book",
            },
            separators=(",", ":"),
        )
        with TemporaryDirectory() as directory:
            root = Path(directory)
            gamma, _, _ = verified_gamma(root)
            clob = verified_events(
                root,
                dataset_id="same-ms-clob",
                source="polymarket.clob.market",
                stream="market-channel",
                events=[
                    raw_event(
                        source="polymarket.clob.market",
                        stream="market-channel",
                        event_type="connection_open",
                        event_id="z-open-sorts-after-book",
                        raw_payload=socket_audit_payload("connection_open"),
                        receive_ms=130,
                        connection_id="same-ms-connection",
                        market_id=market_id,
                        condition_id=condition_id,
                    ),
                    raw_event(
                        source="polymarket.clob.market",
                        stream="market-channel",
                        event_type="book",
                        event_id="a-book-sorts-before-open",
                        raw_payload=book_payload,
                        receive_ms=130,
                        connection_id="same-ms-connection",
                        market_id=market_id,
                        condition_id=condition_id,
                        asset_id=up_token,
                    ),
                    raw_event(
                        source="polymarket.clob.market",
                        stream="market-channel",
                        event_type="connection_closed_early",
                        event_id="zero-close-sorts-before-open",
                        raw_payload=socket_audit_payload("connection_closed_early"),
                        receive_ms=130,
                        connection_id="same-ms-connection",
                        market_id=market_id,
                        condition_id=condition_id,
                    ),
                ],
                subscription={
                    "assets_ids": [up_token, down_token],
                    "type": "market",
                    "custom_feature_enabled": True,
                },
                sanitized_config={
                    "endpointClass": "public-read-only",
                    "customFeatures": True,
                },
                declared_asset_ids=[up_token, down_token],
            )
            build = NormalizedDatasetBuilder.normalize_verified(
                [gamma, clob], "same-ms", NORMALIZER_COMMIT, NormalizerConfig()
            )
            self.assertTrue(
                any(item.record_type.value == "clob_book_state" for item in build.records)
            )
            self.assertNotIn(
                "BOOK_EVENT_WITHOUT_ACTIVE_CONNECTION",
                build.manifest["quality_counts"],
            )
            view = PointInTimeDataset(
                build.records,
                quarantines=build.quarantines,
            ).as_of(utc(999), market_id)
            self.assertEqual(view.books[up_token].state.value, "DISCONNECTED")
            self.assertFalse(view.books[up_token].execution_eligible)

    def test_real_collector_audit_trace_is_validated_without_noop_state_changes(self) -> None:
        gamma_payload = json.loads(GAMMA.read_text(encoding="utf-8"))
        up_token, down_token = json.loads(gamma_payload["clobTokenIds"])
        condition_id = gamma_payload["conditionId"]
        market_id = gamma_payload["id"]
        audit_types = [
            "connection_open",
            "subscription_sent",
            "heartbeat_ping",
            "heartbeat_pong",
            "capture_complete",
        ]
        with TemporaryDirectory() as directory:
            root = Path(directory)
            gamma, _, _ = verified_gamma(root)
            clob = verified_events(
                root,
                dataset_id="collector-audit-trace",
                source="polymarket.clob.market",
                stream="market-channel",
                events=[
                    raw_event(
                        source="polymarket.clob.market",
                        stream="market-channel",
                        event_type=event_type,
                        event_id=f"audit-{ordinal}",
                        raw_payload=socket_audit_payload(event_type),
                        receive_ms=130 + ordinal * 10,
                        connection_id="collector-audit-connection",
                        market_id=market_id,
                        condition_id=condition_id,
                    )
                    for ordinal, event_type in enumerate(audit_types)
                ],
                subscription={
                    "assets_ids": [up_token, down_token],
                    "type": "market",
                    "custom_feature_enabled": True,
                },
                sanitized_config={
                    "endpointClass": "public-read-only",
                    "customFeatures": True,
                },
                declared_asset_ids=[up_token, down_token],
            )
            build = NormalizedDatasetBuilder.normalize_verified(
                [gamma, clob], "collector-audit", NORMALIZER_COMMIT, NormalizerConfig()
            )
            states = [
                item.payload["state"]
                for item in build.records
                if item.record_type.value == "connection_state"
            ]
            self.assertEqual(states, ["CONNECTED", "DISCONNECTED"])
            self.assertNotIn("INVALID_CONNECTION_AUDIT", build.manifest["quality_counts"])
            self.assertNotIn("UNSUPPORTED_RAW_SOURCE", build.manifest["quality_counts"])

    def test_mismatched_collector_audit_payload_fails_closed(self) -> None:
        gamma_payload = json.loads(GAMMA.read_text(encoding="utf-8"))
        up_token, down_token = json.loads(gamma_payload["clobTokenIds"])
        condition_id = gamma_payload["conditionId"]
        market_id = gamma_payload["id"]
        with TemporaryDirectory() as directory:
            root = Path(directory)
            gamma, _, _ = verified_gamma(root)
            clob = verified_events(
                root,
                dataset_id="invalid-audit-payload",
                source="polymarket.clob.market",
                stream="market-channel",
                events=[
                    raw_event(
                        source="polymarket.clob.market",
                        stream="market-channel",
                        event_type="connection_open",
                        event_id="audit-envelope-payload-mismatch",
                        raw_payload=socket_audit_payload("capture_complete"),
                        receive_ms=130,
                        connection_id="invalid-audit-connection",
                        market_id=market_id,
                        condition_id=condition_id,
                    )
                ],
                subscription={
                    "assets_ids": [up_token, down_token],
                    "type": "market",
                    "custom_feature_enabled": True,
                },
                sanitized_config={
                    "endpointClass": "public-read-only",
                    "customFeatures": True,
                },
                declared_asset_ids=[up_token, down_token],
            )
            build = NormalizedDatasetBuilder.normalize_verified(
                [gamma, clob], "invalid-audit", NORMALIZER_COMMIT, NormalizerConfig()
            )
            self.assertEqual(
                build.manifest["quality_counts"]["INVALID_CONNECTION_AUDIT"],
                1,
            )
            connection_states = [
                item.payload["state"]
                for item in build.records
                if item.record_type.value == "connection_state"
            ]
            self.assertNotIn("CONNECTED", connection_states)
            self.assertIn("RESET_REQUIRED", connection_states)
            view = PointInTimeDataset(
                build.records,
                quarantines=build.quarantines,
            ).as_of(utc(999), market_id)
            self.assertEqual(set(view.books), {up_token, down_token})
            self.assertTrue(
                all(book.state.value == "RESET_REQUIRED" for book in view.books.values())
            )
            self.assertTrue(
                all(not book.execution_eligible for book in view.books.values())
            )

    def test_clob_array_preserves_submessage_order_in_offline_view(self) -> None:
        gamma_payload = json.loads(GAMMA.read_text(encoding="utf-8"))
        up_token, down_token = json.loads(gamma_payload["clobTokenIds"])
        condition_id = gamma_payload["conditionId"]
        market_id = gamma_payload["id"]
        batch_payload = json.dumps(
            [
                {
                    "event_type": "book",
                    "asset_id": up_token,
                    "market": condition_id,
                    "bids": [{"price": "0.49", "size": "10"}],
                    "asks": [{"price": "0.51", "size": "10"}],
                    "hash": "array-first",
                },
                {
                    "event_type": "book",
                    "asset_id": up_token,
                    "market": condition_id,
                    "bids": [{"price": "0.48", "size": "11"}],
                    "asks": [{"price": "0.52", "size": "12"}],
                    "hash": "array-second",
                },
            ],
            separators=(",", ":"),
        )
        with TemporaryDirectory() as directory:
            root = Path(directory)
            gamma, _, _ = verified_gamma(root)
            clob = verified_events(
                root,
                dataset_id="array-order-clob",
                source="polymarket.clob.market",
                stream="market-channel",
                events=[
                    raw_event(
                        source="polymarket.clob.market",
                        stream="market-channel",
                        event_type="connection_open",
                        event_id="array-open",
                        raw_payload=socket_audit_payload("connection_open"),
                        receive_ms=130,
                        connection_id="array-connection",
                        market_id=market_id,
                        condition_id=condition_id,
                    ),
                    raw_event(
                        source="polymarket.clob.market",
                        stream="market-channel",
                        event_type="book",
                        event_id="array-frame",
                        raw_payload=batch_payload,
                        receive_ms=160,
                        connection_id="array-connection",
                        market_id=market_id,
                        condition_id=condition_id,
                        asset_id=up_token,
                    ),
                ],
                subscription={
                    "assets_ids": [up_token, down_token],
                    "type": "market",
                    "custom_feature_enabled": True,
                },
                sanitized_config={
                    "endpointClass": "public-read-only",
                    "customFeatures": True,
                },
                declared_asset_ids=[up_token, down_token],
            )
            build = NormalizedDatasetBuilder.normalize_verified(
                [gamma, clob], "array-order", NORMALIZER_COMMIT, NormalizerConfig()
            )
            book_records = [
                item
                for item in build.records
                if item.record_type.value == "clob_book_state"
            ]
            self.assertEqual(
                {item.lineage[0].message_ordinal for item in book_records},
                {0, 1},
            )
            view = PointInTimeDataset(build.records).as_of(utc(999), market_id)
            self.assertEqual(view.books[up_token].best_bid, Decimal("0.48"))
            self.assertEqual(view.books[up_token].best_ask, Decimal("0.52"))

    def test_late_gamma_keeps_cross_manifest_raw_causal_order(self) -> None:
        gamma_payload = json.loads(GAMMA.read_text(encoding="utf-8"))
        up_token, down_token = json.loads(gamma_payload["clobTokenIds"])
        condition_id = gamma_payload["conditionId"]
        market_id = gamma_payload["id"]
        subscription = {
            "assets_ids": [up_token, down_token],
            "type": "market",
            "custom_feature_enabled": True,
        }
        sanitized_config = {
            "endpointClass": "public-read-only",
            "customFeatures": True,
        }
        with TemporaryDirectory() as directory:
            root = Path(directory)
            gamma, _, _ = verified_gamma(
                root,
                event=raw_gamma_event(receive_ms=500),
            )
            opened = verified_events(
                root,
                dataset_id="m-open",
                source="polymarket.clob.market",
                stream="market-channel",
                events=[
                    raw_event(
                        source="polymarket.clob.market",
                        stream="market-channel",
                        event_type="connection_open",
                        event_id="cross-manifest-open",
                        raw_payload=socket_audit_payload("connection_open"),
                        receive_ms=100,
                        connection_id="cross-manifest-connection",
                        market_id=market_id,
                        condition_id=condition_id,
                    )
                ],
                subscription=subscription,
                sanitized_config=sanitized_config,
                declared_asset_ids=[up_token, down_token],
            )
            quarantined = verified_events(
                root,
                dataset_id="z-quarantine-sorts-after-recovery",
                source="polymarket.clob.market",
                stream="market-channel",
                events=[
                    raw_event(
                        source="polymarket.clob.market",
                        stream="market-channel",
                        event_type="book",
                        event_id="cross-manifest-crossed",
                        raw_payload=json.dumps(
                            {
                                "event_type": "book",
                                "asset_id": up_token,
                                "market": condition_id,
                                "bids": [{"price": "0.60", "size": "1"}],
                                "asks": [{"price": "0.50", "size": "1"}],
                            },
                            separators=(",", ":"),
                        ),
                        receive_ms=200,
                        connection_id="cross-manifest-connection",
                        market_id=market_id,
                        condition_id=condition_id,
                        asset_id=up_token,
                    )
                ],
                subscription=subscription,
                sanitized_config=sanitized_config,
                declared_asset_ids=[up_token, down_token],
            )
            recovered = verified_events(
                root,
                dataset_id="a-recovery-sorts-before-quarantine",
                source="polymarket.clob.market",
                stream="market-channel",
                events=[
                    raw_event(
                        source="polymarket.clob.market",
                        stream="market-channel",
                        event_type="connection_open",
                        event_id="cross-manifest-recovery",
                        raw_payload=socket_audit_payload("connection_open"),
                        receive_ms=300,
                        connection_id="cross-manifest-connection",
                        market_id=market_id,
                        condition_id=condition_id,
                    )
                ],
                subscription=subscription,
                sanitized_config=sanitized_config,
                declared_asset_ids=[up_token, down_token],
            )
            build = NormalizedDatasetBuilder.normalize_verified(
                [gamma, opened, quarantined, recovered],
                "cross-manifest-causal-order",
                NORMALIZER_COMMIT,
                NormalizerConfig(),
            )
            quarantine = next(
                item for item in build.quarantines if item.reason_code == "CROSSED_BOOK"
            )
            self.assertEqual(quarantine.visible_at, utc(520))
            self.assertEqual(quarantine.lineage[0].raw_persist_time, utc(220))
            view = PointInTimeDataset(
                build.records,
                quarantines=build.quarantines,
            ).as_of(utc(999), market_id)
            self.assertEqual(view.books[up_token].state.value, "WAITING_FOR_SNAPSHOT")
            self.assertIsNone(view.books[up_token].best_bid)

    def test_late_gamma_identity_delays_connection_fact_visibility(self) -> None:
        gamma_payload = json.loads(GAMMA.read_text(encoding="utf-8"))
        up_token, down_token = json.loads(gamma_payload["clobTokenIds"])
        condition_id = gamma_payload["conditionId"]
        market_id = gamma_payload["id"]
        with TemporaryDirectory() as directory:
            root = Path(directory)
            gamma, _, _ = verified_gamma(
                root,
                event=raw_gamma_event(receive_ms=500),
            )
            clob = verified_events(
                root,
                dataset_id="clob-before-gamma",
                source="polymarket.clob.market",
                stream="market-channel",
                events=[
                    raw_event(
                        source="polymarket.clob.market",
                        stream="market-channel",
                        event_type="connection_open",
                        event_id="early-clob-open",
                        raw_payload=socket_audit_payload("connection_open"),
                        receive_ms=100,
                        connection_id="early-clob-connection",
                        market_id=market_id,
                        condition_id=condition_id,
                    ),
                    raw_event(
                        source="polymarket.clob.market",
                        stream="market-channel",
                        event_type="book",
                        event_id="early-crossed-book",
                        raw_payload=json.dumps(
                            {
                                "event_type": "book",
                                "asset_id": up_token,
                                "market": condition_id,
                                "bids": [{"price": "0.60", "size": "1"}],
                                "asks": [{"price": "0.50", "size": "1"}],
                                "timestamp": "1775181060000",
                            },
                            separators=(",", ":"),
                        ),
                        receive_ms=130,
                        connection_id="early-clob-connection",
                        market_id=market_id,
                        condition_id=condition_id,
                        asset_id=up_token,
                    ),
                ],
                subscription={
                    "assets_ids": [up_token, down_token],
                    "type": "market",
                    "custom_feature_enabled": True,
                },
                sanitized_config={
                    "endpointClass": "public-read-only",
                    "customFeatures": True,
                },
                declared_asset_ids=[up_token, down_token],
            )
            build = NormalizedDatasetBuilder.normalize_verified(
                [gamma, clob],
                "late-gamma",
                NORMALIZER_COMMIT,
                NormalizerConfig(),
            )
            connection = next(
                item
                for item in build.records
                if item.record_type.value == "connection_state"
                and item.payload["state"] == "RESET_REQUIRED"
            )
            self.assertEqual(connection.visible_at, utc(520))
            self.assertEqual(connection.lineage[0].visible_at, utc(520))
            self.assertEqual(connection.dependency_lineage[0].visible_at, utc(520))
            quarantine = next(
                item for item in build.quarantines if item.reason_code == "CROSSED_BOOK"
            )
            self.assertEqual(quarantine.visible_at, utc(520))
            self.assertEqual(quarantine.lineage[0].visible_at, utc(520))
            self.assertEqual(quarantine.dependency_lineage[0].visible_at, utc(520))

    def test_envelope_and_payload_market_identity_mismatch_fails_closed(self) -> None:
        gamma_payload = json.loads(GAMMA.read_text(encoding="utf-8"))
        up_token, down_token = json.loads(gamma_payload["clobTokenIds"])
        condition_id = gamma_payload["conditionId"]
        market_id = gamma_payload["id"]
        mismatched_condition = "0x" + "3" * 64
        with TemporaryDirectory() as directory:
            root = Path(directory)
            gamma, _, _ = verified_gamma(root)
            clob = verified_events(
                root,
                dataset_id="identity-mismatch-clob",
                source="polymarket.clob.market",
                stream="market-channel",
                events=[
                    raw_event(
                        source="polymarket.clob.market",
                        stream="market-channel",
                        event_type="connection_open",
                        event_id="identity-open",
                        raw_payload=socket_audit_payload("connection_open"),
                        receive_ms=130,
                        connection_id="identity-connection",
                        market_id=market_id,
                        condition_id=condition_id,
                    ),
                    raw_event(
                        source="polymarket.clob.market",
                        stream="market-channel",
                        event_type="book",
                        event_id="identity-mismatch-book",
                        raw_payload=json.dumps(
                            {
                                "event_type": "book",
                                "asset_id": up_token,
                                "market": mismatched_condition,
                                "bids": [{"price": "0.49", "size": "1"}],
                                "asks": [{"price": "0.51", "size": "1"}],
                            },
                            separators=(",", ":"),
                        ),
                        receive_ms=160,
                        connection_id="identity-connection",
                        market_id=market_id,
                        condition_id=condition_id,
                        asset_id=up_token,
                    ),
                ],
                subscription={
                    "assets_ids": [up_token, down_token],
                    "type": "market",
                    "custom_feature_enabled": True,
                },
                sanitized_config={
                    "endpointClass": "public-read-only",
                    "customFeatures": True,
                },
                declared_asset_ids=[up_token, down_token],
            )
            build = NormalizedDatasetBuilder.normalize_verified(
                [gamma, clob],
                "identity-mismatch",
                NORMALIZER_COMMIT,
                NormalizerConfig(),
            )
            self.assertFalse(
                any(item.record_type.value == "clob_book_state" for item in build.records)
            )
            self.assertIn("UNKNOWN_MARKET_IDENTITY", build.manifest["quality_counts"])
            quarantine = next(
                item
                for item in build.quarantines
                if item.reason_code == "UNKNOWN_MARKET_IDENTITY"
            )
            self.assertEqual(quarantine.market_id, market_id)
            self.assertTrue(quarantine.dependency_lineage)
            view = PointInTimeDataset(
                build.records,
                quarantines=build.quarantines,
            ).as_of(utc(999), market_id)
            self.assertEqual(view.books[up_token].state.value, "RESET_REQUIRED")
            self.assertFalse(view.books[up_token].execution_eligible)

    def test_chainlink_boundary_is_previous_close_and_next_open(self) -> None:
        first_payload = json.loads(GAMMA.read_text(encoding="utf-8"))
        second_payload = dict(first_payload)
        second_payload.update(
            {
                "id": "next-market",
                "conditionId": "0x" + "2" * 64,
                "slug": "btc-updown-5m-1775181300",
                "eventStartTime": "2026-04-03T01:55:00Z",
                "endDate": "2026-04-03T02:00:00Z",
                "clobTokenIds": json.dumps(["1000001", "1000002"]),
            }
        )
        first_event = raw_event(
            source="polymarket.gamma",
            stream="market-by-slug",
            event_type="market_metadata",
            event_id="gamma-first",
            raw_payload=json.dumps(first_payload, separators=(",", ":")),
            receive_ms=100,
            connection_id="gamma-first-http",
            market_id=first_payload["id"],
            condition_id=first_payload["conditionId"],
        )
        second_event = raw_event(
            source="polymarket.gamma",
            stream="market-by-slug",
            event_type="market_metadata",
            event_id="gamma-next",
            raw_payload=json.dumps(second_payload, separators=(",", ":")),
            receive_ms=200,
            connection_id="gamma-next-http",
            market_id=second_payload["id"],
            condition_id=second_payload["conditionId"],
        )
        boundary_payload = (
            '{"topic":"crypto_prices_chainlink","type":"update",'
            '"timestamp":1775181300020,"payload":{"symbol":"btc/usd",'
            '"timestamp":1775181300000,"value":68000.125}}'
        )
        price_event = raw_event(
            source="polymarket.rtds.chainlink",
            stream="crypto-prices-chainlink",
            event_type="crypto_price",
            event_id="chainlink-boundary",
            raw_payload=boundary_payload,
            receive_ms=300,
            connection_id="chainlink-boundary-connection",
        )
        with TemporaryDirectory() as directory:
            root = Path(directory)
            gamma_first = verified_events(
                root,
                dataset_id="adjacent-gamma-first",
                source="polymarket.gamma",
                stream="market-by-slug",
                events=[first_event],
                subscription={
                    "endpoint": "gamma-market-by-slug",
                    "slug": first_payload["slug"],
                },
                sanitized_config={"endpointClass": "public-read-only"},
            )
            gamma_second = verified_events(
                root,
                dataset_id="adjacent-gamma-second",
                source="polymarket.gamma",
                stream="market-by-slug",
                events=[second_event],
                subscription={
                    "endpoint": "gamma-market-by-slug",
                    "slug": second_payload["slug"],
                },
                sanitized_config={"endpointClass": "public-read-only"},
            )
            chainlink = verified_events(
                root,
                dataset_id="boundary-chainlink",
                source="polymarket.rtds.chainlink",
                stream="crypto-prices-chainlink",
                events=[price_event],
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
                sanitized_config={
                    "endpointClass": "public-read-only",
                    "symbolFilter": "btc/usd",
                },
            )
            build = NormalizedDatasetBuilder.normalize_verified(
                [gamma_first, gamma_second, chainlink],
                "boundary",
                NORMALIZER_COMMIT,
                NormalizerConfig(),
            )
            price_markets = {
                item.market_id
                for item in build.records
                if item.record_type.value == "chainlink_btc_usd"
            }
            self.assertEqual(price_markets, {"1822773", "next-market"})

    def test_all_symbols_binance_input_requires_explicit_manifested_opt_in(self) -> None:
        off_topic = (
            '{"topic":"crypto_prices","type":"update","timestamp":1775181060020,'
            '"payload":{"symbol":"ethusdt","timestamp":1775181060000,"value":3500.25}}'
        )
        with TemporaryDirectory() as directory:
            root = Path(directory)
            gamma, _, _ = verified_gamma(root)
            binance = verified_events(
                root,
                dataset_id="binance-fallback",
                source="polymarket.rtds.binance",
                stream="crypto-prices",
                events=[
                    raw_event(
                        source="polymarket.rtds.binance",
                        stream="crypto-prices",
                        event_type="crypto_price",
                        event_id="eth-off-topic",
                        raw_payload=off_topic,
                        receive_ms=300,
                        connection_id="binance-connection",
                        parser_status="quarantined",
                    )
                ],
                subscription={
                    "action": "subscribe",
                    "subscriptions": [{"topic": "crypto_prices", "type": "update"}],
                },
                sanitized_config={
                    "endpointClass": "public-read-only",
                    "symbolFilter": "btcusdt",
                    "transportScope": "all-symbols-quarantine",
                },
            )
            with self.assertRaisesRegex(ManifestVerificationError, "explicit"):
                NormalizedDatasetBuilder.normalize_verified(
                    [gamma, binance], "fallback", NORMALIZER_COMMIT, NormalizerConfig()
                )
            build = NormalizedDatasetBuilder.normalize_verified(
                [gamma, binance],
                "fallback",
                NORMALIZER_COMMIT,
                NormalizerConfig(allow_binance_all_symbols_fallback=True),
            )
            self.assertTrue(build.manifest["config"]["allow_binance_all_symbols_fallback"])
            binance_input = next(
                item
                for item in build.manifest["raw_inputs"]
                if item["source"] == "polymarket.rtds.binance"
            )
            self.assertEqual(
                binance_input["sanitized_config"]["transportScope"],
                "all-symbols-quarantine",
            )
            self.assertIn("RAW_PARSER_REJECTED", build.manifest["quality_counts"])

    def test_market_identity_collision_is_quarantined_not_last_write_wins(self) -> None:
        original_payload = GAMMA.read_text(encoding="utf-8")
        conflicting_value = json.loads(original_payload)
        conflicting_value["id"] = "different-market-id"
        conflicting_payload = json.dumps(conflicting_value, separators=(",", ":"))
        first = raw_gamma_event()
        second = raw_event(
            source="polymarket.gamma",
            stream="market-by-slug",
            event_type="market_metadata",
            event_id="gamma-collision",
            raw_payload=conflicting_payload,
            receive_ms=200,
            connection_id="gamma-http-2",
            market_id="different-market-id",
            condition_id=conflicting_value["conditionId"],
        )
        with TemporaryDirectory() as directory:
            verified = verified_events(
                Path(directory),
                dataset_id="gamma-collision-dataset",
                source="polymarket.gamma",
                stream="market-by-slug",
                events=[first, second],
                subscription={
                    "endpoint": "gamma-market-by-slug",
                    "slug": "btc-updown-5m-1775181000",
                },
                sanitized_config={"endpointClass": "public-read-only"},
            )
            build = NormalizedDatasetBuilder.normalize_verified(
                [verified], "collision", NORMALIZER_COMMIT, NormalizerConfig()
            )
            self.assertEqual(build.manifest["quality_counts"]["MARKET_IDENTITY_COLLISION"], 2)
            metadata_market_ids = {
                item.market_id
                for item in build.records
                if item.record_type.value == "market_metadata"
            }
            self.assertEqual(metadata_market_ids, {"1822773"})
            self.assertEqual(
                {
                    item.market_id
                    for item in build.quarantines
                    if item.reason_code == "MARKET_IDENTITY_COLLISION"
                },
                {"1822773", "different-market-id"},
            )
            original_view = PointInTimeDataset(
                build.records,
                quarantines=build.quarantines,
            ).as_of(utc(999), "1822773")
            original_token = next(iter(original_view.books))
            self.assertEqual(
                original_view.books[original_token].state.value,
                "RESET_REQUIRED",
            )
            self.assertFalse(original_view.books[original_token].execution_eligible)

            new_side = next(
                item
                for item in build.quarantines
                if item.reason_code == "MARKET_IDENTITY_COLLISION"
                and item.market_id == "different-market-id"
            )
            self.assertEqual(
                {item.event_id for item in new_side.dependency_lineage},
                {"gamma-1"},
            )

    def test_gamma_payload_must_match_envelope_and_manifest_subscription(self) -> None:
        payload = GAMMA.read_text(encoding="utf-8")
        parsed = json.loads(payload)
        mismatched = raw_event(
            source="polymarket.gamma",
            stream="market-by-slug",
            event_type="market_metadata",
            event_id="gamma-envelope-mismatch",
            raw_payload=payload,
            receive_ms=100,
            connection_id="gamma-mismatch-http",
            market_id="wrong-envelope-market",
            condition_id=parsed["conditionId"],
        )
        with TemporaryDirectory() as directory:
            verified = verified_events(
                Path(directory),
                dataset_id="gamma-envelope-mismatch",
                source="polymarket.gamma",
                stream="market-by-slug",
                events=[mismatched],
                subscription={
                    "endpoint": "gamma-market-by-slug",
                    "slug": parsed["slug"],
                },
                sanitized_config={"endpointClass": "public-read-only"},
            )
            build = NormalizedDatasetBuilder.normalize_verified(
                [verified],
                "gamma-binding",
                NORMALIZER_COMMIT,
                NormalizerConfig(),
            )
            self.assertFalse(
                any(
                    item.record_type.value == "market_metadata"
                    for item in build.records
                )
            )
            self.assertEqual(
                build.manifest["quality_counts"][
                    "GAMMA_IDENTITY_BINDING_MISMATCH"
                ],
                1,
            )
        with TemporaryDirectory() as directory:
            verified = verified_events(
                Path(directory),
                dataset_id="gamma-subscription-mismatch",
                source="polymarket.gamma",
                stream="market-by-slug",
                events=[raw_gamma_event(event_id="gamma-subscription-mismatch")],
                subscription={
                    "endpoint": "gamma-market-by-slug",
                    "slug": "btc-updown-5m-1775181300",
                },
                sanitized_config={"endpointClass": "public-read-only"},
            )
            build = NormalizedDatasetBuilder.normalize_verified(
                [verified],
                "gamma-subscription-binding",
                NORMALIZER_COMMIT,
                NormalizerConfig(),
            )
            self.assertFalse(build.records)
            self.assertEqual(
                build.manifest["quality_counts"][
                    "GAMMA_IDENTITY_BINDING_MISMATCH"
                ],
                1,
            )

    def test_gamma_claim_for_future_identity_is_quarantined_without_future_leakage(self) -> None:
        first_payload = json.loads(GAMMA.read_text(encoding="utf-8"))
        next_payload = dict(first_payload)
        next_payload.update(
            {
                "id": "next-market",
                "conditionId": "0x" + "2" * 64,
                "slug": "btc-updown-5m-1775181300",
                "eventStartTime": "2026-04-03T01:55:00Z",
                "endDate": "2026-04-03T02:00:00Z",
                "clobTokenIds": json.dumps(["1000001", "1000002"]),
            }
        )
        first_raw_payload = json.dumps(first_payload, separators=(",", ":"))
        next_raw_payload = json.dumps(next_payload, separators=(",", ":"))
        for claim_kind in ("market_id", "condition_id", "subscription_slug"):
            with self.subTest(claim_kind=claim_kind), TemporaryDirectory() as directory:
                root = Path(directory)
                bad_event = raw_event(
                    source="polymarket.gamma",
                    stream="market-by-slug",
                    event_type="market_metadata",
                    event_id=f"gamma-bad-future-{claim_kind}",
                    raw_payload=first_raw_payload,
                    receive_ms=100,
                    connection_id=f"gamma-bad-{claim_kind}",
                    market_id=(
                        next_payload["id"]
                        if claim_kind == "market_id"
                        else first_payload["id"]
                    ),
                    condition_id=(
                        next_payload["conditionId"]
                        if claim_kind == "condition_id"
                        else first_payload["conditionId"]
                    ),
                )
                future_event = raw_event(
                    source="polymarket.gamma",
                    stream="market-by-slug",
                    event_type="market_metadata",
                    event_id=f"gamma-future-valid-{claim_kind}",
                    raw_payload=next_raw_payload,
                    receive_ms=200,
                    connection_id=f"gamma-future-{claim_kind}",
                    market_id=next_payload["id"],
                    condition_id=next_payload["conditionId"],
                )
                bad = verified_events(
                    root,
                    dataset_id=f"gamma-bad-claim-{claim_kind}",
                    source="polymarket.gamma",
                    stream="market-by-slug",
                    events=[bad_event],
                    subscription={
                        "endpoint": "gamma-market-by-slug",
                        "slug": (
                            next_payload["slug"]
                            if claim_kind == "subscription_slug"
                            else first_payload["slug"]
                        ),
                    },
                    sanitized_config={"endpointClass": "public-read-only"},
                )
                future = verified_events(
                    root,
                    dataset_id=f"gamma-future-valid-{claim_kind}",
                    source="polymarket.gamma",
                    stream="market-by-slug",
                    events=[future_event],
                    subscription={
                        "endpoint": "gamma-market-by-slug",
                        "slug": next_payload["slug"],
                    },
                    sanitized_config={"endpointClass": "public-read-only"},
                )
                build = NormalizedDatasetBuilder.normalize_verified(
                    [bad, future],
                    f"future-claim-{claim_kind}",
                    NORMALIZER_COMMIT,
                    NormalizerConfig(),
                )
                future_quarantine = next(
                    item
                    for item in build.quarantines
                    if item.reason_code == "GAMMA_IDENTITY_BINDING_MISMATCH"
                    and item.market_id == next_payload["id"]
                )
                self.assertEqual(future_quarantine.visible_at, future_event.persist_time)
                self.assertEqual(
                    future_quarantine.lineage[0].raw_persist_time,
                    bad_event.persist_time,
                )
                self.assertEqual(
                    future_quarantine.lineage[0].visible_at,
                    future_event.persist_time,
                )
                self.assertEqual(
                    {item.event_id for item in future_quarantine.dependency_lineage},
                    {future_event.event_id},
                )
                dataset = PointInTimeDataset(
                    build.records,
                    quarantines=build.quarantines,
                )
                before = dataset.as_of(utc(219), next_payload["id"])
                self.assertIsNone(before.metadata)
                self.assertFalse(before.quarantines)
                at_identity = dataset.as_of(utc(220), next_payload["id"])
                self.assertIsNotNone(at_identity.metadata)
                self.assertIn(future_quarantine, at_identity.quarantines)

    def test_cross_manifest_conflicting_raw_event_id_is_rejected(self) -> None:
        with TemporaryDirectory() as first_directory, TemporaryDirectory() as second_directory:
            first, _, _ = verified_gamma(Path(first_directory))
            conflicting_event = raw_gamma_event(event_id="gamma-1", receive_ms=200)
            second, _, _ = verified_gamma(
                Path(second_directory),
                event=conflicting_event,
                dataset_id="gamma-conflicting-copy",
            )
            with self.assertRaisesRegex(ManifestVerificationError, "cross-manifest"):
                NormalizedDatasetBuilder.normalize_verified(
                    [first, second], "raw-conflict", NORMALIZER_COMMIT, NormalizerConfig()
                )

    def test_duplicate_raw_dataset_ids_are_rejected_even_when_manifests_differ(self) -> None:
        with TemporaryDirectory() as first_directory, TemporaryDirectory() as second_directory:
            first, _, _ = verified_gamma(Path(first_directory), dataset_id="duplicate-id")
            second, _, _ = verified_gamma(
                Path(second_directory),
                event=raw_gamma_event(event_id="gamma-2", receive_ms=200),
                dataset_id="duplicate-id",
            )
            self.assertNotEqual(first.manifest_sha256, second.manifest_sha256)
            with self.assertRaisesRegex(ManifestVerificationError, "dataset_id values"):
                NormalizedDatasetBuilder.normalize_verified(
                    [first, second], "duplicate-input", NORMALIZER_COMMIT, NormalizerConfig()
                )

    def test_verified_raw_normalizes_and_reloads_offline_as_of(self) -> None:
        with TemporaryDirectory() as raw_directory, TemporaryDirectory() as output_directory:
            verified, _, _ = verified_gamma(Path(raw_directory))
            build = NormalizedDatasetBuilder.normalize_verified(
                [verified],
                dataset_id="btc-five-minute",
                normalizer_commit=NORMALIZER_COMMIT,
                config=NormalizerConfig(),
            )
            version = NormalizedDatasetBuilder.publish(build, Path(output_directory))
            restored = PointInTimeDataset.load(version)
            view = restored.as_of(utc(999), "1822773")
            self.assertEqual(view.metadata["oracle_pair"], "BTC/USD")
            self.assertEqual(
                view.token_by_outcome,
                {
                    "up": "43327618351213667646391460691177105630991180325414735346402735306929604801558",
                    "down": "239155430611845419074853127543677303617673506907031331685640059318336493355",
                },
            )
            self.assertEqual(restored.dataset_hash, build.dataset_hash)
            self.assertEqual(build.manifest["normalizer_git_commit"], NORMALIZER_COMMIT)
            self.assertRegex(build.manifest["normalizer_code_sha256"], r"^[0-9a-f]{64}$")
            self.assertIn(build.manifest["normalizer_worktree_state"], {"CLEAN", "DIRTY"})

    def test_claimed_normalizer_commit_must_match_repository_head(self) -> None:
        with TemporaryDirectory() as directory:
            verified, _, _ = verified_gamma(Path(directory))
            with self.assertRaisesRegex(ValueError, "repository HEAD"):
                NormalizedDatasetBuilder.normalize_verified(
                    [verified], "false-provenance", "0" * 40, NormalizerConfig()
                )

    def test_loaded_normalizer_source_must_still_match_disk(self) -> None:
        with TemporaryDirectory() as directory:
            verified, _, _ = verified_gamma(Path(directory))
            stale_snapshot = dict(normalized_module._LOADED_NORMALIZER_SOURCES)
            stale_snapshot[Path(normalized_module.__file__).resolve()] = b"stale-loaded-source"
            with patch.object(
                normalized_module,
                "_LOADED_NORMALIZER_SOURCES",
                stale_snapshot,
            ):
                with self.assertRaisesRegex(ManifestVerificationError, "changed after import"):
                    NormalizedDatasetBuilder.normalize_verified(
                        [verified],
                        "stale-loaded-code",
                        NORMALIZER_COMMIT,
                        NormalizerConfig(),
                    )

    def test_same_input_code_and_config_have_same_hash(self) -> None:
        with TemporaryDirectory() as directory:
            verified, _, _ = verified_gamma(Path(directory))
            first = NormalizedDatasetBuilder.normalize_verified(
                [verified], "stable", NORMALIZER_COMMIT, NormalizerConfig()
            )
            second = NormalizedDatasetBuilder.normalize_verified(
                [verified], "stable", NORMALIZER_COMMIT, NormalizerConfig()
            )
            self.assertEqual(first.dataset_hash, second.dataset_hash)
            self.assertEqual(first.records_bytes, second.records_bytes)
            self.assertEqual(first.manifest_bytes, second.manifest_bytes)

    def test_input_code_or_config_change_creates_new_version(self) -> None:
        with TemporaryDirectory() as first_directory, TemporaryDirectory() as second_directory:
            first_verified, _, _ = verified_gamma(Path(first_directory))
            second_verified, _, _ = verified_gamma(
                Path(second_directory), event=raw_gamma_event(event_id="gamma-2", receive_ms=200)
            )
            baseline = NormalizedDatasetBuilder.normalize_verified(
                [first_verified], "stable", NORMALIZER_COMMIT, NormalizerConfig()
            )
            changed_input = NormalizedDatasetBuilder.normalize_verified(
                [second_verified], "stable", NORMALIZER_COMMIT, NormalizerConfig()
            )
            with patch(
                "research.polymarket_money.normalized._normalizer_repository_state",
                return_value=(NORMALIZER_COMMIT, "CLEAN", "d" * 64),
            ):
                changed_code = NormalizedDatasetBuilder.normalize_verified(
                    [first_verified], "stable", NORMALIZER_COMMIT, NormalizerConfig()
                )
            changed_config = NormalizedDatasetBuilder.normalize_verified(
                [first_verified],
                "stable",
                NORMALIZER_COMMIT,
                NormalizerConfig(book_stale_after_ms=2_000),
            )
            self.assertEqual(
                len({baseline.dataset_hash, changed_input.dataset_hash, changed_code.dataset_hash, changed_config.dataset_hash}),
                4,
            )

    def test_completed_version_cannot_be_overwritten(self) -> None:
        with TemporaryDirectory() as raw_directory, TemporaryDirectory() as output_directory:
            verified, _, _ = verified_gamma(Path(raw_directory))
            build = NormalizedDatasetBuilder.normalize_verified(
                [verified], "immutable", NORMALIZER_COMMIT, NormalizerConfig()
            )
            NormalizedDatasetBuilder.publish(build, Path(output_directory))
            with self.assertRaisesRegex(DatasetPublicationError, "exists"):
                NormalizedDatasetBuilder.publish(build, Path(output_directory))

    def test_build_bytes_are_revalidated_immediately_before_publish(self) -> None:
        with TemporaryDirectory() as raw_directory, TemporaryDirectory() as output_directory:
            verified, _, _ = verified_gamma(Path(raw_directory))
            build = NormalizedDatasetBuilder.normalize_verified(
                [verified], "mutated-build", NORMALIZER_COMMIT, NormalizerConfig()
            )
            object.__setattr__(build, "records_bytes", build.records_bytes + b"{}\n")
            with self.assertRaisesRegex(DatasetPublicationError, "rows changed"):
                NormalizedDatasetBuilder.publish(build, Path(output_directory))

    def test_tampered_segment_after_verification_rejects_normalization(self) -> None:
        with TemporaryDirectory() as directory:
            verified, _, segment = verified_gamma(Path(directory))
            segment.write_text("tampered\n", encoding="utf-8")
            with self.assertRaises(ManifestVerificationError):
                NormalizedDatasetBuilder.normalize_verified(
                    [verified], "tampered", NORMALIZER_COMMIT, NormalizerConfig()
                )

    def test_tampered_manifest_after_verification_rejects_normalization(self) -> None:
        with TemporaryDirectory() as directory:
            verified, manifest, _ = verified_gamma(Path(directory))
            value = json.loads(manifest.read_text(encoding="utf-8"))
            value["sanitized_config"]["endpointClass"] = "fixture"
            manifest.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaises(ManifestVerificationError):
                NormalizedDatasetBuilder.normalize_verified(
                    [verified], "tampered", NORMALIZER_COMMIT, NormalizerConfig()
                )

    def test_drvfs_output_root_is_rejected_before_write(self) -> None:
        with TemporaryDirectory() as directory:
            verified, _, _ = verified_gamma(Path(directory))
            build = NormalizedDatasetBuilder.normalize_verified(
                [verified], "linux-only", NORMALIZER_COMMIT, NormalizerConfig()
            )
            with self.assertRaisesRegex(DatasetPublicationError, "DrvFS"):
                NormalizedDatasetBuilder.publish(build, Path("/mnt/d/polymarket-data"))

    def test_bind_mounted_drvfs_is_rejected_by_filesystem_type(self) -> None:
        with TemporaryDirectory() as raw_directory, TemporaryDirectory() as output_directory:
            verified, _, _ = verified_gamma(Path(raw_directory))
            build = NormalizedDatasetBuilder.normalize_verified(
                [verified], "bind-mounted-drvfs", NORMALIZER_COMMIT, NormalizerConfig()
            )
            with patch(
                "research.polymarket_money.normalized._mount_filesystem_type",
                return_value="9p",
            ):
                with self.assertRaisesRegex(DatasetPublicationError, "Windows-backed"):
                    NormalizedDatasetBuilder.publish(build, Path(output_directory))

    def test_published_output_tamper_is_detected_on_load(self) -> None:
        with TemporaryDirectory() as raw_directory, TemporaryDirectory() as output_directory:
            verified, _, _ = verified_gamma(Path(raw_directory))
            build = NormalizedDatasetBuilder.normalize_verified(
                [verified], "load-gate", NORMALIZER_COMMIT, NormalizerConfig()
            )
            version = NormalizedDatasetBuilder.publish(build, Path(output_directory))
            records = version / "records.jsonl"
            records.write_bytes(records.read_bytes() + b"{}\n")
            with self.assertRaisesRegex(DatasetPublicationError, "checksum"):
                PointInTimeDataset.load(version)


if __name__ == "__main__":
    unittest.main()
