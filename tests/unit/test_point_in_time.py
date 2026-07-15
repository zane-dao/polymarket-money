from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
import unittest

from research.polymarket_money.normalized import (
    BookState,
    NormalizedRecord,
    PointInTimeDataset,
    RawLineage,
    RecordType,
    canonicalize_records,
    outcome_token_mapping,
)


UTC = timezone.utc


def at(milliseconds: int) -> datetime:
    return datetime(2026, 7, 15, 0, 0, 0, milliseconds * 1_000, tzinfo=UTC)


def lineage(name: str, visible_at: datetime) -> RawLineage:
    digit = f"{sum(name.encode('utf-8')) % 16:x}"
    return RawLineage(
        source_manifest_id="manifest-a",
        source_manifest_sha256="a" * 64,
        segment_sha256="b" * 64,
        event_id=name,
        raw_sha256=digit * 64,
        visible_at=visible_at,
    )


def fact(
    record_type: RecordType,
    business_key: str,
    visible_at: datetime,
    payload: dict[str, object],
    *,
    market_id: str | None = "market-a",
    condition_id: str | None = "condition-a",
    asset_id: str | None = None,
    connection_id: str = "connection-a",
    source_time: datetime | None = None,
    observed_at: datetime | None = None,
    valid_from: datetime | None = None,
    event_id: str | None = None,
) -> NormalizedRecord:
    return NormalizedRecord.create(
        record_type=record_type,
        business_key=business_key,
        market_id=market_id,
        condition_id=condition_id,
        asset_id=asset_id,
        source="fixture.normalized",
        source_time=source_time,
        server_time=None,
        receive_time=visible_at,
        process_time=visible_at,
        persist_time=visible_at,
        visible_at=visible_at,
        continuity="UNVERIFIED",
        connection_id=connection_id,
        parser_state="parsed",
        observed_at=observed_at,
        valid_from=valid_from,
        payload=payload,
        lineage=(lineage(event_id or business_key, visible_at),),
    )


def market_facts(
    *,
    market_id: str = "market-a",
    condition_id: str = "condition-a",
    start: datetime = at(0),
    visible_at: datetime = at(0),
    connection_id: str = "connection-a",
) -> list[NormalizedRecord]:
    end = start + timedelta(minutes=5)
    return [
        fact(
            RecordType.MARKET_METADATA,
            f"market-metadata:{market_id}:{visible_at.isoformat()}",
            visible_at,
            {
                "slug": f"btc-updown-5m-{int(start.timestamp())}",
                "interval_start": start,
                "interval_end": end,
                "oracle_provider": "Chainlink",
                "oracle_pair": "BTC/USD",
                "identity_valid": True,
            },
            market_id=market_id,
            condition_id=condition_id,
            observed_at=visible_at,
            valid_from=start,
        ),
        fact(
            RecordType.OUTCOME_TOKEN_MAPPING,
            f"token-mapping:{market_id}:{visible_at.isoformat()}",
            visible_at,
            {"up_token_id": f"up-{market_id}", "down_token_id": f"down-{market_id}"},
            market_id=market_id,
            condition_id=condition_id,
            observed_at=visible_at,
            valid_from=start,
        ),
        fact(
            RecordType.CONNECTION_STATE,
            f"connection:{connection_id}:open",
            visible_at,
            {"state": "CONNECTED"},
            market_id=market_id,
            condition_id=condition_id,
            connection_id=connection_id,
        ),
    ]


def book(
    visible_at: datetime,
    *,
    market_id: str = "market-a",
    condition_id: str = "condition-a",
    asset_id: str | None = None,
    connection_id: str = "connection-a",
    bids: list[dict[str, str]] | None = None,
    asks: list[dict[str, str]] | None = None,
) -> NormalizedRecord:
    token = asset_id or f"up-{market_id}"
    return fact(
        RecordType.CLOB_BOOK_STATE,
        f"book:{connection_id}:{token}:{visible_at.isoformat()}",
        visible_at,
        {
            "bids": bids if bids is not None else [{"price": "0.49", "size": "10.000"}],
            "asks": asks if asks is not None else [{"price": "0.51", "size": "12.500"}],
            "snapshot_received": True,
        },
        market_id=market_id,
        condition_id=condition_id,
        asset_id=token,
        connection_id=connection_id,
    )


