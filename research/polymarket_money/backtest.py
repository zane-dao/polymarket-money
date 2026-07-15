"""Causal, offline-only replay and execution models over published normalized datasets.

The module deliberately contains no network, credential, environment-variable, wall-clock, model
selection, or live execution code.  It orchestrates the Batch 1 domain and accounting types rather
than defining a second fill, settlement, position, or PnL truth.
"""

from __future__ import annotations

from dataclasses import dataclass, fields, is_dataclass
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from enum import Enum
from hashlib import sha256
import json
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence

from .domain import (
    Decision,
    DecisionAction,
    Fill,
    Market,
    OracleDefinition,
    OraclePrice,
    OrderIntent,
    Outcome,
    OutcomeToken,
    PnL,
    Settlement,
    Side,
    require_decimal,
    require_non_empty,
    require_utc,
)
from .ledger import FillLedger
from .normalized import (
    BookState,
    DatasetPublicationError,
    NormalizedDatasetBuilder,
    PointInTimeDataset,
    PointInTimeView,
    RecordType,
)
from .raw_events import parse_utc_iso, utc_iso
from .rules import settlement_from_oracle, validate_btc_five_minute_market


BACKTEST_ENGINE_VERSION = "causal-backtest-v1"
DISCLAIMER = "Results are conditional on captured, continuity-unverified public data."
_BACKTEST_CODE_PATHS = tuple(
    Path(__file__).with_name(name)
    for name in ("backtest.py", "domain.py", "ledger.py", "normalized.py", "rules.py")
)
_code_digest = sha256()
for _path in _BACKTEST_CODE_PATHS:
    _code_digest.update(_path.name.encode("utf-8"))
    _code_digest.update(b"\0")
    _code_digest.update(_path.read_bytes())
    _code_digest.update(b"\0")
BACKTEST_CODE_SHA256 = _code_digest.hexdigest()
_REPLAY_OPEN_PROOF = object()


def _current_backtest_code_sha256() -> str:
    digest = sha256()
    for path in _BACKTEST_CODE_PATHS:
        digest.update(path.name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ValueError("non-finite Decimal is not serializable")
        return format(value, "f")
    if isinstance(value, datetime):
        require_utc(value, "datetime")
        return utc_iso(value)
    if isinstance(value, timedelta):
        return _timedelta_milliseconds(value)
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, Mapping):
        return {str(key): _json_value(item) for key, item in sorted(value.items())}
    if isinstance(value, (tuple, list)):
        return [_json_value(item) for item in value]
    if is_dataclass(value):
        return {
            item.name: _json_value(getattr(value, item.name))
            for item in fields(value)
        }
    if hasattr(value, "to_mapping"):
        return _json_value(value.to_mapping())
    raise ValueError(f"unsupported canonical value: {type(value).__name__}")


