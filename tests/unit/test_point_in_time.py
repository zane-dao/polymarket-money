from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
import unittest

from research.polymarket_money.normalized import (
    BookState,
    NormalizedRecord,
    PointInTimeDataset,
    QuarantineRecord,
    RawLineage,
    RecordType,
    canonicalize_records,
    outcome_token_mapping,
)


UTC = timezone.utc


def at(milliseconds: int) -> datetime:
    return datetime(2026, 7, 15, 0, 0, 0, milliseconds * 1_000, tzinfo=UTC)


def lineage(
    name: str,
    visible_at: datetime,
    *,
    line_ordinal: int = 0,
    source_manifest_id: str = "manifest-a",
) -> RawLineage:
    digit = f"{sum(name.encode('utf-8')) % 16:x}"
    return RawLineage(
        source_manifest_id=source_manifest_id,
        source_manifest_sha256="a" * 64,
        segment_sha256="b" * 64,
        event_id=name,
        raw_sha256=digit * 64,
        visible_at=visible_at,
        line_ordinal=line_ordinal,
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
    line_ordinal: int = 0,
    source_manifest_id: str = "manifest-a",
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
        lineage=(
            lineage(
                event_id or business_key,
                visible_at,
                line_ordinal=line_ordinal,
                source_manifest_id=source_manifest_id,
            ),
        ),
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
                "active": True,
                "closed": False,
                "accepting_orders": True,
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
    event_id: str | None = None,
    line_ordinal: int = 0,
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
        event_id=event_id,
        line_ordinal=line_ordinal,
    )


def book_pair(visible_at: datetime) -> list[NormalizedRecord]:
    return [book(visible_at), book(visible_at, asset_id="down-market-a")]


