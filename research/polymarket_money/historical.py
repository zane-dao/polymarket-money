"""Contracts for third-party historical samples and fail-closed research admission.

This module is offline-only. It defines provenance, visibility, label, fee, regime, and top-of-book
execution semantics without performing network I/O or reading environment variables.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from enum import Enum
import json
from typing import Any, Mapping, Sequence

from .domain import require_decimal, require_utc


UTC = timezone.utc


class LabelEvidenceGrade(str, Enum):
    OFFICIAL_RESOLUTION = "OFFICIAL_RESOLUTION"
    ORACLE_PRICE_VERIFIED = "ORACLE_PRICE_VERIFIED"
    THIRD_PARTY_INFERRED = "THIRD_PARTY_INFERRED"
    UNKNOWN = "UNKNOWN"


class FeeEvidenceGrade(str, Enum):
    POINT_IN_TIME_OFFICIAL = "POINT_IN_TIME_OFFICIAL"
    MARKET_STATIC_OFFICIAL = "MARKET_STATIC_OFFICIAL"
    CHANGELOG_SUPPORTED_SCENARIO = "CHANGELOG_SUPPORTED_SCENARIO"
    CURRENT_POSTHOC_ONLY = "CURRENT_POSTHOC_ONLY"
    UNKNOWN = "UNKNOWN"


class VisibilityScenario(str, Enum):
    SAMPLE_TIME_0S = "SAMPLE_TIME_0S"
    SAMPLE_TIME_PLUS_1S = "SAMPLE_TIME_PLUS_1S"
    SAMPLE_TIME_PLUS_2S = "SAMPLE_TIME_PLUS_2S"

    @property
    def delay(self) -> timedelta:
        return {
            VisibilityScenario.SAMPLE_TIME_0S: timedelta(0),
            VisibilityScenario.SAMPLE_TIME_PLUS_1S: timedelta(seconds=1),
            VisibilityScenario.SAMPLE_TIME_PLUS_2S: timedelta(seconds=2),
        }[self]


class TopOfBookExecutionScenario(str, Enum):
    DEBUG_0S = "DEBUG_0S"
    BASE_1S = "BASE_1S"
    CONSERVATIVE_2S = "CONSERVATIVE_2S"
    STRESS_1S_PLUS_TICK = "STRESS_1S_PLUS_TICK"

    @property
    def latency(self) -> timedelta:
        return {
            TopOfBookExecutionScenario.DEBUG_0S: timedelta(0),
            TopOfBookExecutionScenario.BASE_1S: timedelta(seconds=1),
            TopOfBookExecutionScenario.CONSERVATIVE_2S: timedelta(seconds=2),
            TopOfBookExecutionScenario.STRESS_1S_PLUS_TICK: timedelta(seconds=1),
        }[self]


class Regime(str, Enum):
    PRE_V2 = "PRE_V2"
    CUTOVER_EXCLUDED = "CUTOVER_EXCLUDED"
    PRIMARY_V2 = "PRIMARY_V2"
    OUTSIDE_STUDY = "OUTSIDE_STUDY"


class ResearchSplit(str, Enum):
    TRAIN = "TRAIN"
    VALIDATION = "VALIDATION"
    FINAL_TEST = "FINAL_TEST"
    OUTSIDE_SPLIT = "OUTSIDE_SPLIT"


PRE_START = datetime(2026, 3, 24, tzinfo=UTC)
CUTOVER_START = datetime(2026, 4, 28, tzinfo=UTC)
PRIMARY_START = datetime(2026, 4, 29, tzinfo=UTC)
TRAIN_END = datetime(2026, 5, 9, tzinfo=UTC)
VALIDATION_END = datetime(2026, 5, 14, tzinfo=UTC)
TEST_END = datetime(2026, 5, 19, tzinfo=UTC)


def classify_regime(value: datetime) -> Regime:
    require_utc(value, "market_start")
    if PRE_START <= value < CUTOVER_START:
        return Regime.PRE_V2
    if CUTOVER_START <= value < PRIMARY_START:
        return Regime.CUTOVER_EXCLUDED
    if PRIMARY_START <= value < TEST_END:
        return Regime.PRIMARY_V2
    return Regime.OUTSIDE_STUDY


def classify_split(value: datetime) -> ResearchSplit:
    require_utc(value, "market_start")
    if PRIMARY_START <= value < TRAIN_END:
        return ResearchSplit.TRAIN
    if TRAIN_END <= value < VALIDATION_END:
        return ResearchSplit.VALIDATION
    if VALIDATION_END <= value < TEST_END:
        return ResearchSplit.FINAL_TEST
    return ResearchSplit.OUTSIDE_SPLIT


@dataclass(frozen=True, slots=True)
class HistoricalSourceContract:
    source_dataset_revision: str
    markets_sha256: str
    ticks_sha256: str
    source_numeric_type: str
    continuity: str
    visibility_evidence: str
    sampling_interval: timedelta
    depth_scope: str
    receive_time: str
    full_l2_available: bool

    @classmethod
    def required(
        cls, *, revision: str, markets_sha256: str, ticks_sha256: str
    ) -> "HistoricalSourceContract":
        if len(revision) != 40 or any(len(item) != 64 for item in (markets_sha256, ticks_sha256)):
            raise ValueError("source revision and file SHA-256 values are required")
        return cls(
            source_dataset_revision=revision,
            markets_sha256=markets_sha256,
            ticks_sha256=ticks_sha256,
            source_numeric_type="BINARY_FLOAT_SOURCE",
            continuity="UNVERIFIED",
            visibility_evidence="THIRD_PARTY_SAMPLE_TIME",
            sampling_interval=timedelta(seconds=1),
            depth_scope="TOP_OF_BOOK_ONLY",
            receive_time="UNOBSERVED",
            full_l2_available=False,
        )

    def to_mapping(self) -> dict[str, Any]:
        return {
            "source_dataset_revision": self.source_dataset_revision,
            "source_file_sha256": {
                "markets": self.markets_sha256,
                "ticks": self.ticks_sha256,
            },
            "source_numeric_type": self.source_numeric_type,
            "continuity": self.continuity,
            "visibility_evidence": self.visibility_evidence,
            "sampling_interval": "1s",
            "depth_scope": self.depth_scope,
            "receive_time": self.receive_time,
            "full_l2_available": self.full_l2_available,
        }


def _json_list(value: Any, field: str) -> list[Any]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{field} is not valid JSON") from exc
    if not isinstance(value, list):
        raise ValueError(f"{field} must be a list")
    return value


def _official_time(value: Any, field: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be an official UTC timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    require_utc(parsed, field)
    return parsed


@dataclass(frozen=True, slots=True)
class OfficialLabelEvidence:
    grade: LabelEvidenceGrade
    winner: str | None
    condition_id: str | None
    response_sha256: str | None
    reason: str | None = None

    @property
    def headline_eligible(self) -> bool:
        return self.grade in {
            LabelEvidenceGrade.OFFICIAL_RESOLUTION,
            LabelEvidenceGrade.ORACLE_PRICE_VERIFIED,
        }

    @classmethod
    def third_party_comparison(cls, winner: str | None) -> "OfficialLabelEvidence":
        return cls(
            grade=LabelEvidenceGrade.THIRD_PARTY_INFERRED,
            winner=winner if winner in {"Up", "Down"} else None,
            condition_id=None,
            response_sha256=None,
            reason="THIRD_PARTY_OUTCOME_COMPARISON_ONLY",
        )

    @classmethod
    def unknown(cls, reason: str) -> "OfficialLabelEvidence":
        return cls(LabelEvidenceGrade.UNKNOWN, None, None, None, reason)

    @classmethod
    def from_gamma_market(
        cls,
        *,
        expected_condition_id: str,
        expected_slug: str,
        expected_start: datetime,
        expected_end: datetime,
        expected_up_token: str,
        expected_down_token: str,
        fetched_at: datetime,
        response_sha256: str,
        market: Mapping[str, Any],
    ) -> "OfficialLabelEvidence":
        require_utc(expected_start, "expected_start")
        require_utc(expected_end, "expected_end")
        require_utc(fetched_at, "fetched_at")
        if fetched_at <= expected_end:
            raise ValueError("official label fetch must occur after market end")
        if market.get("conditionId") != expected_condition_id:
            raise ValueError("official condition ID conflicts with source market")
        if market.get("slug") != expected_slug:
            raise ValueError("official slug conflicts with source market")
        slug_epoch = int(expected_slug.rsplit("-", 1)[-1])
        if datetime.fromtimestamp(slug_epoch, UTC) != expected_start:
            raise ValueError("slug epoch does not match the five-minute window")
        official_start_value = market.get("eventStartTime") or market.get("startTime")
        if official_start_value is not None and _official_time(
            official_start_value, "eventStartTime"
        ) != expected_start:
            raise ValueError("official event start conflicts with source window")
        if _official_time(market.get("endDate"), "endDate") != expected_end:
            raise ValueError("official end conflicts with source window")
        if market.get("closed") is not True:
            raise ValueError("official market is not closed")
        outcomes = _json_list(market.get("outcomes"), "outcomes")
        prices = _json_list(market.get("outcomePrices"), "outcomePrices")
        tokens = _json_list(market.get("clobTokenIds"), "clobTokenIds")
        if len(outcomes) != 2 or set(outcomes) != {"Up", "Down"}:
            raise ValueError("official outcomes do not map exactly to Up/Down")
        mapping = {str(outcome): str(token) for outcome, token in zip(outcomes, tokens)}
        if mapping != {"Up": expected_up_token, "Down": expected_down_token}:
            raise ValueError("official token mapping conflicts with source market")
        price_by_outcome = {
            str(outcome): Decimal(str(price)) for outcome, price in zip(outcomes, prices)
        }
        if sorted(price_by_outcome.values()) != [Decimal("0"), Decimal("1")]:
            raise ValueError("official outcome prices are not an unambiguous resolution")
        winner = next(outcome for outcome, price in price_by_outcome.items() if price == 1)
        return cls(
            grade=LabelEvidenceGrade.OFFICIAL_RESOLUTION,
            winner=winner,
            condition_id=expected_condition_id,
            response_sha256=response_sha256,
        )


@dataclass(frozen=True, slots=True)
class HistoricalFeeEvidence:
    grade: FeeEvidenceGrade
    fee_rate: Decimal | None
    source_sha256: str | None
    fee_schedule: Mapping[str, Any] | None = None

    def __post_init__(self) -> None:
        if self.fee_rate is not None:
            require_decimal(self.fee_rate, "fee_rate", non_negative=True)

    @property
    def net_pnl_verified(self) -> bool:
        return self.grade in {
            FeeEvidenceGrade.POINT_IN_TIME_OFFICIAL,
            FeeEvidenceGrade.MARKET_STATIC_OFFICIAL,
        } and self.fee_rate is not None

    def taker_fee_per_share(self, price: Decimal) -> Decimal:
        require_decimal(price, "price", non_negative=True)
        if price > 1:
            raise ValueError("binary market price must not exceed 1")
        if self.fee_rate is None:
            return Decimal("0")
        return self.fee_rate * price * (Decimal("1") - price)


@dataclass(frozen=True, slots=True)
class DataGateInputs:
    primary_market_count: int
    official_label_coverage: Decimal
    identity_unique: bool
    train_test_overlap: bool
    binance_coverage: Decimal
    future_data_count: int
    auditable_exclusions: bool
    decision_horizons: frozenset[int]


@dataclass(frozen=True, slots=True)
class DataGateResult:
    passed: bool
    failures: tuple[str, ...]


def evaluate_data_gate(inputs: DataGateInputs) -> DataGateResult:
    failures: list[str] = []
    if inputs.primary_market_count < 2_000:
        failures.append("PRIMARY_MARKETS_BELOW_2000")
    if inputs.official_label_coverage < Decimal("0.95"):
        failures.append("OFFICIAL_LABEL_COVERAGE_BELOW_95_PERCENT")
    if not inputs.identity_unique:
        failures.append("MARKET_IDENTITY_NOT_UNIQUE")
    if inputs.train_test_overlap:
        failures.append("TRAIN_TEST_OVERLAP")
    if inputs.binance_coverage < Decimal("0.99"):
        failures.append("BINANCE_COVERAGE_BELOW_99_PERCENT")
    if inputs.future_data_count:
        failures.append("FUTURE_DATA_PRESENT")
    if not inputs.auditable_exclusions:
        failures.append("EXCLUSIONS_NOT_AUDITABLE")
    if not {60, 30, 15} <= inputs.decision_horizons:
        failures.append("REQUIRED_DECISION_HORIZON_MISSING")
    return DataGateResult(not failures, tuple(failures))


@dataclass(frozen=True, slots=True)
class HistoricalTopOfBook:
    sample_time: datetime
    up_bid: Decimal | None
    up_ask: Decimal | None
    down_bid: Decimal | None
    down_ask: Decimal | None
    up_bid_size: Decimal | None
    up_ask_size: Decimal | None
    down_bid_size: Decimal | None
    down_ask_size: Decimal | None

    def __post_init__(self) -> None:
        require_utc(self.sample_time, "sample_time")
        for name in (
            "up_bid",
            "up_ask",
            "down_bid",
            "down_ask",
            "up_bid_size",
            "up_ask_size",
            "down_bid_size",
            "down_ask_size",
        ):
            value = getattr(self, name)
            if value is not None:
                require_decimal(value, name, non_negative=True)


def choose_visible_tick(
    ticks: Sequence[HistoricalTopOfBook],
    as_of: datetime,
    visibility: VisibilityScenario,
) -> HistoricalTopOfBook | None:
    require_utc(as_of, "as_of")
    visible = [item for item in ticks if item.sample_time + visibility.delay <= as_of]
    return max(visible, key=lambda item: item.sample_time, default=None)


@dataclass(frozen=True, slots=True)
class HistoricalExecutionOutcome:
    scenario: TopOfBookExecutionScenario
    executable_time: datetime | None
    fill_price: Decimal | None
    filled_quantity: Decimal
    unfilled_quantity: Decimal
    reason: str | None


def execute_top_of_book(
    *,
    ticks: Sequence[HistoricalTopOfBook],
    decision_time: datetime,
    market_end: datetime,
    direction: str,
    quantity: Decimal,
    scenario: TopOfBookExecutionScenario,
    visibility: VisibilityScenario,
    tick_size: Decimal,
) -> HistoricalExecutionOutcome:
    require_utc(decision_time, "decision_time")
    require_utc(market_end, "market_end")
    require_decimal(quantity, "quantity", positive=True)
    require_decimal(tick_size, "tick_size", positive=True)
    if direction not in {"BUY_UP", "BUY_DOWN"}:
        raise ValueError("historical execution only supports BUY_UP or BUY_DOWN")
    target = decision_time + scenario.latency
    candidates = sorted(
        (
            item
            for item in ticks
            if item.sample_time + visibility.delay >= target
            and item.sample_time + visibility.delay < market_end
        ),
        key=lambda item: item.sample_time,
    )
    if not candidates:
        return HistoricalExecutionOutcome(scenario, None, None, Decimal("0"), quantity, "NO_NEW_SAMPLE")
    selected = candidates[0]
    executable_time = selected.sample_time + visibility.delay
    ask = selected.up_ask if direction == "BUY_UP" else selected.down_ask
    ask_size = selected.up_ask_size if direction == "BUY_UP" else selected.down_ask_size
    if ask is None or ask_size is None or ask_size <= 0:
        return HistoricalExecutionOutcome(
            scenario, executable_time, None, Decimal("0"), quantity, "ASK_OR_SIZE_MISSING"
        )
    price = ask + (
        tick_size if scenario is TopOfBookExecutionScenario.STRESS_1S_PLUS_TICK else Decimal("0")
    )
    if price > 1:
        return HistoricalExecutionOutcome(
            scenario, executable_time, None, Decimal("0"), quantity, "STRESS_PRICE_OUT_OF_RANGE"
        )
    filled = min(quantity, ask_size)
    return HistoricalExecutionOutcome(
        scenario,
        executable_time,
        price,
        filled,
        quantity - filled,
        "INSUFFICIENT_TOP_SIZE" if filled < quantity else None,
    )