def _canonical_json(value: Any) -> str:
    return json.dumps(
        _json_value(value),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def _digest(value: Any) -> str:
    return sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _timedelta_milliseconds(value: timedelta) -> int:
    total_microseconds = (
        value.days * 86_400_000_000 + value.seconds * 1_000_000 + value.microseconds
    )
    if total_microseconds % 1_000 != 0:
        raise ValueError("replay durations must have millisecond precision")
    return total_microseconds // 1_000


def _duration_seconds(value: timedelta) -> Decimal:
    total_microseconds = (
        value.days * 86_400_000_000 + value.seconds * 1_000_000 + value.microseconds
    )
    return Decimal(total_microseconds) / Decimal(1_000_000)


class AcceptanceStatus(str, Enum):
    EXECUTION_ELIGIBLE = "EXECUTION_ELIGIBLE"
    FEATURE_ONLY = "FEATURE_ONLY"
    EXCLUDED = "EXCLUDED"


@dataclass(frozen=True, slots=True)
class AcceptanceDecision:
    status: AcceptanceStatus
    reason_codes: tuple[str, ...]
    continuity: str

    @property
    def execution_eligible(self) -> bool:
        return self.status is AcceptanceStatus.EXECUTION_ELIGIBLE


@dataclass(frozen=True, slots=True)
class AcceptanceSummary:
    total_market_count: int
    eligible_market_count: int
    feature_only_market_count: int
    excluded_market_count: int
    eligible_time_coverage: Decimal
    stale_time_coverage: Decimal
    disconnected_time_coverage: Decimal
    quarantine_time_coverage: Decimal
    empty_book_time_coverage: Decimal
    exclusion_reasons: Mapping[str, int]
    reason_duration_coverage: Mapping[str, Decimal]
    continuity: str = "UNVERIFIED"

    def to_mapping(self) -> dict[str, Any]:
        return {
            "total_market_count": self.total_market_count,
            "eligible_market_count": self.eligible_market_count,
            "feature_only_market_count": self.feature_only_market_count,
            "excluded_market_count": self.excluded_market_count,
            "eligible_time_coverage": self.eligible_time_coverage,
            "stale_time_coverage": self.stale_time_coverage,
            "disconnected_time_coverage": self.disconnected_time_coverage,
            "quarantine_time_coverage": self.quarantine_time_coverage,
            "empty_book_time_coverage": self.empty_book_time_coverage,
            "exclusion_reasons": dict(sorted(self.exclusion_reasons.items())),
            "reason_duration_coverage": dict(
                sorted(self.reason_duration_coverage.items())
            ),
            "continuity": self.continuity,
        }


class DatasetAcceptancePolicy:
    version = "dataset-acceptance-v1"

    def evaluate(self, view: PointInTimeView) -> AcceptanceDecision:
        reasons: set[str] = set()
        if view.continuity != "UNVERIFIED":
            reasons.add("INVALID_CONTINUITY")
        metadata = view.metadata
        if metadata is None:
            reasons.add("MISSING_MARKET_IDENTITY")
        elif metadata.get("identity_valid") is not True:
            reasons.add("INVALID_MARKET_IDENTITY")
        if set(view.token_by_outcome) != {"up", "down"} or len(
            set(view.token_by_outcome.values())
        ) != 2:
            reasons.add("MISSING_TOKEN_MAPPING")
        if view.active_quarantines:
            reasons.add("ACTIVE_QUARANTINE")

        book_states = {book.state for book in view.books.values()}
        if BookState.RESET_REQUIRED in book_states:
            reasons.add("RESET_REQUIRED")
        if BookState.WAITING_FOR_SNAPSHOT in book_states:
            reasons.add("WAITING_FOR_SNAPSHOT")
        if BookState.STALE in book_states:
            reasons.add("STALE")
        if BookState.DISCONNECTED in book_states or not view.books:
            reasons.add("DISCONNECTED")
        if BookState.UNTRADEABLE in book_states:
            reasons.add("EMPTY_BOOK_SIDE")
        if any(book.best_bid is not None and book.best_ask is not None and book.best_bid > book.best_ask for book in view.books.values()):
            reasons.add("CROSSED_BOOK")

        if metadata is not None:
            if metadata.get("active") is not True:
                reasons.add("MARKET_NOT_ACTIVE")
            if metadata.get("closed") is not False:
                reasons.add("MARKET_CLOSED")
            if metadata.get("accepting_orders") is not True:
                reasons.add("NOT_ACCEPTING_ORDERS")
            try:
                start = parse_utc_iso(metadata.get("interval_start"), "interval_start")
                end = parse_utc_iso(metadata.get("interval_end"), "interval_end")
                if not start <= view.decision_time < end:
                    reasons.add("OUTSIDE_MARKET_WINDOW")
            except ValueError:
                reasons.add("INVALID_MARKET_IDENTITY")

        structural = {
            "INVALID_CONTINUITY",
            "MISSING_MARKET_IDENTITY",
            "INVALID_MARKET_IDENTITY",
            "MISSING_TOKEN_MAPPING",
            "ACTIVE_QUARANTINE",
            "RESET_REQUIRED",
            "CROSSED_BOOK",
        }
        if reasons & structural:
            status = AcceptanceStatus.EXCLUDED
        elif reasons:
            status = AcceptanceStatus.FEATURE_ONLY
        elif not view.books or not all(book.execution_eligible for book in view.books.values()):
            status = AcceptanceStatus.FEATURE_ONLY
            reasons.add("BOOK_NOT_EXECUTION_ELIGIBLE")
        else:
            status = AcceptanceStatus.EXECUTION_ELIGIBLE
        return AcceptanceDecision(
            status=status,
            reason_codes=tuple(sorted(reasons)),
            continuity=view.continuity,
        )

    def summarize(
        self,
        dataset: PointInTimeDataset,
        *,
        market_ids: Sequence[str] | None = None,
    ) -> AcceptanceSummary:
        ids = tuple(sorted(set(market_ids or dataset.market_ids)))
        status_by_market: dict[str, set[AcceptanceStatus]] = {item: set() for item in ids}
        reasons_by_market: dict[str, set[str]] = {item: set() for item in ids}
        total_duration = Decimal("0")
        reason_duration: dict[str, Decimal] = {}
        eligible_duration = Decimal("0")

        for market_id in ids:
            metadata_records = [
                item
                for item in dataset.records
                if item.market_id == market_id and item.record_type is RecordType.MARKET_METADATA
            ]
            windows: list[tuple[datetime, datetime]] = []
            for item in metadata_records:
                payload = item.payload
                try:
                    window = (
                        parse_utc_iso(payload.get("interval_start"), "interval_start"),
                        parse_utc_iso(payload.get("interval_end"), "interval_end"),
                    )
                except ValueError:
                    continue
                if window[1] > window[0] and window not in windows:
                    windows.append(window)
            if not windows:
                status_by_market[market_id].add(AcceptanceStatus.EXCLUDED)
                reasons_by_market[market_id].add("MISSING_MARKET_IDENTITY")
                continue
            start, end = min(windows)
            boundaries = {start, end}
            boundaries.update(
                item
                for item in dataset.market_boundaries(market_id)
                if start < item < end
            )
            ordered = sorted(boundaries)
            for left, right in zip(ordered, ordered[1:]):
                if right <= left:
                    continue
                assessment = self.evaluate(dataset.as_of(left, market_id))
                status_by_market[market_id].add(assessment.status)
                duration = _duration_seconds(right - left)
                total_duration += duration
                if assessment.status is AcceptanceStatus.EXECUTION_ELIGIBLE:
                    eligible_duration += duration
                for reason in assessment.reason_codes:
                    reasons_by_market[market_id].add(reason)
                    reason_duration[reason] = reason_duration.get(reason, Decimal("0")) + duration

        def ratio(duration: Decimal) -> Decimal:
            return Decimal("0") if total_duration == 0 else duration / total_duration

        eligible_markets = sum(
            AcceptanceStatus.EXECUTION_ELIGIBLE in statuses
            for statuses in status_by_market.values()
        )
        feature_markets = sum(
            AcceptanceStatus.EXECUTION_ELIGIBLE not in statuses
            and AcceptanceStatus.FEATURE_ONLY in statuses
            for statuses in status_by_market.values()
        )
        excluded_markets = len(ids) - eligible_markets - feature_markets
        return AcceptanceSummary(
            total_market_count=len(ids),
            eligible_market_count=eligible_markets,
            feature_only_market_count=feature_markets,
            excluded_market_count=excluded_markets,
            eligible_time_coverage=ratio(eligible_duration),
            stale_time_coverage=ratio(reason_duration.get("STALE", Decimal("0"))),
            disconnected_time_coverage=ratio(
                reason_duration.get("DISCONNECTED", Decimal("0"))
            ),
            quarantine_time_coverage=ratio(
                reason_duration.get("ACTIVE_QUARANTINE", Decimal("0"))
            ),
            empty_book_time_coverage=ratio(
                reason_duration.get("EMPTY_BOOK_SIDE", Decimal("0"))
            ),
            exclusion_reasons={
                reason: sum(reason in reasons for reasons in reasons_by_market.values())
                for reason in sorted(
                    {item for reasons in reasons_by_market.values() for item in reasons}
                )
            },
            reason_duration_coverage={
                reason: ratio(duration)
                for reason, duration in sorted(reason_duration.items())
            },
        )


class ExecutionScenario(str, Enum):
    DEBUG_TOUCH = "DEBUG_TOUCH"
    TAKER_TOUCH_WITH_FEES = "TAKER_TOUCH_WITH_FEES"
    LATENCY = "LATENCY"
    DEPTH_AND_PARTIAL_FILL = "DEPTH_AND_PARTIAL_FILL"


class LiquidityRole(str, Enum):
    MAKER = "MAKER"
    TAKER = "TAKER"
    NO_FEE = "NO_FEE"


class NoFillReason(str, Enum):
    DATA_NOT_EXECUTION_ELIGIBLE = "DATA_NOT_EXECUTION_ELIGIBLE"
    NO_NEW_BOOK = "NO_NEW_BOOK"
    EMPTY_BOOK_SIDE = "EMPTY_BOOK_SIDE"
    LIMIT_NOT_MARKETABLE = "LIMIT_NOT_MARKETABLE"
    MARKET_CLOSED = "MARKET_CLOSED"
    NO_VISIBLE_DEPTH = "NO_VISIBLE_DEPTH"
    INSUFFICIENT_DEPTH = "INSUFFICIENT_DEPTH"


@dataclass(frozen=True, slots=True)
class FeeRate:
    market_id: str | None
    liquidity_role: LiquidityRole
    effective_from: datetime
    effective_to: datetime
    rate: Decimal
    quantum: Decimal
    rounding: str

    def __post_init__(self) -> None:
        if self.market_id is not None:
            require_non_empty(self.market_id, "market_id")
        require_utc(self.effective_from, "effective_from")
        require_utc(self.effective_to, "effective_to")
        if self.effective_to <= self.effective_from:
            raise ValueError("fee effective_to must be later than effective_from")
        require_decimal(self.rate, "rate", non_negative=True)
        require_decimal(self.quantum, "quantum", positive=True)
        if not isinstance(self.liquidity_role, LiquidityRole):
            raise ValueError("liquidity_role must be explicit")
        try:
            Decimal("0").quantize(self.quantum, rounding=self.rounding)
        except (InvalidOperation, TypeError, ValueError) as exc:
            raise ValueError("unsupported fee rounding rule") from exc

    def to_mapping(self) -> dict[str, Any]:
        return {
            "market_id": self.market_id,
            "liquidity_role": self.liquidity_role,
            "effective_from": self.effective_from,
            "effective_to": self.effective_to,
            "rate": self.rate,
            "quantum": self.quantum,
            "rounding": self.rounding,
        }


@dataclass(frozen=True, slots=True)
class FeeSchedule:
    version: str
    historical_verified: bool
    rates: tuple[FeeRate, ...]

    def __post_init__(self) -> None:
        require_non_empty(self.version, "fee schedule version")
        if not isinstance(self.historical_verified, bool):
            raise ValueError("historical_verified must be boolean")
        ordered = sorted(
            self.rates,
            key=lambda item: (
                item.market_id or "*",
                item.liquidity_role.value,
                item.effective_from,
                item.effective_to,
            ),
        )
        for previous, current in zip(ordered, ordered[1:]):
            if (
                previous.market_id == current.market_id
                and previous.liquidity_role is current.liquidity_role
                and current.effective_from < previous.effective_to
            ):
                raise ValueError("overlapping fee schedule intervals are ambiguous")

    def to_mapping(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "historical_verified": self.historical_verified,
            "rates": [item.to_mapping() for item in self.rates],
        }


@dataclass(frozen=True, slots=True)
class FeeCharge:
    amount: Decimal
    verified: bool
    schedule_version: str
    reason_code: str | None


class FeeModel:
    def __init__(self, schedule: FeeSchedule) -> None:
        self.schedule = schedule

    def charge(
        self,
        *,
        market_id: str,
        executable_time: datetime,
        liquidity_role: LiquidityRole,
        price: Decimal,
        quantity: Decimal,
    ) -> FeeCharge:
        require_non_empty(market_id, "market_id")
        require_utc(executable_time, "executable_time")
        require_decimal(price, "price", non_negative=True)
        require_decimal(quantity, "quantity", positive=True)
        matches = [
            rate
            for rate in self.schedule.rates
            if rate.market_id in {None, market_id}
            and rate.liquidity_role is liquidity_role
            and rate.effective_from <= executable_time < rate.effective_to
        ]
        exact = [item for item in matches if item.market_id == market_id]
        if exact:
            matches = exact
        if len(matches) > 1:
            raise ValueError("multiple fee rates match one fill")
        if not matches:
            return FeeCharge(
                amount=Decimal("0"),
                verified=False,
                schedule_version=self.schedule.version,
                reason_code="UNKNOWN_FEE",
            )
        rate = matches[0]
        amount = (price * quantity * rate.rate).quantize(
            rate.quantum, rounding=rate.rounding
        )
        return FeeCharge(
            amount=amount,
            verified=self.schedule.historical_verified,
            schedule_version=self.schedule.version,
            reason_code=None if self.schedule.historical_verified else "UNVERIFIED_FEE_SCHEDULE",
        )


@dataclass(frozen=True, slots=True)
class ExecutionConfig:
    scenario: ExecutionScenario
    latency: timedelta = timedelta(0)
    adverse_ticks: int = 0
    tick_size: Decimal = Decimal("0.01")

    def __post_init__(self) -> None:
        if not isinstance(self.scenario, ExecutionScenario):
            raise ValueError("scenario must be ExecutionScenario")
        if self.latency < timedelta(0):
            raise ValueError("latency must not be negative")
        _timedelta_milliseconds(self.latency)
        if isinstance(self.adverse_ticks, bool) or not isinstance(self.adverse_ticks, int) or self.adverse_ticks < 0:
            raise ValueError("adverse_ticks must be a non-negative integer")
        require_decimal(self.tick_size, "tick_size", positive=True)

    def to_mapping(self) -> dict[str, Any]:
        return {
            "scenario": self.scenario,
            "latency_ms": _timedelta_milliseconds(self.latency),
            "adverse_ticks": self.adverse_ticks,
            "tick_size": self.tick_size,
        }

    @property
    def config_hash(self) -> str:
        return _digest(self.to_mapping())


@dataclass(frozen=True, slots=True)
class ExecutionOutcome:
    scenario: ExecutionScenario
    decision_time: datetime
    intended_quantity: Decimal
    executable_time: datetime | None
    book_state: str | None
    fills: tuple[Fill, ...]
    filled_quantity: Decimal
    unfilled_quantity: Decimal
    vwap: Decimal | None
    fee: Decimal
    fee_verified: bool
    fee_schedule_version: str
    fee_reason_codes: tuple[str, ...]
    no_fill_reason: NoFillReason | None
    assumption_label: str

    @property
    def is_partial_fill(self) -> bool:
        return Decimal("0") < self.filled_quantity < self.intended_quantity

    @property
    def is_fully_filled(self) -> bool:
        return self.filled_quantity == self.intended_quantity

    def to_mapping(self) -> dict[str, Any]:
        return {
            "scenario": self.scenario,
            "decision_time": self.decision_time,
            "intended_quantity": self.intended_quantity,
            "executable_time": self.executable_time,
            "book_state": self.book_state,
            "fills": [
                {
                    "fill_id": fill.fill_id,
                    "order_intent_id": fill.order_intent_id,
                    "market_id": fill.market_id,
                    "token_id": fill.token_id,
                    "side": fill.side,
                    "price": fill.price,
                    "quantity": fill.quantity,
                    "fee": fill.fee,
                    "fill_time": fill.fill_time,
                    "receive_time": fill.receive_time,
                }
                for fill in self.fills
            ],
            "filled_quantity": self.filled_quantity,
            "unfilled_quantity": self.unfilled_quantity,
            "vwap": self.vwap,
            "fee": self.fee,
            "fee_verified": self.fee_verified,
            "fee_schedule_version": self.fee_schedule_version,
            "fee_reason_codes": self.fee_reason_codes,
            "no_fill_reason": self.no_fill_reason,
            "assumption_label": self.assumption_label,
        }


def market_from_view(view: PointInTimeView) -> Market:
    if view.metadata is None or set(view.token_by_outcome) != {"up", "down"}:
        raise ValueError("market identity and token mapping are required")
    metadata = view.metadata
    market = Market(
        market_id=view.market_id,
        condition_id=(
            view.condition_id
            if view.condition_id is not None
            else str(metadata.get("condition_id") or metadata.get("conditionId") or "")
        ),
        slug=str(metadata["slug"]),
        interval_start=parse_utc_iso(metadata["interval_start"], "interval_start"),
        interval_end=parse_utc_iso(metadata["interval_end"], "interval_end"),
        oracle=OracleDefinition(
            provider=str(metadata["oracle_provider"]),
            pair=str(metadata["oracle_pair"]),
        ),
        outcome_tokens=(
            OutcomeToken(view.token_by_outcome["up"], view.market_id, Outcome.UP),
            OutcomeToken(view.token_by_outcome["down"], view.market_id, Outcome.DOWN),
        ),
    )
    validate_btc_five_minute_market(market)
    return market


class ExecutionModel:
    def __init__(
        self,
        config: ExecutionConfig,
        *,
        fee_model: FeeModel,
        acceptance_policy: DatasetAcceptancePolicy,
    ) -> None:
        self.config = config
        self.fee_model = fee_model
        self.acceptance_policy = acceptance_policy

    def _no_fill(
        self,
        intent: OrderIntent,
        reason: NoFillReason,
        *,
        executable_time: datetime | None = None,
        book_state: str | None = None,
    ) -> ExecutionOutcome:
        return ExecutionOutcome(
            scenario=self.config.scenario,
            decision_time=intent.decision_time,
            intended_quantity=intent.quantity,
            executable_time=executable_time,
            book_state=book_state,
            fills=(),
            filled_quantity=Decimal("0"),
            unfilled_quantity=intent.quantity,
            vwap=None,
            fee=Decimal("0"),
            fee_verified=False,
            fee_schedule_version=self.fee_model.schedule.version,
            fee_reason_codes=("NO_FILL",),
            no_fill_reason=reason,
            assumption_label=self._assumption_label,
        )

    @property
    def _assumption_label(self) -> str:
        if self.config.scenario is ExecutionScenario.DEBUG_TOUCH:
            return "NON_REALISTIC_DEBUG_TOUCH"
        return self.config.scenario.value

    def execute(
        self,
        dataset: PointInTimeDataset,
        market: Market,
        intent: OrderIntent,
    ) -> ExecutionOutcome:
        if intent.market_id != market.market_id:
            raise ValueError("intent market does not match execution market")
        if intent.token_id not in {item.token_id for item in market.outcome_tokens}:
            raise ValueError("intent token does not belong to execution market")
        if intent.order_send_time is not None:
            raise ValueError("offline simulation intent must not claim a real order_send_time")
        if intent.decision_time >= market.interval_end:
            return self._no_fill(intent, NoFillReason.MARKET_CLOSED)
        decision_view = dataset.as_of(intent.decision_time, market.market_id)
        decision_assessment = self.acceptance_policy.evaluate(decision_view)
        if not decision_assessment.execution_eligible:
            state = next(iter(decision_view.books.values())).state.value if decision_view.books else None
            return self._no_fill(
                intent,
                NoFillReason.DATA_NOT_EXECUTION_ELIGIBLE,
                executable_time=intent.decision_time,
                book_state=state,
            )

        executable_time = intent.decision_time
        if self.config.scenario is ExecutionScenario.LATENCY:
            target = intent.decision_time + self.config.latency
            if target >= market.interval_end:
                return self._no_fill(
                    intent,
                    NoFillReason.MARKET_CLOSED,
                    executable_time=target,
                )
            executable_time = dataset.next_book_time(
                market_id=market.market_id,
                asset_id=intent.token_id,
                not_before=target,
                before=market.interval_end,
            )
            if executable_time is None:
                return self._no_fill(intent, NoFillReason.NO_NEW_BOOK)
        if executable_time >= market.interval_end:
            return self._no_fill(
                intent, NoFillReason.MARKET_CLOSED, executable_time=executable_time
            )
        view = dataset.as_of(executable_time, market.market_id)
        assessment = self.acceptance_policy.evaluate(view)
        book = view.books.get(intent.token_id)
        if not assessment.execution_eligible or book is None:
            return self._no_fill(
                intent,
                NoFillReason.DATA_NOT_EXECUTION_ELIGIBLE,
                executable_time=executable_time,
                book_state=book.state.value if book is not None else None,
            )

        levels = book.asks if intent.side is Side.BUY else book.bids
        if not levels:
            return self._no_fill(
                intent,
                NoFillReason.EMPTY_BOOK_SIDE,
                executable_time=executable_time,
                book_state=book.state.value,
            )
        if self.config.scenario is not ExecutionScenario.DEPTH_AND_PARTIAL_FILL:
            levels = ((levels[0][0], intent.quantity),)

        remaining = intent.quantity
        fills: list[Fill] = []
        fee_verified = True
        fee_reasons: set[str] = set()
        role = (
            LiquidityRole.NO_FEE
            if self.config.scenario is ExecutionScenario.DEBUG_TOUCH
            else LiquidityRole.TAKER
        )
        for level_index, (raw_price, available) in enumerate(levels):
            if remaining <= 0:
                break
            adverse = self.config.tick_size * self.config.adverse_ticks
            price = raw_price + adverse if intent.side is Side.BUY else raw_price - adverse
            if price < 0 or price > 1:
                continue
            marketable = (
                price <= intent.limit_price
                if intent.side is Side.BUY
                else price >= intent.limit_price
            )
            if not marketable:
                break
            quantity = min(remaining, available)
            if quantity <= 0:
                continue
            charge = self.fee_model.charge(
                market_id=market.market_id,
                executable_time=executable_time,
                liquidity_role=role,
                price=price,
                quantity=quantity,
            )
            fill_id = _digest(
                {
                    "engine": BACKTEST_ENGINE_VERSION,
                    "scenario": self.config.scenario,
                    "intent_id": intent.intent_id,
                    "level_index": level_index,
                    "price": price,
                    "quantity": quantity,
                    "executable_time": executable_time,
                }
            )
            fills.append(
                Fill(
                    fill_id=fill_id,
                    order_intent_id=intent.intent_id,
                    market_id=market.market_id,
                    token_id=intent.token_id,
                    side=intent.side,
                    price=price,
                    quantity=quantity,
                    fee=charge.amount,
                    fill_time=executable_time,
                    receive_time=executable_time,
                )
            )
            fee_verified = fee_verified and charge.verified
            if charge.reason_code is not None:
                fee_reasons.add(charge.reason_code)
            remaining -= quantity

        if not fills:
            return self._no_fill(
                intent,
                NoFillReason.LIMIT_NOT_MARKETABLE,
                executable_time=executable_time,
                book_state=book.state.value,
            )
        filled = sum((item.quantity for item in fills), Decimal("0"))
        notional = sum((item.price * item.quantity for item in fills), Decimal("0"))
        fee = sum((item.fee for item in fills), Decimal("0"))
        return ExecutionOutcome(
            scenario=self.config.scenario,
            decision_time=intent.decision_time,
            intended_quantity=intent.quantity,
            executable_time=executable_time,
            book_state=book.state.value,
            fills=tuple(fills),
            filled_quantity=filled,
            unfilled_quantity=intent.quantity - filled,
            vwap=notional / filled,
            fee=fee,
            fee_verified=fee_verified,
            fee_schedule_version=self.fee_model.schedule.version,
            fee_reason_codes=tuple(sorted(fee_reasons)),
            no_fill_reason=(
                NoFillReason.INSUFFICIENT_DEPTH if remaining > 0 else None
            ),
            assumption_label=self._assumption_label,
        )


@dataclass(slots=True)
class ReplayClock:
    current_time: datetime | None = None

    def advance_to(self, value: datetime) -> datetime:
        require_utc(value, "replay time")
        if self.current_time is not None and value < self.current_time:
            raise ValueError("replay clock cannot move backward")
        self.current_time = value
        return value


@dataclass(frozen=True, slots=True)
class StrategyOutput:
    decision: Decision
    order_intent: OrderIntent | None


class Strategy(Protocol):
    def decision_points(self) -> tuple[tuple[str, datetime], ...]: ...

    def decide(self, view: PointInTimeView) -> StrategyOutput: ...

    def config_mapping(self) -> Mapping[str, Any]: ...


class NoTradeStrategy:
    def __init__(self, points: Sequence[tuple[str, datetime]]) -> None:
        self._points = tuple(sorted(points, key=lambda item: (item[1], item[0])))

    def decision_points(self) -> tuple[tuple[str, datetime], ...]:
        return self._points

    def decide(self, view: PointInTimeView) -> StrategyOutput:
        decision = Decision(
            decision_id=_digest(
                {"strategy": "NoTradeStrategy", "market_id": view.market_id, "time": view.decision_time}
            ),
            market_id=view.market_id,
            token_id=None,
            action=DecisionAction.HOLD,
            decision_time=view.decision_time,
            input_receive_time=view.decision_time,
            reason_codes=("NO_TRADE_FIXTURE",),
        )
        return StrategyOutput(decision=decision, order_intent=None)

    def config_mapping(self) -> Mapping[str, Any]:
        return {"strategy": "NoTradeStrategy", "points": self._points}


class FixedDecisionFixtureStrategy:
    def __init__(self, outputs: Sequence[StrategyOutput]) -> None:
        self._outputs = tuple(outputs)
        self._by_point: dict[tuple[str, datetime], StrategyOutput] = {}
        for output in self._outputs:
            key = (output.decision.market_id, output.decision.decision_time)
            if key in self._by_point:
                raise ValueError("fixture strategy has duplicate decision point")
            self._by_point[key] = output

    def decision_points(self) -> tuple[tuple[str, datetime], ...]:
        return tuple(sorted(self._by_point, key=lambda item: (item[1], item[0])))

    def decide(self, view: PointInTimeView) -> StrategyOutput:
        try:
            return self._by_point[(view.market_id, view.decision_time)]
        except KeyError as exc:
            raise ValueError("fixture strategy cannot invent an unscheduled decision") from exc

    def config_mapping(self) -> Mapping[str, Any]:
        return {
            "strategy": "FixedDecisionFixtureStrategy",
            "outputs": [
                {
                    "decision_id": item.decision.decision_id,
                    "market_id": item.decision.market_id,
                    "token_id": item.decision.token_id,
                    "decision_time": item.decision.decision_time,
                    "action": item.decision.action,
                    "input_receive_time": item.decision.input_receive_time,
                    "reason_codes": item.decision.reason_codes,
                    "intent": (
                        {
                            "intent_id": item.order_intent.intent_id,
                            "idempotency_key": item.order_intent.idempotency_key,
                            "decision_id": item.order_intent.decision_id,
                            "market_id": item.order_intent.market_id,
                            "token_id": item.order_intent.token_id,
                            "side": item.order_intent.side,
                            "limit_price": item.order_intent.limit_price,
                            "quantity": item.order_intent.quantity,
                            "decision_time": item.order_intent.decision_time,
                            "order_send_time": item.order_intent.order_send_time,
                        }
                        if item.order_intent
                        else None
                    ),
                }
                for item in self._outputs
            ],
        }


class SettlementResolver:
    def resolve(
        self,
        dataset: PointInTimeDataset,
        market: Market,
        *,
        settlement_time: datetime,
    ) -> Settlement:
        require_utc(settlement_time, "settlement_time")
        if settlement_time < market.interval_end:
            raise ValueError("settlement_time must not precede market interval_end")

        def boundary(source_time: datetime, label: str) -> OraclePrice:
            item = dataset.chainlink_boundary(
                market_id=market.market_id,
                source_time=source_time,
                as_of=settlement_time,
            )
            if item.payload.get("price") is None:
                raise ValueError(f"{label} Chainlink boundary price is missing")
            return OraclePrice(
                market_id=market.market_id,
                pair="BTC/USD",
                provider="Chainlink",
                price=Decimal(str(item.payload["price"])),
                source_time=source_time,
                server_time=item.server_time,
                receive_time=item.receive_time,
            )

        return settlement_from_oracle(
            settlement_id=_digest(
                {
                    "dataset_hash": dataset.dataset_hash,
                    "market_id": market.market_id,
                    "settlement_time": settlement_time,
                }
            ),
            market=market,
            opening=boundary(market.interval_start, "opening"),
            closing=boundary(market.interval_end, "closing"),
            settlement_time=settlement_time,
        )


@dataclass(frozen=True, slots=True)
class MarketAuditRecord:
    dataset_hash: str
    market_id: str
    decisions: tuple[Decision, ...]
    order_intents: tuple[OrderIntent, ...]
    executions: tuple[ExecutionOutcome, ...]
    settlement: Settlement | None
    pnl: PnL | None

    def to_mapping(self) -> dict[str, Any]:
        return {
            "dataset_hash": self.dataset_hash,
            "market_id": self.market_id,
            "decisions": [
                {
                    "decision_id": item.decision_id,
                    "market_id": item.market_id,
                    "token_id": item.token_id,
                    "action": item.action,
                    "decision_time": item.decision_time,
                    "input_receive_time": item.input_receive_time,
                    "reason_codes": item.reason_codes,
                }
                for item in self.decisions
            ],
            "order_intents": [
                {
                    "intent_id": item.intent_id,
                    "idempotency_key": item.idempotency_key,
                    "decision_id": item.decision_id,
                    "market_id": item.market_id,
                    "token_id": item.token_id,
                    "side": item.side,
                    "limit_price": item.limit_price,
                    "quantity": item.quantity,
                    "decision_time": item.decision_time,
                    "order_send_time": item.order_send_time,
                }
                for item in self.order_intents
            ],
            "executions": [item.to_mapping() for item in self.executions],
            "settlement": (
                {
                    "settlement_id": self.settlement.settlement_id,
                    "market_id": self.settlement.market_id,
                    "opening_price": self.settlement.start_price,
                    "closing_price": self.settlement.end_price,
                    "winning_outcome": self.settlement.winning_outcome,
                    "winning_token_id": self.settlement.winning_token_id,
                    "settlement_time": self.settlement.settlement_time,
                    "payout_per_token": self.settlement.payout_per_token,
                }
                if self.settlement
                else None
            ),
            "pnl": (
                {
                    "market_id": self.pnl.market_id,
                    "payout": self.pnl.payout,
                    "net_cash_outlay": self.pnl.net_cash_outlay,
                    "gross_pnl": self.pnl.gross_pnl,
                    "fees": self.pnl.fees,
                    "net_pnl": self.pnl.net_pnl,
                }
                if self.pnl
                else None
            ),
        }


@dataclass(frozen=True, slots=True)
class BacktestResult:
    dataset_hash: str
    replay_config_hash: str
    replay_hash: str
    acceptance_summary: AcceptanceSummary
    execution_model: ExecutionScenario
    latency_ms: int
    fee_schedule_version: str
    decision_count: int
    intent_count: int
    fully_filled_order_count: int
    partially_filled_order_count: int
    unfilled_order_count: int
    fill_event_count: int
    excluded_decision_point_count: int
    exclusion_reasons: Mapping[str, int]
    gross_pnl: Decimal
    fees: Decimal
    net_pnl: Decimal
    net_pnl_verified: bool
    pnl_status: str
    market_audits: tuple[MarketAuditRecord, ...]
    disclaimer: str = DISCLAIMER

    def to_mapping(self, *, include_replay_hash: bool = True) -> dict[str, Any]:
        result = {
            "engine_version": BACKTEST_ENGINE_VERSION,
            "dataset_hash": self.dataset_hash,
            "replay_config_hash": self.replay_config_hash,
            "acceptance_summary": self.acceptance_summary.to_mapping(),
            "execution_model": self.execution_model,
            "latency_ms": self.latency_ms,
            "fee_schedule_version": self.fee_schedule_version,
            "decision_count": self.decision_count,
            "intent_count": self.intent_count,
            "fully_filled_order_count": self.fully_filled_order_count,
            "partially_filled_order_count": self.partially_filled_order_count,
            "unfilled_order_count": self.unfilled_order_count,
            "fill_event_count": self.fill_event_count,
            "excluded_decision_point_count": self.excluded_decision_point_count,
            "exclusion_reasons": dict(sorted(self.exclusion_reasons.items())),
            "gross_pnl": self.gross_pnl,
            "fees": self.fees,
            "net_pnl": self.net_pnl,
            "net_pnl_verified": self.net_pnl_verified,
            "pnl_status": self.pnl_status,
            "market_audits": [item.to_mapping() for item in self.market_audits],
            "disclaimer": self.disclaimer,
        }
        if include_replay_hash:
            result["replay_hash"] = self.replay_hash
        return result


class ReplayEngine:
    def __init__(
        self,
        dataset: PointInTimeDataset,
        *,
        expected_dataset_hash: str,
        execution_model: ExecutionModel,
        acceptance_policy: DatasetAcceptancePolicy,
        require_clean_normalizer: bool,
        _proof: object,
    ) -> None:
        if _proof is not _REPLAY_OPEN_PROOF:
            raise DatasetPublicationError("ReplayEngine can only be created by open()")
        receipt = dataset.verification_receipt
        if receipt is None:
            raise DatasetPublicationError("replay requires a published normalized dataset receipt")
        if dataset.dataset_hash != expected_dataset_hash or receipt.dataset_hash != expected_dataset_hash:
            raise DatasetPublicationError("normalized dataset hash pin does not match")
        if receipt.continuity != "UNVERIFIED":
            raise DatasetPublicationError("normalized continuity must remain UNVERIFIED")
        if require_clean_normalizer and receipt.normalizer_worktree_state != "CLEAN":
            raise DatasetPublicationError("replay requires a CLEAN normalized build")
        if receipt.normalizer_git_commit == "UNCOMMITTED":
            raise DatasetPublicationError("replay rejects an uncommitted normalizer")
        self.dataset = dataset
        self.expected_dataset_hash = expected_dataset_hash
        self.execution_model = execution_model
        self.acceptance_policy = acceptance_policy
        if execution_model.acceptance_policy is not acceptance_policy:
            raise ValueError("replay and execution must share one acceptance policy")

    @classmethod
    def open(
        cls,
        version_directory: Path,
        *,
        expected_dataset_hash: str,
        execution_model: ExecutionModel,
        acceptance_policy: DatasetAcceptancePolicy | None = None,
        require_clean_normalizer: bool = True,
    ) -> "ReplayEngine":
        policy = acceptance_policy or DatasetAcceptancePolicy()
        dataset = NormalizedDatasetBuilder.load(version_directory)
        return cls(
            dataset,
            expected_dataset_hash=expected_dataset_hash,
            execution_model=execution_model,
            acceptance_policy=policy,
            require_clean_normalizer=require_clean_normalizer,
            _proof=_REPLAY_OPEN_PROOF,
        )

    @staticmethod
    def from_dataset_forbidden(dataset: PointInTimeDataset) -> "ReplayEngine":
        del dataset
        raise DatasetPublicationError("direct PointInTimeDataset replay is forbidden")

    def _validate_strategy_output(
        self, output: StrategyOutput, view: PointInTimeView
    ) -> None:
        decision = output.decision
        if decision.market_id != view.market_id or decision.decision_time != view.decision_time:
            raise ValueError("strategy decision does not match scheduled point")
        intent = output.order_intent
        if decision.action is DecisionAction.HOLD:
            if intent is not None:
                raise ValueError("HOLD decision must not create an OrderIntent")
            return
        if intent is None or decision.token_id is None:
            raise ValueError("BUY/SELL decision requires the existing OrderIntent type")
        expected_side = Side.BUY if decision.action is DecisionAction.BUY else Side.SELL
        if (
            intent.decision_id != decision.decision_id
            or intent.market_id != decision.market_id
            or intent.token_id != decision.token_id
            or intent.side is not expected_side
            or intent.decision_time != decision.decision_time
        ):
            raise ValueError("OrderIntent contradicts its Decision")
        if decision.token_id not in set(view.token_by_outcome.values()):
            raise ValueError("strategy token does not belong to the PIT market mapping")

    def run(
        self,
        strategy: Strategy,
        *,
        settlement_times: Mapping[str, datetime] | None = None,
    ) -> BacktestResult:
        if _current_backtest_code_sha256() != BACKTEST_CODE_SHA256:
            raise RuntimeError("backtest source changed after import; restart before replay")
        clock = ReplayClock()
        ledger = FillLedger()
        decisions: dict[str, list[Decision]] = {}
        intents: dict[str, list[OrderIntent]] = {}
        executions: dict[str, list[ExecutionOutcome]] = {}
        excluded_reasons: dict[str, int] = {}
        excluded_points = 0
        decision_registry: dict[str, str] = {}
        intent_registry: dict[str, str] = {}
        idempotency_registry: dict[str, str] = {}
        for market_id, decision_time in sorted(
            strategy.decision_points(), key=lambda item: (item[1], item[0])
        ):
            clock.advance_to(decision_time)
            view = self.dataset.as_of(decision_time, market_id)
            assessment = self.acceptance_policy.evaluate(view)
            if assessment.status is not AcceptanceStatus.EXECUTION_ELIGIBLE:
                excluded_points += 1
                for reason in assessment.reason_codes:
                    excluded_reasons[reason] = excluded_reasons.get(reason, 0) + 1
                continue
            output = strategy.decide(view)
            self._validate_strategy_output(output, view)
            decision_signature = _canonical_json(output.decision)
            prior_decision = decision_registry.get(output.decision.decision_id)
            if prior_decision is not None:
                if prior_decision != decision_signature:
                    raise ValueError("decision_id was reused with different content")
                continue
            decision_registry[output.decision.decision_id] = decision_signature
            decisions.setdefault(market_id, []).append(output.decision)
            if output.order_intent is None:
                continue
            intent = output.order_intent
            intent_signature = _canonical_json(intent)
            for registry, key, label in (
                (intent_registry, intent.intent_id, "intent_id"),
                (idempotency_registry, intent.idempotency_key, "idempotency_key"),
            ):
                prior = registry.get(key)
                if prior is not None:
                    if prior != intent_signature:
                        raise ValueError(f"{label} was reused with different content")
                    raise ValueError(f"duplicate {label} reached execution")
                registry[key] = intent_signature
            intents.setdefault(market_id, []).append(intent)
            market = market_from_view(view)
            outcome = self.execution_model.execute(self.dataset, market, intent)
            executions.setdefault(market_id, []).append(outcome)
            for fill in outcome.fills:
                if not ledger.apply_fill(fill):
                    raise RuntimeError("duplicate fill reached the replay ledger")

        settlements: dict[str, Settlement] = {}
        pnls: dict[str, PnL] = {}
        resolver = SettlementResolver()
        for market_id, settlement_time in sorted((settlement_times or {}).items()):
            market_view = self.dataset.as_of(settlement_time, market_id)
            market = market_from_view(market_view)
            settlement = resolver.resolve(
                self.dataset, market, settlement_time=settlement_time
            )
            settlements[market_id] = settlement
            pnls[market_id] = ledger.apply_settlement(settlement).pnl

        market_ids = sorted(
            set(decisions) | set(intents) | set(executions) | set(settlements)
        )
        audits = tuple(
            MarketAuditRecord(
                dataset_hash=self.expected_dataset_hash,
                market_id=market_id,
                decisions=tuple(decisions.get(market_id, ())),
                order_intents=tuple(intents.get(market_id, ())),
                executions=tuple(executions.get(market_id, ())),
                settlement=settlements.get(market_id),
                pnl=pnls.get(market_id),
            )
            for market_id in market_ids
        )
        all_executions = tuple(item for values in executions.values() for item in values)
        all_pnls = tuple(pnls.values())
        config = {
            "engine_version": BACKTEST_ENGINE_VERSION,
            "engine_code_sha256": BACKTEST_CODE_SHA256,
            "dataset_receipt": self.dataset.verification_receipt.to_mapping(),
            "acceptance_policy": self.acceptance_policy.version,
            "execution": self.execution_model.config.to_mapping(),
            "fee_schedule": self.execution_model.fee_model.schedule.to_mapping(),
            "strategy": strategy.config_mapping(),
            "settlement_times": dict(sorted((settlement_times or {}).items())),
        }
        config_hash = _digest(config)
        result_without_hash = {
            "dataset_hash": self.expected_dataset_hash,
            "replay_config_hash": config_hash,
            "acceptance_summary": self.acceptance_policy.summarize(self.dataset).to_mapping(),
            "audits": [item.to_mapping() for item in audits],
            "excluded_reasons": excluded_reasons,
        }
        replay_hash = _digest(result_without_hash)
        filled_markets = {
            market_id
            for market_id, values in executions.items()
            if any(outcome.fills for outcome in values)
        }
        all_fees_verified = all(
            execution.fee_verified
            for execution in all_executions
            if execution.fills
        )
        settlement_complete = filled_markets <= set(settlements)
        pnl_verified = bool(filled_markets) and settlement_complete and all_fees_verified
        if not filled_markets:
            pnl_status = "NOT_APPLICABLE_NO_FILLS"
        elif not settlement_complete:
            pnl_status = "UNSETTLED"
        elif not all_fees_verified:
            pnl_status = "COMPLETE_FEE_UNVERIFIED"
        else:
            pnl_status = "COMPLETE_VERIFIED"
        return BacktestResult(
            dataset_hash=self.expected_dataset_hash,
            replay_config_hash=config_hash,
            replay_hash=replay_hash,
            acceptance_summary=self.acceptance_policy.summarize(self.dataset),
            execution_model=self.execution_model.config.scenario,
            latency_ms=_timedelta_milliseconds(self.execution_model.config.latency),
            fee_schedule_version=self.execution_model.fee_model.schedule.version,
            decision_count=sum(len(items) for items in decisions.values()),
            intent_count=sum(len(items) for items in intents.values()),
            fully_filled_order_count=sum(item.is_fully_filled for item in all_executions),
            partially_filled_order_count=sum(item.is_partial_fill for item in all_executions),
            unfilled_order_count=sum(not item.fills for item in all_executions),
            fill_event_count=sum(len(item.fills) for item in all_executions),
            excluded_decision_point_count=excluded_points,
            exclusion_reasons=dict(sorted(excluded_reasons.items())),
            gross_pnl=sum((item.gross_pnl for item in all_pnls), Decimal("0")),
            fees=sum((item.fees for item in all_pnls), Decimal("0")),
            net_pnl=sum((item.net_pnl for item in all_pnls), Decimal("0")),
            net_pnl_verified=pnl_verified,
            pnl_status=pnl_status,
            market_audits=audits,
        )