class PointInTimeDatasetTest(unittest.TestCase):
    def test_execution_requires_open_accepting_market_inside_window(self) -> None:
        baseline = market_facts()
        ready = [*baseline, *book_pair(at(10))]
        self.assertTrue(
            PointInTimeDataset(ready, stale_after=timedelta(minutes=10))
            .as_of(at(11), "market-a")
            .books["up-market-a"]
            .execution_eligible
        )
        metadata = baseline[0]
        for field_name, value in (
            ("active", False),
            ("closed", True),
            ("accepting_orders", False),
        ):
            with self.subTest(field_name=field_name):
                changed = NormalizedRecord.create(
                    record_type=metadata.record_type,
                    business_key=metadata.business_key,
                    market_id=metadata.market_id,
                    condition_id=metadata.condition_id,
                    asset_id=metadata.asset_id,
                    source=metadata.source,
                    source_time=metadata.source_time,
                    server_time=metadata.server_time,
                    receive_time=metadata.receive_time,
                    process_time=metadata.process_time,
                    persist_time=metadata.persist_time,
                    visible_at=metadata.visible_at,
                    continuity=metadata.continuity,
                    connection_id=metadata.connection_id,
                    parser_state=metadata.parser_state,
                    observed_at=metadata.observed_at,
                    valid_from=metadata.valid_from,
                    payload={**metadata.payload, field_name: value},
                    lineage=metadata.lineage,
                )
                view = PointInTimeDataset(
                    [changed, *baseline[1:], *book_pair(at(10))],
                    stale_after=timedelta(minutes=10),
                ).as_of(at(11), "market-a")
                self.assertFalse(view.books["up-market-a"].execution_eligible)
        end = at(0) + timedelta(minutes=5)
        after_window = PointInTimeDataset(
            ready, stale_after=timedelta(minutes=10)
        ).as_of(end, "market-a")
        self.assertFalse(after_window.books["up-market-a"].execution_eligible)

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

    def test_late_older_price_does_not_replace_newer_source_observation(self) -> None:
        newer = fact(
            RecordType.CHAINLINK_BTC_USD,
            "chainlink:newer",
            at(100),
            {"symbol": "btc/usd", "price": "68000"},
            source_time=at(90),
        )
        older_late = fact(
            RecordType.CHAINLINK_BTC_USD,
            "chainlink:older-late",
            at(200),
            {"symbol": "btc/usd", "price": "67000"},
            source_time=at(80),
        )
        dataset = PointInTimeDataset([*market_facts(), newer, older_late])
        self.assertEqual(dataset.as_of(at(250), "market-a").chainlink_price, Decimal("68000"))

    def test_future_source_time_is_rejected_even_when_already_received(self) -> None:
        future = fact(
            RecordType.CHAINLINK_BTC_USD,
            "chainlink:future-clock",
            at(100),
            {"symbol": "btc/usd", "price": "68000.25"},
            source_time=at(300),
        )
        dataset = PointInTimeDataset([*market_facts(), future])
        self.assertIsNone(dataset.as_of(at(299), "market-a").chainlink_price)
        self.assertEqual(dataset.as_of(at(300), "market-a").chainlink_price, Decimal("68000.25"))

    def test_reconnect_without_current_snapshot_is_not_executable(self) -> None:
        records = [*market_facts(), *book_pair(at(100))]
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

    def test_reused_connection_id_cannot_revive_pre_reconnect_book(self) -> None:
        records = [*market_facts(), *book_pair(at(100))]
        records.append(
            fact(
                RecordType.CONNECTION_STATE,
                "connection:connection-a:reopen",
                at(200),
                {"state": "CONNECTED"},
                connection_id="connection-a",
            )
        )
        view = PointInTimeDataset(records).as_of(at(250), "market-a")
        self.assertEqual(view.books["up-market-a"].state, BookState.WAITING_FOR_SNAPSHOT)
        self.assertIsNone(view.books["up-market-a"].best_bid)

    def test_same_millisecond_reopen_cannot_revive_earlier_book(self) -> None:
        timestamp = at(100)
        records = [
            *market_facts(),
            fact(
                RecordType.CONNECTION_STATE,
                "connection:connection-a:same-ms-open",
                timestamp,
                {"state": "CONNECTED"},
                line_ordinal=0,
            ),
            book(timestamp, line_ordinal=1),
            book(timestamp, asset_id="down-market-a", line_ordinal=2),
            fact(
                RecordType.CONNECTION_STATE,
                "connection:connection-a:same-ms-close",
                timestamp,
                {"state": "DISCONNECTED"},
                line_ordinal=3,
            ),
            fact(
                RecordType.CONNECTION_STATE,
                "connection:connection-a:same-ms-reopen",
                timestamp,
                {"state": "CONNECTED"},
                line_ordinal=4,
            ),
        ]
        view = PointInTimeDataset(records).as_of(at(101), "market-a")
        self.assertEqual(view.books["up-market-a"].state, BookState.WAITING_FOR_SNAPSHOT)
        self.assertIsNone(view.books["up-market-a"].best_bid)

    def test_incomparable_cross_manifest_connection_tie_fails_closed(self) -> None:
        timestamp = at(100)
        records = [
            *market_facts(),
            *book_pair(timestamp),
            fact(
                RecordType.CONNECTION_STATE,
                "connection:tie:open",
                timestamp,
                {"state": "CONNECTED"},
                connection_id="tie-open",
                source_manifest_id="manifest-open",
            ),
            fact(
                RecordType.CONNECTION_STATE,
                "connection:tie:close",
                timestamp,
                {"state": "DISCONNECTED"},
                connection_id="tie-close",
                source_manifest_id="manifest-close",
            ),
        ]
        view = PointInTimeDataset(records).as_of(at(101), "market-a")
        self.assertTrue(view.books)
        self.assertTrue(
            all(item.state is BookState.RESET_REQUIRED for item in view.books.values())
        )
        self.assertTrue(
            all(not item.execution_eligible for item in view.books.values())
        )

    def test_book_without_full_snapshot_marker_remains_waiting(self) -> None:
        incomplete = book(at(100))
        incomplete = NormalizedRecord.create(
            record_type=incomplete.record_type,
            business_key=incomplete.business_key,
            market_id=incomplete.market_id,
            condition_id=incomplete.condition_id,
            asset_id=incomplete.asset_id,
            source=incomplete.source,
            source_time=incomplete.source_time,
            server_time=incomplete.server_time,
            receive_time=incomplete.receive_time,
            process_time=incomplete.process_time,
            persist_time=incomplete.persist_time,
            visible_at=incomplete.visible_at,
            continuity=incomplete.continuity,
            connection_id=incomplete.connection_id,
            parser_state=incomplete.parser_state,
            payload={**incomplete.payload, "snapshot_received": False},
            lineage=incomplete.lineage,
        )
        state = PointInTimeDataset(
            [*market_facts(), incomplete, book(at(100), asset_id="down-market-a")]
        ).as_of(at(101), "market-a").books["up-market-a"]
        self.assertEqual(state.state, BookState.WAITING_FOR_SNAPSHOT)
        self.assertFalse(state.execution_eligible)

    def test_disconnected_old_book_is_not_executable(self) -> None:
        records = [*market_facts(), *book_pair(at(100))]
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
            [*market_facts(), *book_pair(at(100))],
            stale_after=timedelta(milliseconds=100),
        )
        fresh = dataset.as_of(at(199), "market-a").books["up-market-a"]
        stale = dataset.as_of(at(200), "market-a").books["up-market-a"]
        self.assertEqual(fresh.state, BookState.ACTIVE_UNVERIFIED)
        self.assertEqual(stale.state, BookState.STALE)
        self.assertFalse(stale.execution_eligible)

    def test_one_stale_token_fails_closed_for_both_outcomes(self) -> None:
        dataset = PointInTimeDataset(
            [
                *market_facts(),
                book(at(100)),
                book(at(150), asset_id="down-market-a"),
            ],
            stale_after=timedelta(milliseconds=80),
        )
        view = dataset.as_of(at(200), "market-a")
        self.assertTrue(all(item.state is BookState.STALE for item in view.books.values()))
        self.assertTrue(all(not item.execution_eligible for item in view.books.values()))

    def test_empty_side_has_no_midpoint_and_is_not_executable(self) -> None:
        for bids, asks in (([], [{"price": "0.51", "size": "1"}]), ([{"price": "0.49", "size": "1"}], [])):
            with self.subTest(bids=bids, asks=asks):
                state = PointInTimeDataset(
                    [
                        *market_facts(),
                        book(at(10), bids=bids, asks=asks),
                        book(at(10), asset_id="down-market-a"),
                    ]
                ).as_of(at(11), "market-a").books["up-market-a"]
                self.assertIsNone(state.midpoint)
                self.assertFalse(state.execution_eligible)
                view = PointInTimeDataset(
                    [
                        *market_facts(),
                        book(at(10), bids=bids, asks=asks),
                        book(at(10), asset_id="down-market-a"),
                    ]
                ).as_of(at(11), "market-a")
                self.assertTrue(
                    all(item.state is BookState.UNTRADEABLE for item in view.books.values())
                )

    def test_crossed_book_is_reset_required_and_not_executable(self) -> None:
        crossed = book(
            at(10),
            bids=[{"price": "0.60", "size": "1"}],
            asks=[{"price": "0.50", "size": "1"}],
        )
        state = PointInTimeDataset(
            [*market_facts(), crossed, book(at(10), asset_id="down-market-a")]
        ).as_of(at(11), "market-a").books["up-market-a"]
        self.assertEqual(state.state, BookState.RESET_REQUIRED)
        self.assertFalse(state.execution_eligible)
        sibling = PointInTimeDataset(
            [*market_facts(), crossed, book(at(10), asset_id="down-market-a")]
        ).as_of(at(11), "market-a").books["down-market-a"]
        self.assertEqual(sibling.state, BookState.RESET_REQUIRED)
        self.assertFalse(sibling.execution_eligible)

    def test_continuity_can_never_be_upgraded(self) -> None:
        view = PointInTimeDataset([*market_facts(), *book_pair(at(10))]).as_of(
            at(11), "market-a"
        )
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
        dataset = PointInTimeDataset(
            [*market_facts(), *canonical, book(at(10), asset_id="down-market-a")]
        )
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
        dataset = PointInTimeDataset(
            [*market_facts(), *canonical, book(at(10), asset_id="down-market-a")],
            quarantines=quarantines,
        )
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

    def test_dependency_lineage_round_trip_and_causal_visibility_are_exact(self) -> None:
        dependency = lineage("gamma-dependency", at(90))
        original = NormalizedRecord.create(
            record_type=RecordType.CHAINLINK_BTC_USD,
            business_key="chainlink:dependency",
            market_id="market-a",
            condition_id="condition-a",
            asset_id=None,
            source="fixture.normalized",
            source_time=at(95),
            server_time=None,
            receive_time=at(100),
            process_time=at(100),
            persist_time=at(100),
            visible_at=at(100),
            continuity="UNVERIFIED",
            connection_id="chainlink-connection",
            parser_state="parsed",
            payload={"symbol": "btc/usd", "price": "67234.5"},
            lineage=(lineage("chainlink-raw", at(100)),),
            dependency_lineage=(dependency,),
        )
        restored = NormalizedRecord.from_json_line(original.to_json_line())
        self.assertEqual(restored.dependency_lineage, (dependency,))
        self.assertEqual(restored.to_json_line(), original.to_json_line())

        with self.assertRaisesRegex(ValueError, "dependency lineage"):
            NormalizedRecord.create(
                record_type=original.record_type,
                business_key="chainlink:future-dependency",
                market_id=original.market_id,
                condition_id=original.condition_id,
                asset_id=original.asset_id,
                source=original.source,
                source_time=original.source_time,
                server_time=original.server_time,
                receive_time=original.receive_time,
                process_time=original.process_time,
                persist_time=original.persist_time,
                visible_at=original.visible_at,
                continuity=original.continuity,
                connection_id=original.connection_id,
                parser_state=original.parser_state,
                payload=original.payload,
                lineage=original.lineage,
                dependency_lineage=(lineage("future-gamma", at(101)),),
            )

    def test_quarantine_cannot_precede_its_triggering_raw_lineage(self) -> None:
        with self.assertRaisesRegex(ValueError, "triggering raw lineage"):
            QuarantineRecord.create(
                reason_code="FUTURE_QUARANTINE",
                business_key="future-quarantine",
                market_id="market-a",
                asset_id=None,
                visible_at=at(100),
                affected_record_ids=(),
                lineage=(lineage("future-trigger", at(101)),),
            )

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

    def test_observed_at_cannot_leak_a_future_metadata_revision(self) -> None:
        with self.assertRaisesRegex(ValueError, "observed_at"):
            fact(
                RecordType.MARKET_METADATA,
                "future-observation",
                at(10),
                {"identity_valid": True},
                observed_at=at(20),
                valid_from=at(0),
            )


if __name__ == "__main__":
    unittest.main()