class PointInTimeDatasetTest(unittest.TestCase):
    def test_receive_and_process_after_decision_are_invisible(self) -> None:
        records = market_facts()
        records.append(
            fact(
                RecordType.CHAINLINK_BTC_USD,
                "chainlink:one",
                at(300),
                {"symbol": "btc/usd", "price": "67234.50000001"},
                source_time=at(50),
            )
        )
        dataset = PointInTimeDataset(records, stale_after=timedelta(seconds=5))
        self.assertIsNone(dataset.as_of(at(299), "market-a").chainlink_price)
        self.assertEqual(dataset.as_of(at(300), "market-a").chainlink_price, Decimal("67234.50000001"))

    def test_old_source_time_received_late_does_not_pollute_the_past(self) -> None:
        late = fact(
            RecordType.BINANCE_BTC_USDT,
            "binance:late",
            at(500),
            {"symbol": "btcusdt", "price": "65000.123456789"},
            source_time=at(1),
        )
        dataset = PointInTimeDataset([*market_facts(), late])
        before = dataset.as_of(at(499), "market-a")
        after = dataset.as_of(at(500), "market-a")
        self.assertIsNone(before.binance_price)
        self.assertEqual(after.binance_price, Decimal("65000.123456789"))
        self.assertIsNone(dataset.as_of(at(499), "market-a").binance_price)

    def test_reconnect_without_current_snapshot_is_not_executable(self) -> None:
        records = [*market_facts(), book(at(100))]
        records.append(
            fact(
                RecordType.CONNECTION_STATE,
                "connection:connection-b:open",
                at(200),
                {"state": "CONNECTED"},
                connection_id="connection-b",
            )
        )
        view = PointInTimeDataset(records).as_of(at(250), "market-a")
        self.assertEqual(view.books["up-market-a"].state, BookState.WAITING_FOR_SNAPSHOT)
        self.assertFalse(view.books["up-market-a"].execution_eligible)

    def test_disconnected_old_book_is_not_executable(self) -> None:
        records = [*market_facts(), book(at(100))]
        records.append(
            fact(
                RecordType.CONNECTION_STATE,
                "connection:connection-a:closed",
                at(200),
                {"state": "DISCONNECTED"},
            )
        )
        state = PointInTimeDataset(records).as_of(at(250), "market-a").books["up-market-a"]
        self.assertEqual(state.state, BookState.DISCONNECTED)
        self.assertFalse(state.execution_eligible)

    def test_expired_book_is_stale_and_not_executable(self) -> None:
        dataset = PointInTimeDataset(
            [*market_facts(), book(at(100))], stale_after=timedelta(milliseconds=100)
        )
        fresh = dataset.as_of(at(199), "market-a").books["up-market-a"]
        stale = dataset.as_of(at(200), "market-a").books["up-market-a"]
        self.assertEqual(fresh.state, BookState.ACTIVE_UNVERIFIED)
        self.assertEqual(stale.state, BookState.STALE)
        self.assertFalse(stale.execution_eligible)

    def test_empty_side_has_no_midpoint_and_is_not_executable(self) -> None:
        for bids, asks in (([], [{"price": "0.51", "size": "1"}]), ([{"price": "0.49", "size": "1"}], [])):
            with self.subTest(bids=bids, asks=asks):
                state = PointInTimeDataset(
                    [*market_facts(), book(at(10), bids=bids, asks=asks)]
                ).as_of(at(11), "market-a").books["up-market-a"]
                self.assertIsNone(state.midpoint)
                self.assertFalse(state.execution_eligible)

    def test_crossed_book_is_reset_required_and_not_executable(self) -> None:
        crossed = book(
            at(10),
            bids=[{"price": "0.60", "size": "1"}],
            asks=[{"price": "0.50", "size": "1"}],
        )
        state = PointInTimeDataset([*market_facts(), crossed]).as_of(
            at(11), "market-a"
        ).books["up-market-a"]
        self.assertEqual(state.state, BookState.RESET_REQUIRED)
        self.assertFalse(state.execution_eligible)

    def test_continuity_can_never_be_upgraded(self) -> None:
        view = PointInTimeDataset([*market_facts(), book(at(10))]).as_of(at(11), "market-a")
        self.assertEqual(view.continuity, "UNVERIFIED")
        with self.assertRaisesRegex(ValueError, "UNVERIFIED"):
            NormalizedRecord.create(
                record_type=RecordType.CONNECTION_STATE,
                business_key="bad-continuity",
                market_id="market-a",
                condition_id="condition-a",
                asset_id=None,
                source="fixture.normalized",
                source_time=None,
                server_time=None,
                receive_time=at(1),
                process_time=at(1),
                persist_time=at(1),
                visible_at=at(1),
                continuity="VERIFIED",
                connection_id="connection-a",
                parser_state="parsed",
                payload={"state": "CONNECTED"},
                lineage=(lineage("bad", at(1)),),
            )

    def test_identical_duplicates_canonicalize_and_keep_as_of_lineage(self) -> None:
        first = book(at(10), event_id="duplicate-a")
        second = NormalizedRecord.create(
            record_type=first.record_type,
            business_key=first.business_key,
            market_id=first.market_id,
            condition_id=first.condition_id,
            asset_id=first.asset_id,
            source=first.source,
            source_time=first.source_time,
            server_time=first.server_time,
            receive_time=at(20),
            process_time=at(20),
            persist_time=at(20),
            visible_at=at(20),
            continuity="UNVERIFIED",
            connection_id=first.connection_id,
            parser_state="parsed",
            payload=first.payload,
            lineage=(lineage("duplicate-b", at(20)),),
        )
        canonical, quarantines = canonicalize_records([first, second])
        self.assertEqual(len(canonical), 1)
        self.assertEqual(len(quarantines), 0)
        self.assertEqual(canonical[0].duplicate_count, 2)
        dataset = PointInTimeDataset([*market_facts(), *canonical])
        self.assertEqual(dataset.as_of(at(15), "market-a").books["up-market-a"].lineage_count, 1)
        self.assertEqual(dataset.as_of(at(25), "market-a").books["up-market-a"].lineage_count, 2)

    def test_conflicting_business_key_quarantines_without_rewriting_prior_view(self) -> None:
        first = book(at(10), event_id="conflict-a")
        conflict = book(
            at(20),
            bids=[{"price": "0.48", "size": "9"}],
            event_id="conflict-b",
        )
        conflict = conflict.with_business_key(first.business_key)
        canonical, quarantines = canonicalize_records([first, conflict])
        dataset = PointInTimeDataset([*market_facts(), *canonical], quarantines=quarantines)
        self.assertTrue(dataset.as_of(at(15), "market-a").books["up-market-a"].execution_eligible)
        after = dataset.as_of(at(20), "market-a")
        self.assertEqual(after.books["up-market-a"].state, BookState.RESET_REQUIRED)
        self.assertEqual(len(after.quarantines), 1)

    def test_metadata_revisions_obey_observed_at_and_valid_from(self) -> None:
        records = market_facts()
        revision = fact(
            RecordType.MARKET_METADATA,
            "market-metadata:market-a:revision",
            at(200),
            {
                "slug": "btc-updown-5m-revised",
                "interval_start": at(0),
                "interval_end": at(0) + timedelta(minutes=5),
                "oracle_provider": "Chainlink",
                "oracle_pair": "BTC/USD",
                "identity_valid": True,
            },
            observed_at=at(200),
            valid_from=at(250),
        )
        dataset = PointInTimeDataset([*records, revision])
        self.assertNotEqual(dataset.as_of(at(249), "market-a").metadata["slug"], "btc-updown-5m-revised")
        self.assertEqual(dataset.as_of(at(250), "market-a").metadata["slug"], "btc-updown-5m-revised")

    def test_adjacent_five_minute_markets_never_mix(self) -> None:
        second_start = at(0) + timedelta(minutes=5)
        records = [
            *market_facts(),
            *market_facts(
                market_id="market-b",
                condition_id="condition-b",
                start=second_start,
                connection_id="connection-b",
            ),
            book(at(10)),
            book(
                at(10),
                market_id="market-b",
                condition_id="condition-b",
                connection_id="connection-b",
            ),
        ]
        dataset = PointInTimeDataset(records)
        first = dataset.as_of(at(20), "market-a")
        second = dataset.as_of(second_start + timedelta(milliseconds=20), "market-b")
        self.assertEqual(set(first.books), {"up-market-a", "down-market-a"})
        self.assertEqual(set(second.books), {"up-market-b", "down-market-b"})

    def test_up_down_mapping_uses_labels_not_positions(self) -> None:
        mapped = outcome_token_mapping(["Down", "Up"], ["token-down", "token-up"])
        self.assertEqual(mapped, {"up_token_id": "token-up", "down_token_id": "token-down"})

    def test_decimal_and_utc_round_trip_are_exact(self) -> None:
        original = fact(
            RecordType.CHAINLINK_BTC_USD,
            "chainlink:precise",
            at(123),
            {"symbol": "btc/usd", "price": Decimal("67234.500000010000")},
            source_time=at(100),
        )
        restored = NormalizedRecord.from_json_line(original.to_json_line())
        self.assertEqual(restored.payload["price"], "67234.500000010000")
        self.assertEqual(restored.visible_at, at(123))
        self.assertEqual(restored.source_time, at(100))
        self.assertEqual(restored.to_json_line(), original.to_json_line())

    def test_binary_float_is_rejected_at_contract_boundary(self) -> None:
        with self.assertRaisesRegex(ValueError, "binary float"):
            fact(
                RecordType.CHAINLINK_BTC_USD,
                "chainlink:float",
                at(1),
                {"symbol": "btc/usd", "price": 67234.5},
            )

    def test_visible_at_cannot_precede_any_ingress_clock(self) -> None:
        with self.assertRaisesRegex(ValueError, "visible_at"):
            NormalizedRecord.create(
                record_type=RecordType.CONNECTION_STATE,
                business_key="causality-violation",
                market_id="market-a",
                condition_id="condition-a",
                asset_id=None,
                source="fixture.normalized",
                source_time=at(0),
                server_time=at(0),
                receive_time=at(10),
                process_time=at(20),
                persist_time=at(30),
                visible_at=at(20),
                continuity="UNVERIFIED",
                connection_id="connection-a",
                parser_state="parsed",
                payload={"state": "CONNECTED"},
                lineage=(lineage("causality", at(30)),),
            )


if __name__ == "__main__":
    unittest.main()
