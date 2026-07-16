"""Build a content-addressed research dataset from pinned public historical files.

The adapter is deliberately separate from the native public-stream normalizer: third-party sample
time is not receive time, binary-float provenance is never upgraded, and only pre-registered
decision snapshots are materialized. Network acquisition is performed outside this module.
"""

from __future__ import annotations

from array import array
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from hashlib import sha256
import json
import math
from pathlib import Path
from statistics import pstdev
from typing import Any, Mapping
from zipfile import ZipFile

from .historical import (
    DataGateInputs,
    DataGateResult,
    FeeEvidenceGrade,
    HistoricalSourceContract,
    LabelEvidenceGrade,
    OfficialLabelEvidence,
    PRIMARY_START,
    TEST_END,
    classify_regime,
    classify_split,
    evaluate_data_gate,
)


HF_DATASET_BASE_URL = (
    "https://huggingface.co/datasets/kachoio/"
    "polymarket-5-minute-crypto-up-down-markets/resolve"
)


def pinned_hugging_face_url(revision: str, filename: str) -> str:
    """Return an immutable source-file URL, not a mutable dataset landing page."""
    if filename not in {"btc_markets.parquet", "btc_ticks.parquet"}:
        raise ValueError("only pre-registered BTC source files are allowed")
    return f"{HF_DATASET_BASE_URL}/{revision}/{filename}"


UTC = timezone.utc
_LOAD_PROOF = object()
HORIZONS = (60, 30, 15)


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def file_sha256(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def utc_text(value: datetime) -> str:
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError("historical timestamps must be explicit UTC")
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def decimal_text(value: Any) -> str | None:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    return format(Decimal(str(value)), "f")


@dataclass(frozen=True, slots=True)
class HistoricalDatasetReceipt:
    dataset_hash: str
    version_directory: Path
    manifest: Mapping[str, Any]
    _proof: object

    def __post_init__(self) -> None:
        if self._proof is not _LOAD_PROOF:
            raise ValueError("historical receipt can only be issued by verified load")


@dataclass(frozen=True, slots=True)
class HistoricalDataAudit:
    primary_market_count: int
    valid_market_count: int
    official_label_count: int
    official_label_coverage: Decimal
    third_party_null_count: int
    third_party_mismatch_count: int
    identity_conflict_count: int
    excluded_markets: tuple[Mapping[str, str], ...]
    binance_required_points: int
    binance_available_points: int
    binance_coverage: Decimal
    decision_sample_count: int
    gate: DataGateResult

    def to_mapping(self) -> dict[str, Any]:
        return {
            "primary_market_count": self.primary_market_count,
            "valid_market_count": self.valid_market_count,
            "official_label_count": self.official_label_count,
            "official_label_coverage": format(self.official_label_coverage, "f"),
            "third_party_null_count": self.third_party_null_count,
            "third_party_mismatch_count": self.third_party_mismatch_count,
            "identity_conflict_count": self.identity_conflict_count,
            "excluded_markets": list(self.excluded_markets),
            "binance_required_points": self.binance_required_points,
            "binance_available_points": self.binance_available_points,
            "binance_coverage": format(self.binance_coverage, "f"),
            "decision_sample_count": self.decision_sample_count,
            "gate": {"passed": self.gate.passed, "failures": list(self.gate.failures)},
        }


class BinanceOneSecondArchive:
    def __init__(self, directory: Path) -> None:
        self._days: dict[int, array] = {}
        self.checksum_files: list[dict[str, Any]] = []
        for path in sorted(directory.glob("BTCUSDT-1s-*.zip")):
            checksum_path = path.with_name(path.name + ".CHECKSUM")
            if not checksum_path.is_file():
                raise ValueError(f"official Binance checksum missing for {path.name}")
            expected = checksum_path.read_text(encoding="utf-8").split()[0]
            actual = file_sha256(path)
            if expected != actual:
                raise ValueError(f"Binance checksum mismatch for {path.name}")
            date_text = path.stem.removeprefix("BTCUSDT-1s-")
            day = datetime.fromisoformat(date_text).replace(tzinfo=UTC)
            start = int(day.timestamp())
            values = array("d", [math.nan]) * 86_400
            with ZipFile(path) as archive:
                names = archive.namelist()
                if len(names) != 1 or not names[0].endswith(".csv"):
                    raise ValueError(f"unexpected Binance archive inventory: {path.name}")
                with archive.open(names[0]) as stream:
                    for raw in stream:
                        fields = raw.decode("ascii").rstrip("\n").split(",")
                        if len(fields) != 12:
                            raise ValueError(f"unexpected Binance kline row: {path.name}")
                        timestamp = int(fields[0])
                        if timestamp > 10**15:
                            timestamp //= 1_000_000
                        elif timestamp > 10**12:
                            timestamp //= 1_000
                        offset = timestamp - start
                        if 0 <= offset < 86_400:
                            values[offset] = float(fields[4])
            self._days[start] = values
            self.checksum_files.append(
                {
                    "file": path.name,
                    "bytes": path.stat().st_size,
                    "sha256": actual,
                    "checksum_file_sha256": file_sha256(checksum_path),
                }
            )

    def price(self, timestamp: int) -> float | None:
        day = timestamp - timestamp % 86_400
        values = self._days.get(day)
        if values is None:
            return None
        value = values[timestamp - day]
        return None if math.isnan(value) else value

    def features(self, market_start: int, decision_time: int) -> dict[str, Any] | None:
        start_price = self.price(market_start)
        current_price = self.price(decision_time - 1)
        if start_price is None or current_price is None:
            return None
        result: dict[str, Any] = {
            "start_price": decimal_text(start_price),
            "current_price": decimal_text(current_price),
            "log_return_from_start": math.log(current_price / start_price),
        }
        for window in (30, 60, 120):
            prices = [self.price(second) for second in range(decision_time - window - 1, decision_time)]
            if any(value is None for value in prices):
                return None
            returns = [math.log(prices[index] / prices[index - 1]) for index in range(1, len(prices))]
            result[f"realized_vol_{window}s"] = pstdev(returns) if returns else 0.0
        return result


def _official_events(directory: Path) -> tuple[dict[str, tuple[Mapping[str, Any], str]], list[dict[str, Any]]]:
    events: dict[str, tuple[Mapping[str, Any], str]] = {}
    inventory: list[dict[str, Any]] = []
    for path in sorted(directory.glob("date=*/page-*.json")):
        raw = path.read_bytes()
        digest = sha256(raw).hexdigest()
        payload = json.loads(raw)
        if not isinstance(payload, list):
            raise ValueError(f"official Gamma response is not a list: {path}")
        inventory.append(
            {
                "path": str(path.relative_to(directory)),
                "bytes": len(raw),
                "sha256": digest,
                "fetch_time": utc_text(datetime.fromtimestamp(path.stat().st_mtime, UTC)),
            }
        )
        for event in payload:
            slug = event.get("slug")
            if isinstance(slug, str):
                previous = events.get(slug)
                if previous is None:
                    events[slug] = (event, digest)
                else:
                    previous_markets = previous[0].get("markets", [])
                    current_markets = event.get("markets", [])
                    if len(previous_markets) != 1 or len(current_markets) != 1:
                        raise ValueError(f"ambiguous duplicate official event for {slug}")
                    stable_fields = (
                        "conditionId",
                        "slug",
                        "closed",
                        "outcomes",
                        "outcomePrices",
                        "clobTokenIds",
                        "feesEnabled",
                        "feeSchedule",
                        "eventStartTime",
                        "endDate",
                    )
                    if any(
                        canonical_json(previous_markets[0].get(field))
                        != canonical_json(current_markets[0].get(field))
                        for field in stable_fields
                    ):
                        raise ValueError(f"conflicting official market evidence for {slug}")
    return events, inventory


class ExternalHistoricalDatasetAdapter:
    EXPECTED_MARKET_SCHEMA = {
        "condition_id": "string",
        "event_id": "string",
        "slug": "string",
        "market_start": "timestamp[ns, tz=UTC]",
        "market_end": "timestamp[ns, tz=UTC]",
        "recorded_at": "timestamp[ns, tz=UTC]",
        "token_up": "string",
        "token_down": "string",
        "volume": "double",
        "liquidity": "double",
        "outcome": "string",
        "n_ticks": "int64",
    }

    def __init__(self, source: HistoricalSourceContract) -> None:
        self.source = source

    @staticmethod
    def _import_arrow() -> tuple[Any, Any]:
        try:
            import pyarrow.compute as pc
            import pyarrow.parquet as pq
        except ImportError as exc:
            raise RuntimeError("Batch 3B requires the historical pyarrow extra") from exc
        return pc, pq

    def _verify_source(self, markets_path: Path, ticks_path: Path) -> None:
        if file_sha256(markets_path) != self.source.markets_sha256:
            raise ValueError("pinned historical markets SHA-256 mismatch")
        if file_sha256(ticks_path) != self.source.ticks_sha256:
            raise ValueError("pinned historical ticks SHA-256 mismatch")

    def build(
        self,
        *,
        markets_path: Path,
        ticks_path: Path,
        gamma_directory: Path,
        binance_directory: Path,
        output_root: Path,
        build_commit: str,
    ) -> tuple[Path, HistoricalDataAudit]:
        self._verify_source(markets_path, ticks_path)
        pc, pq = self._import_arrow()
        market_file = pq.ParquetFile(markets_path)
        schema = {field.name: str(field.type) for field in market_file.schema_arrow}
        if schema != self.EXPECTED_MARKET_SCHEMA:
            raise ValueError("third-party markets parquet schema drifted")
        tick_schema = {field.name: str(field.type) for field in pq.ParquetFile(ticks_path).schema_arrow}
        required_tick_fields = {
            "condition_id": "string",
            "t": "int64",
            "bu": "double",
            "au": "double",
            "bd": "double",
            "ad": "double",
            "su": "double",
            "sd": "double",
            "sau": "double",
            "sad": "double",
        }
        if any(tick_schema.get(key) != value for key, value in required_tick_fields.items()):
            raise ValueError("third-party ticks parquet schema drifted")

        table = pq.read_table(markets_path)
        mask = pc.and_(
            pc.greater_equal(table["market_start"], PRIMARY_START),
            pc.less(table["market_start"], TEST_END),
        )
        markets = table.filter(mask).to_pylist()
        if len({item["condition_id"] for item in markets}) != len(markets):
            raise ValueError("historical condition_id is not unique")
        if len({item["slug"] for item in markets}) != len(markets):
            raise ValueError("historical slug is not unique")

        events, gamma_inventory = _official_events(gamma_directory)
        fetched_at = max(
            datetime.fromisoformat(item["fetch_time"].replace("Z", "+00:00"))
            for item in gamma_inventory
        )
        labels: dict[str, OfficialLabelEvidence] = {}
        fees: dict[str, dict[str, Any]] = {}
        excluded: list[dict[str, str]] = []
        mismatches = 0
        nulls = 0
        identity_conflicts = 0
        label_rows: list[dict[str, Any]] = []
        for market in markets:
            if market["outcome"] is None:
                nulls += 1
            event_entry = events.get(market["slug"])
            if event_entry is None or len(event_entry[0].get("markets", [])) != 1:
                excluded.append({"condition_id": market["condition_id"], "reason": "OFFICIAL_EVENT_MISSING"})
                continue
            event, response_hash = event_entry
            official_market = event["markets"][0]
            try:
                evidence = OfficialLabelEvidence.from_gamma_market(
                    expected_condition_id=market["condition_id"],
                    expected_slug=market["slug"],
                    expected_start=market["market_start"],
                    expected_end=market["market_end"],
                    expected_up_token=market["token_up"],
                    expected_down_token=market["token_down"],
                    fetched_at=fetched_at,
                    response_sha256=response_hash,
                    market=official_market,
                )
            except (KeyError, TypeError, ValueError) as exc:
                identity_conflicts += 1
                excluded.append({"condition_id": market["condition_id"], "reason": str(exc)})
                continue
            labels[market["condition_id"]] = evidence
            if market["outcome"] is not None and market["outcome"] != evidence.winner:
                mismatches += 1
            schedule = official_market.get("feeSchedule")
            if official_market.get("feesEnabled") is True and isinstance(schedule, dict):
                fee_rate = Decimal(str(schedule.get("rate")))
                grade = FeeEvidenceGrade.MARKET_STATIC_OFFICIAL
            else:
                fee_rate = None
                grade = FeeEvidenceGrade.UNKNOWN
            fees[market["condition_id"]] = {
                "grade": grade.value,
                "fee_rate": decimal_text(fee_rate),
                "fees_enabled": official_market.get("feesEnabled"),
                "fee_schedule": schedule,
                "maker_base_fee": official_market.get("makerBaseFee"),
                "taker_base_fee": official_market.get("takerBaseFee"),
                "source_response_sha256": response_hash,
                "fetch_time": utc_text(fetched_at),
            }
            label_rows.append(
                {
                    "condition_id": market["condition_id"],
                    "slug": market["slug"],
                    "grade": evidence.grade.value,
                    "winner": evidence.winner,
                    "source_response_sha256": response_hash,
                    "third_party_outcome_comparison": market["outcome"],
                    "third_party_matches_official": (
                        None if market["outcome"] is None else market["outcome"] == evidence.winner
                    ),
                }
            )

        target_times: dict[str, set[int]] = {}
        market_by_condition = {item["condition_id"]: item for item in markets if item["condition_id"] in labels}
        for condition_id, market in market_by_condition.items():
            end = int(market["market_end"].timestamp())
            times: set[int] = set()
            for horizon in HORIZONS:
                decision = end - horizon
                times.update({decision - 2, decision - 1, decision, decision + 1})
            target_times[condition_id] = times

        tick_lookup: dict[tuple[str, int], dict[str, str | None]] = {}
        columns = ["condition_id", "t", "bu", "au", "bd", "ad", "su", "sd", "sau", "sad"]
        for batch in pq.ParquetFile(ticks_path).iter_batches(batch_size=131_072, columns=columns):
            data = batch.to_pydict()
            for index, condition_id in enumerate(data["condition_id"]):
                timestamp = data["t"][index]
                if timestamp in target_times.get(condition_id, ()):
                    tick_lookup[(condition_id, timestamp)] = {
                        key: decimal_text(data[key][index]) for key in columns[2:]
                    }

        binance = BinanceOneSecondArchive(binance_directory)
        sample_rows: list[dict[str, Any]] = []
        required_binance = len(market_by_condition) * len(HORIZONS)
        available_binance = 0
        valid_conditions: set[str] = set()
        for condition_id, market in market_by_condition.items():
            start = int(market["market_start"].timestamp())
            end = int(market["market_end"].timestamp())
            market_rows: list[dict[str, Any]] = []
            complete = True
            features_by_horizon: dict[int, dict[str, Any] | None] = {}
            for horizon in HORIZONS:
                decision = end - horizon
                feature_values = binance.features(start, decision)
                features_by_horizon[horizon] = feature_values
                if feature_values is not None:
                    available_binance += 1
            if any(value is None for value in features_by_horizon.values()):
                complete = False
            for horizon in HORIZONS:
                decision = end - horizon
                feature_values = features_by_horizon[horizon]
                if feature_values is None:
                    break
                books = {
                    "decision_plus_1s_visibility": tick_lookup.get((condition_id, decision - 1)),
                    "decision_plus_2s_visibility": tick_lookup.get((condition_id, decision - 2)),
                    "execution_debug_0s": tick_lookup.get((condition_id, decision)),
                    "execution_base_1s": tick_lookup.get((condition_id, decision)),
                    "execution_conservative_2s": tick_lookup.get((condition_id, decision + 1)),
                }
                decision_book = books["decision_plus_1s_visibility"]
                required_decision_fields = ("bu", "au", "bd", "ad")
                if (
                    decision_book is None
                    or any(decision_book.get(field) is None for field in required_decision_fields)
                    or Decimal(decision_book["bu"]) > Decimal(decision_book["au"])
                    or Decimal(decision_book["bd"]) > Decimal(decision_book["ad"])
                ):
                    complete = False
                    break
                market_rows.append(
                    {
                        "condition_id": condition_id,
                        "slug": market["slug"],
                        "market_start": utc_text(market["market_start"]),
                        "market_end": utc_text(market["market_end"]),
                        "regime": classify_regime(market["market_start"]).value,
                        "split": classify_split(market["market_start"]).value,
                        "horizon_seconds": horizon,
                        "decision_time": utc_text(datetime.fromtimestamp(decision, UTC)),
                        "visibility_scenario": "SAMPLE_TIME_PLUS_1S",
                        "books": books,
                        "binance": feature_values,
                        "official_label_grade": LabelEvidenceGrade.OFFICIAL_RESOLUTION.value,
                        "winner": labels[condition_id].winner,
                        "fee_evidence": fees[condition_id],
                    }
                )
            if complete and len(market_rows) == len(HORIZONS):
                sample_rows.extend(market_rows)
                valid_conditions.add(condition_id)
            else:
                excluded.append({"condition_id": condition_id, "reason": "DECISION_SAMPLE_INCOMPLETE"})

        label_coverage = Decimal(len(labels)) / Decimal(len(markets)) if markets else Decimal("0")
        binance_coverage = (
            Decimal(available_binance) / Decimal(required_binance)
            if required_binance
            else Decimal("0")
        )
        gate = evaluate_data_gate(
            DataGateInputs(
                primary_market_count=len(valid_conditions),
                official_label_coverage=label_coverage,
                identity_unique=True,
                train_test_overlap=False,
                binance_coverage=binance_coverage,
                future_data_count=0,
                auditable_exclusions=True,
                decision_horizons=frozenset(
                    item["horizon_seconds"] for item in sample_rows
                ),
            )
        )
        audit = HistoricalDataAudit(
            primary_market_count=len(markets),
            valid_market_count=len(valid_conditions),
            official_label_count=len(labels),
            official_label_coverage=label_coverage,
            third_party_null_count=nulls,
            third_party_mismatch_count=mismatches,
            identity_conflict_count=identity_conflicts,
            excluded_markets=tuple(excluded),
            binance_required_points=required_binance,
            binance_available_points=available_binance,
            binance_coverage=binance_coverage,
            decision_sample_count=len(sample_rows),
            gate=gate,
        )

        sample_bytes = b"".join(
            (canonical_json(item) + "\n").encode("utf-8")
            for item in sorted(sample_rows, key=lambda row: (row["market_start"], row["horizon_seconds"]))
        )
        label_bytes = b"".join(
            (canonical_json(item) + "\n").encode("utf-8")
            for item in sorted(label_rows, key=lambda row: row["condition_id"])
        )
        manifest_core = {
            "schema_version": "external-historical-normalized-v1",
            "dataset_id": "btc-5m-primary-v2-baseline-samples",
            "build_commit": build_commit,
            "source_contract": self.source.to_mapping(),
            "source_files": {
                "markets": {
                    "url": pinned_hugging_face_url(
                        self.source.revision, "btc_markets.parquet"
                    ),
                    "bytes": markets_path.stat().st_size,
                    "sha256": self.source.markets_sha256,
                },
                "ticks": {
                    "url": pinned_hugging_face_url(
                        self.source.revision, "btc_ticks.parquet"
                    ),
                    "bytes": ticks_path.stat().st_size,
                    "sha256": self.source.ticks_sha256,
                },
            },
            "official_gamma_responses": gamma_inventory,
            "binance_official_archives": binance.checksum_files,
            "study_window": {"start": utc_text(PRIMARY_START), "end_exclusive": utc_text(TEST_END)},
            "horizons_seconds": list(HORIZONS),
            "headline_visibility": "SAMPLE_TIME_PLUS_1S",
            "audit": audit.to_mapping(),
            "outputs": {
                "decision_samples.jsonl": {"bytes": len(sample_bytes), "rows": len(sample_rows), "sha256": sha256(sample_bytes).hexdigest()},
                "label_evidence.jsonl": {"bytes": len(label_bytes), "rows": len(label_rows), "sha256": sha256(label_bytes).hexdigest()},
            },
        }
        dataset_hash = sha256(canonical_json(manifest_core).encode("utf-8")).hexdigest()
        manifest = {**manifest_core, "dataset_hash": dataset_hash}
        version = output_root / "normalized" / "dataset_id=btc-5m-primary-v2-baseline-samples" / f"version={dataset_hash}"
        version.mkdir(parents=True, exist_ok=False)
        (version / "decision_samples.jsonl").write_bytes(sample_bytes)
        (version / "label_evidence.jsonl").write_bytes(label_bytes)
        (version / "manifest.json").write_text(canonical_json(manifest) + "\n", encoding="utf-8")
        return version, audit

    @staticmethod
    def load(version: Path) -> tuple[HistoricalDatasetReceipt, tuple[Mapping[str, Any], ...]]:
        manifest_path = version / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        dataset_hash = manifest.pop("dataset_hash")
        if version.name != f"version={dataset_hash}":
            raise ValueError("historical version directory does not match dataset hash")
        if sha256(canonical_json(manifest).encode("utf-8")).hexdigest() != dataset_hash:
            raise ValueError("historical normalized manifest hash mismatch")
        output = manifest["outputs"]["decision_samples.jsonl"]
        sample_path = version / "decision_samples.jsonl"
        raw = sample_path.read_bytes()
        if len(raw) != output["bytes"] or sha256(raw).hexdigest() != output["sha256"]:
            raise ValueError("historical decision sample output mismatch")
        rows = tuple(json.loads(line) for line in raw.splitlines())
        if len(rows) != output["rows"]:
            raise ValueError("historical decision sample row count mismatch")
        label_output = manifest["outputs"]["label_evidence.jsonl"]
        label_raw = (version / "label_evidence.jsonl").read_bytes()
        if (
            len(label_raw) != label_output["bytes"]
            or sha256(label_raw).hexdigest() != label_output["sha256"]
            or len(label_raw.splitlines()) != label_output["rows"]
        ):
            raise ValueError("historical label evidence output mismatch")
        restored = {**manifest, "dataset_hash": dataset_hash}
        return HistoricalDatasetReceipt(dataset_hash, version, restored, _LOAD_PROOF), rows
