"""Deterministic J/K historical reconstruction and paper portfolio simulation.

This module has no network, credential, wall-clock, or live-order path.  It consumes the
hash-verified Batch 3B decision samples and reconstructs the legacy J/K decision rules while
making the one known fidelity limit explicit: the frozen samples contain 30/60/120 second
realized-volatility features, not the legacy process' persisted EWMA state.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
from enum import Enum
from hashlib import sha256
import csv
import json
import math
import os
from pathlib import Path
from typing import Any, Mapping, Sequence

from .historical_adapter import HistoricalDatasetReceipt, canonical_json, file_sha256
from .kj_ewma import KJEwmaArtifact, SIGNAL_FIDELITY as EWMA_SIGNAL_FIDELITY


ZERO = Decimal("0")
ONE = Decimal("1")
SIGNAL_FIDELITY = "APPROXIMATE_VOLATILITY_PROXY"
ADAPTIVE_SIGNAL_FIDELITY = "ADAPTIVE_30_60_120S_REALIZED_VOL_EXECUTION_PROXY"
ENGINE_VERSION = "kj-paper-v2"
ADAPTIVE_ENGINE_VERSION = "l-adaptive-paper-v1"
_CODE_PATHS = tuple(
    Path(__file__).with_name(name)
    for name in ("kj_paper.py", "kj_ewma.py", "historical_adapter.py")
)
_code_digest = sha256()
for _code_path in _CODE_PATHS:
    _code_digest.update(_code_path.name.encode("utf-8"))
    _code_digest.update(b"\0")
    _code_digest.update(_code_path.read_bytes())
    _code_digest.update(b"\0")
ENGINE_CODE_SHA256 = _code_digest.hexdigest()


class KJStrategy(str, Enum):
    J_FEE_AWARE = "J_FEE_AWARE"
    K_DUAL_VOL = "K_DUAL_VOL"


class AdaptiveStrategy(str, Enum):
    """New research-only strategies deliberately kept outside the frozen J/K enum."""

    L_ADAPTIVE_EXECUTION = "L_ADAPTIVE_EXECUTION"


class PaperScenario(str, Enum):
    BASE_1S = "BASE_1S"
    STRESS_1S_PLUS_TICK = "STRESS_1S_PLUS_TICK"


@dataclass(frozen=True, slots=True)
class KJConfig:
    edge_threshold: Decimal = Decimal("0.05")
    max_edge: Decimal = Decimal("0.25")
    critical_band_usd: Decimal = Decimal("10")
    critical_band_max_remaining_s: int = 180
    probability_clamp: Decimal = Decimal("0.005")
    kelly_multiplier: Decimal = Decimal("0.25")
    max_stake_fraction: Decimal = Decimal("0.02")
    max_stake_abs_usdc: Decimal = Decimal("400")
    book_participation: Decimal = Decimal("0.5")
    min_stake_usdc: Decimal = Decimal("1")
    k_vol_floor_ratio: Decimal = Decimal("0.4")
    k_absolute_min_sigma: Decimal = Decimal("0.000012")
    tick_size: Decimal = Decimal("0.01")

    def __post_init__(self) -> None:
        for name in (
            "edge_threshold",
            "max_edge",
            "critical_band_usd",
            "probability_clamp",
            "kelly_multiplier",
            "max_stake_fraction",
            "max_stake_abs_usdc",
            "book_participation",
            "min_stake_usdc",
            "k_vol_floor_ratio",
            "k_absolute_min_sigma",
            "tick_size",
        ):
            value = getattr(self, name)
            if not value.is_finite() or value < ZERO:
                raise ValueError(f"{name} must be a finite non-negative Decimal")
        if self.max_edge <= self.edge_threshold:
            raise ValueError("max_edge must exceed edge_threshold")
        if not ZERO < self.probability_clamp < Decimal("0.5"):
            raise ValueError("probability_clamp must be between zero and 0.5")
        if not ZERO < self.book_participation <= ONE:
            raise ValueError("book_participation must be in (0, 1]")

    def to_mapping(self) -> dict[str, str | int]:
        return {
            name: format(value, "f") if isinstance(value, Decimal) else value
            for name, value in (
                ("edge_threshold", self.edge_threshold),
                ("max_edge", self.max_edge),
                ("critical_band_usd", self.critical_band_usd),
                ("critical_band_max_remaining_s", self.critical_band_max_remaining_s),
                ("probability_clamp", self.probability_clamp),
                ("kelly_multiplier", self.kelly_multiplier),
                ("max_stake_fraction", self.max_stake_fraction),
                ("max_stake_abs_usdc", self.max_stake_abs_usdc),
                ("book_participation", self.book_participation),
                ("min_stake_usdc", self.min_stake_usdc),
                ("k_vol_floor_ratio", self.k_vol_floor_ratio),
                ("k_absolute_min_sigma", self.k_absolute_min_sigma),
                ("tick_size", self.tick_size),
            )
        }


@dataclass(frozen=True, slots=True)
class LAdaptiveConfig:
    """Pre-registered L execution-risk parameters.

    These values are an execution-risk specification, not values selected on FINAL_TEST.
    The three realised-volatility windows are the only point-in-time volatility inputs
    available in the historical receipt.  They are combined smoothly in variance space;
    unlike K, no single window or hard max becomes the effective sigma.
    """

    config_version: str = "l-adaptive-execution-v1-preregistered"
    short_volatility_weight: Decimal = Decimal("0.50")
    medium_volatility_weight: Decimal = Decimal("0.30")
    long_volatility_weight: Decimal = Decimal("0.20")
    sigma_floor: Decimal = Decimal("0.000005")
    shock_weight: Decimal = Decimal("0.35")
    probability_clamp: Decimal = Decimal("0.005")
    volatility_drag_max: Decimal = Decimal("0.55")
    volatility_drag_reference: Decimal = Decimal("0.004")
    anchor_noise_bps: Decimal = Decimal("1")
    anchor_uncertainty_multiplier: Decimal = Decimal("0.35")
    latency_seconds: Decimal = Decimal("1")
    latency_tick_fraction: Decimal = Decimal("0.25")
    btc_speed_multiplier: Decimal = Decimal("2")
    market_quote_reprice_risk_multiplier: Decimal = Decimal("0.20")
    volatility_remaining_multiplier: Decimal = Decimal("0.15")
    depth_risk_max: Decimal = Decimal("0.01")
    max_signal_edge: Decimal = Decimal("0.45")
    kelly_multiplier: Decimal = Decimal("0.25")
    max_stake_fraction: Decimal = Decimal("0.02")
    max_stake_abs_usdc: Decimal = Decimal("400")
    book_participation: Decimal = Decimal("0.5")
    min_stake_usdc: Decimal = Decimal("1")
    tick_size: Decimal = Decimal("0.01")

    def __post_init__(self) -> None:
        decimals = (
            "short_volatility_weight",
            "medium_volatility_weight",
            "long_volatility_weight",
            "sigma_floor",
            "shock_weight",
            "probability_clamp",
            "volatility_drag_max",
            "volatility_drag_reference",
            "anchor_noise_bps",
            "anchor_uncertainty_multiplier",
            "latency_seconds",
            "latency_tick_fraction",
            "btc_speed_multiplier",
            "market_quote_reprice_risk_multiplier",
            "volatility_remaining_multiplier",
            "depth_risk_max",
            "max_signal_edge",
            "kelly_multiplier",
            "max_stake_fraction",
            "max_stake_abs_usdc",
            "book_participation",
            "min_stake_usdc",
            "tick_size",
        )
        for name in decimals:
            value = getattr(self, name)
            if not value.is_finite() or value < ZERO:
                raise ValueError(f"{name} must be a finite non-negative Decimal")
        if (
            self.short_volatility_weight
            + self.medium_volatility_weight
            + self.long_volatility_weight
            != ONE
        ):
            raise ValueError("adaptive volatility weights must sum to one")
        if not ZERO < self.probability_clamp < Decimal("0.5"):
            raise ValueError("probability_clamp must be between zero and 0.5")
        if not ZERO < self.book_participation <= ONE:
            raise ValueError("book_participation must be in (0, 1]")
        if self.volatility_drag_reference <= ZERO:
            raise ValueError("volatility_drag_reference must be positive")
        if self.max_signal_edge <= ZERO:
            raise ValueError("max_signal_edge must be positive")

    def to_mapping(self) -> dict[str, str]:
        return {
            name: format(value, "f")
            for name, value in (
                ("short_volatility_weight", self.short_volatility_weight),
                ("medium_volatility_weight", self.medium_volatility_weight),
                ("long_volatility_weight", self.long_volatility_weight),
                ("sigma_floor", self.sigma_floor),
                ("shock_weight", self.shock_weight),
                ("probability_clamp", self.probability_clamp),
                ("volatility_drag_max", self.volatility_drag_max),
                ("volatility_drag_reference", self.volatility_drag_reference),
                ("anchor_noise_bps", self.anchor_noise_bps),
                ("anchor_uncertainty_multiplier", self.anchor_uncertainty_multiplier),
                ("latency_seconds", self.latency_seconds),
                ("latency_tick_fraction", self.latency_tick_fraction),
                ("btc_speed_multiplier", self.btc_speed_multiplier),
                ("market_quote_reprice_risk_multiplier", self.market_quote_reprice_risk_multiplier),
                ("volatility_remaining_multiplier", self.volatility_remaining_multiplier),
                ("depth_risk_max", self.depth_risk_max),
                ("max_signal_edge", self.max_signal_edge),
                ("kelly_multiplier", self.kelly_multiplier),
                ("max_stake_fraction", self.max_stake_fraction),
                ("max_stake_abs_usdc", self.max_stake_abs_usdc),
                ("book_participation", self.book_participation),
                ("min_stake_usdc", self.min_stake_usdc),
                ("tick_size", self.tick_size),
            )
        }


@dataclass(frozen=True, slots=True)
class LAdaptiveV2Config(LAdaptiveConfig):
    """Separate L candidate family with explicit, auditable entry sub-strategies.

    V1 remains byte-for-byte selectable through ``LAdaptiveConfig``.  V2 does
    not infer a price filter from outcomes: every rejection below is based only
    on the decision-time signal, book and volatility fields already available
    to V1.
    """

    config_version: str = "l-adaptive-execution-v2-candidate"
    entry_price_min: Decimal = Decimal("0")
    entry_price_max: Decimal = Decimal("1")
    edge_surplus_min: Decimal = Decimal("0")
    volatility_shock_max: Decimal = Decimal("100")

    def __post_init__(self) -> None:
        super().__post_init__()
        if not ZERO <= self.entry_price_min < self.entry_price_max <= ONE:
            raise ValueError("V2 entry price range must be inside (0, 1)")
        if self.edge_surplus_min < ZERO or self.volatility_shock_max < ZERO:
            raise ValueError("V2 entry guards must be non-negative")

    def to_mapping(self) -> dict[str, str]:
        return {
            **super().to_mapping(),
            "entry_price_min": format(self.entry_price_min, "f"),
            "entry_price_max": format(self.entry_price_max, "f"),
            "edge_surplus_min": format(self.edge_surplus_min, "f"),
            "volatility_shock_max": format(self.volatility_shock_max, "f"),
        }


def l_adaptive_v2_midrange_train_selected_config() -> LAdaptiveV2Config:
    """Return the one V2 candidate selected only from the TRAIN split.

    This is deliberately a named factory instead of a new V1 default: V1 must
    remain reproducible, and callers must opt into this separate candidate.
    The three non-price settings were selected together on TRAIN before the
    single VALIDATION run; they must not be changed from VALIDATION outcomes.
    """
    return LAdaptiveV2Config(
        probability_clamp=Decimal("0.02"),
        max_signal_edge=Decimal("0.25"),
        depth_risk_max=Decimal("0.02"),
        entry_price_min=Decimal("0.20"),
        entry_price_max=Decimal("0.80"),
    )


L_ADAPTIVE_PREREGISTRATION = {
    "protocol_version": "l-adaptive-execution-protocol-v1",
    "parameter_origin": "PRE_REGISTERED_EXECUTION_RISK_SPECIFICATION",
    "selection_allowed_splits": ["TRAIN"],
    "validation_split": "VALIDATION",
    "final_test_policy": "LOCKED_NOT_ACCEPTED_BY_PAPER_L_ADAPTIVE",
    "market_quote_velocity": (
        "NOT_AVAILABLE_IN_SINGLE_DECISION_TOP_OF_BOOK_RECEIPT; "
        "CURRENT_SPREAD_PROXY_ONLY"
    ),
}


def _d(value: Any, field: str) -> Decimal:
    try:
        result = Decimal(str(value))
    except Exception as exc:  # noqa: BLE001 - normalize foreign JSON values
        raise ValueError(f"{field} is not a Decimal") from exc
    if not result.is_finite():
        raise ValueError(f"{field} must be finite")
    return result


def _probability(
    row: Mapping[str, Any],
    strategy: KJStrategy,
    config: KJConfig,
    volatility_sample: Mapping[str, Any] | None = None,
) -> tuple[Decimal, Decimal]:
    features = row["binance"]
    remaining = _d(row["horizon_seconds"], "horizon_seconds")
    if remaining <= ZERO:
        raise ValueError("horizon_seconds must be positive")
    if volatility_sample is not None:
        key = (
            "j_single_sigma"
            if strategy is KJStrategy.J_FEE_AWARE
            else "k_effective_sigma"
        )
        sigma = _d(volatility_sample[key], key)
    else:
        single = _d(features["realized_vol_120s"], "realized_vol_120s")
        if strategy is KJStrategy.J_FEE_AWARE:
            sigma = single
        else:
            fast = _d(features["realized_vol_30s"], "realized_vol_30s")
            sigma = max(
                fast,
                config.k_vol_floor_ratio * single,
                config.k_absolute_min_sigma,
            )
    if sigma <= ZERO:
        return Decimal("0.5"), sigma
    z = float(_d(features["log_return_from_start"], "log_return_from_start")) / (
        float(sigma) * math.sqrt(float(remaining))
    )
    raw = Decimal(str(0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))))
    return min(max(raw, config.probability_clamp), ONE - config.probability_clamp), sigma


def _utc_datetime(value: Any, field: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be an explicit UTC timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.utcoffset() != timedelta(0):
        raise ValueError(f"{field} must be explicit UTC")
    return parsed


def _adaptive_signal(
    row: Mapping[str, Any], config: LAdaptiveConfig
) -> tuple[Decimal, dict[str, Decimal | str | bool]]:
    """Return L probability and auditable, point-in-time signal-risk components."""
    features = row["binance"]
    remaining = _d(row["horizon_seconds"], "horizon_seconds")
    if remaining <= ZERO:
        raise ValueError("horizon_seconds must be positive")
    short = _d(features["realized_vol_30s"], "realized_vol_30s")
    medium = _d(features["realized_vol_60s"], "realized_vol_60s")
    long = _d(features["realized_vol_120s"], "realized_vol_120s")
    if min(short, medium, long) < ZERO:
        raise ValueError("realized volatility must be non-negative")
    blended_variance = (
        config.short_volatility_weight * short * short
        + config.medium_volatility_weight * medium * medium
        + config.long_volatility_weight * long * long
        + config.sigma_floor * config.sigma_floor
    )
    blended = blended_variance.sqrt()
    relative_short_shock = abs(short - medium) / (short + medium + config.sigma_floor)
    relative_long_shock = abs(medium - long) / (medium + long + config.sigma_floor)
    shock = (relative_short_shock + relative_long_shock) / Decimal("2")
    sigma = blended * (ONE + config.shock_weight * shock)
    if sigma <= ZERO:
        return Decimal("0.5"), {
            "sigma_short": short,
            "sigma_medium": medium,
            "sigma_long": long,
            "sigma_blended": blended,
            "volatility_shock": shock,
            "volatility_drag": ZERO,
            "raw_probability_up": Decimal("0.5"),
            "remaining_uncertainty": ZERO,
        }
    log_return = _d(features["log_return_from_start"], "log_return_from_start")
    remaining_sqrt = Decimal(str(math.sqrt(float(remaining))))
    z = float(log_return / (sigma * remaining_sqrt))
    raw = Decimal(str(0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))))
    raw = min(max(raw, config.probability_clamp), ONE - config.probability_clamp)
    remaining_uncertainty = sigma * remaining_sqrt
    drag = config.volatility_drag_max * Decimal(
        str(1.0 - math.exp(-float(remaining_uncertainty / config.volatility_drag_reference)))
    )
    probability = Decimal("0.5") + (raw - Decimal("0.5")) * (ONE - drag)
    probability = min(max(probability, config.probability_clamp), ONE - config.probability_clamp)
    return probability, {
        "sigma_short": short,
        "sigma_medium": medium,
        "sigma_long": long,
        "sigma_blended": blended,
        "volatility_shock": shock,
        "volatility_drag": drag,
        "raw_probability_up": raw,
        "remaining_uncertainty": remaining_uncertainty,
    }


def _adaptive_anchor_band_usd(
    *, current_price: Decimal, remaining_uncertainty: Decimal, config: LAdaptiveConfig
) -> Decimal:
    """Risk-scaled opening-anchor ambiguity band, expressed in BTC/USD dollars."""
    if current_price <= ZERO:
        raise ValueError("current_price must be positive")
    relative_noise = config.anchor_noise_bps / Decimal("10000")
    relative_band = (
        relative_noise * relative_noise
        + (config.anchor_uncertainty_multiplier * remaining_uncertainty) ** 2
    ).sqrt()
    return current_price * relative_band


def _elapsed_market_seconds(row: Mapping[str, Any]) -> Decimal:
    start = _utc_datetime(row["market_start"], "market_start")
    decision = _utc_datetime(row["decision_time"], "decision_time")
    elapsed = Decimal(str((decision - start).total_seconds()))
    if elapsed <= ZERO:
        raise ValueError("decision_time must be after market_start")
    return elapsed


def _fee_per_share(rate: Decimal, price: Decimal) -> Decimal:
    return rate * price * (ONE - price)


def _event_id(*parts: object) -> str:
    return sha256("\0".join(str(part) for part in parts).encode("utf-8")).hexdigest()


def _plus_seconds(value: str, seconds: int) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.utcoffset() != timedelta(0):
        raise ValueError("event time must be explicit UTC")
    return (parsed + timedelta(seconds=seconds)).isoformat(timespec="seconds").replace("+00:00", "Z")


def simulate_l_adaptive_decision(
    row: Mapping[str, Any],
    *,
    scenario: PaperScenario,
    bankroll: Decimal,
    config: LAdaptiveConfig,
) -> dict[str, Any]:
    """Simulate L's point-in-time, risk-adjusted execution decision.

    The single-decision historical receipt has no prior CLOB quote observation.  L therefore
    records the current top-of-book width as a one-second *reprice-risk proxy*, rather than
    incorrectly deriving quote velocity from the one-second-later execution book.
    """
    probability, signal = _adaptive_signal(row, config)
    current = _d(row["binance"]["current_price"], "current_price")
    opening = _d(row["binance"]["start_price"], "start_price")
    remaining = int(row["horizon_seconds"])
    anchor_band = _adaptive_anchor_band_usd(
        current_price=current,
        remaining_uncertainty=signal["remaining_uncertainty"],  # type: ignore[arg-type]
        config=config,
    )
    base = {
        "market_id": str(row["condition_id"]),
        "slug": str(row["slug"]),
        "strategy": AdaptiveStrategy.L_ADAPTIVE_EXECUTION.value,
        "scenario": scenario.value,
        "decision_time": str(row["decision_time"]),
        "horizon_seconds": remaining,
        "signal_fidelity": ADAPTIVE_SIGNAL_FIDELITY,
        "probability_up": format(probability, "f"),
        "raw_probability_up": format(signal["raw_probability_up"], "f"),
        "effective_sigma": format(
            signal["sigma_blended"] * (ONE + config.shock_weight * signal["volatility_shock"]),
            "f",
        ),
        "sigma_short": format(signal["sigma_short"], "f"),
        "sigma_medium": format(signal["sigma_medium"], "f"),
        "sigma_long": format(signal["sigma_long"], "f"),
        "sigma_blended": format(signal["sigma_blended"], "f"),
        "volatility_shock": format(signal["volatility_shock"], "f"),
        "volatility_drag": format(signal["volatility_drag"], "f"),
        "remaining_uncertainty": format(signal["remaining_uncertainty"], "f"),
        "critical_anchor_band_usd": format(anchor_band, "f"),
        "bankroll_before": format(bankroll, "f"),
        "winner": str(row["winner"]),
    }
    if abs(current - opening) < anchor_band:
        return {
            **base,
            "status": "NO_TRADE",
            "reason": "DYNAMIC_OPENING_ANCHOR_BAND",
            "net_pnl": "0",
        }

    decision_book = row["books"]["decision_plus_1s_visibility"]
    if not isinstance(decision_book, dict):
        return {
            **base,
            "status": "NO_TRADE",
            "reason": "MISSING_DECISION_BOOK",
            "net_pnl": "0",
        }
    ask_up = _d(decision_book["au"], "decision.ask_up")
    ask_down = _d(decision_book["ad"], "decision.ask_down")
    bid_up = _d(decision_book["bu"], "decision.bid_up")
    bid_down = _d(decision_book["bd"], "decision.bid_down")
    if not (ZERO < bid_up <= ask_up < ONE and ZERO < bid_down <= ask_down < ONE):
        return {
            **base,
            "status": "NO_TRADE",
            "reason": "INVALID_DECISION_TOP_OF_BOOK",
            "net_pnl": "0",
        }
    rate = _d(row["fee_evidence"]["fee_rate"], "fee_rate")
    if row["fee_evidence"]["grade"] not in {
        "POINT_IN_TIME_OFFICIAL",
        "MARKET_STATIC_OFFICIAL",
    }:
        return {
            **base,
            "status": "NO_TRADE",
            "reason": "UNVERIFIED_FEE",
            "net_pnl": "0",
        }
    candidates = (("UP", probability, ask_up), ("DOWN", ONE - probability, ask_down))
    side, side_probability, decision_ask = max(
        candidates, key=lambda item: item[1] - item[2]
    )
    decision_size_key = "sau" if side == "UP" else "sad"
    decision_visible = _d(decision_book[decision_size_key], "decision.ask_size")
    if decision_visible <= ZERO:
        return {
            **base,
            "status": "NO_TRADE",
            "reason": "NO_VISIBLE_DECISION_ASK_SIZE",
            "net_pnl": "0",
        }
    edge = side_probability - decision_ask
    raw_kelly = max(ZERO, edge / (ONE - decision_ask))
    fraction = min(raw_kelly * config.kelly_multiplier, config.max_stake_fraction)
    decision_fee_per_stake = rate * (ONE - decision_ask)
    cash_cap = bankroll * config.max_stake_fraction / (ONE + decision_fee_per_stake)
    target_stake = min(bankroll * fraction, cash_cap, config.max_stake_abs_usdc)
    executable_notional = decision_visible * decision_ask * config.book_participation
    depth_pressure = (
        ZERO
        if target_stake <= ZERO
        else Decimal(str(1.0 - math.exp(-float(target_stake / executable_notional))))
    )
    log_return = _d(row["binance"]["log_return_from_start"], "log_return_from_start")
    btc_speed = abs(log_return) / _elapsed_market_seconds(row)
    quote_reprice_risk_proxy = ((ask_up - bid_up) + (ask_down - bid_down)) / Decimal("2")
    required_components = {
        "fee": _fee_per_share(rate, decision_ask),
        "half_overround": max(ZERO, (ask_up + ask_down - ONE) / Decimal("2")),
        "latency_slippage": config.tick_size
        * config.latency_tick_fraction
        * config.latency_seconds,
        "btc_speed": btc_speed * config.btc_speed_multiplier * config.latency_seconds,
        "market_quote_reprice_risk": quote_reprice_risk_proxy
        * config.market_quote_reprice_risk_multiplier
        * config.latency_seconds,
        "volatility_remaining": signal["remaining_uncertainty"]
        * config.volatility_remaining_multiplier,
        "depth_participation": config.depth_risk_max * depth_pressure,
    }
    required_edge = sum(required_components.values(), ZERO)
    base = {
        **base,
        "side": side,
        "side_probability": format(side_probability, "f"),
        "decision_ask": format(decision_ask, "f"),
        "decision_visible_ask_size": format(decision_visible, "f"),
        "edge": format(edge, "f"),
        "required_edge": format(required_edge, "f"),
        "required_edge_fee": format(required_components["fee"], "f"),
        "required_edge_half_overround": format(required_components["half_overround"], "f"),
        "required_edge_latency_slippage": format(required_components["latency_slippage"], "f"),
        "required_edge_btc_speed": format(required_components["btc_speed"], "f"),
        "required_edge_market_quote_reprice_risk": format(
            required_components["market_quote_reprice_risk"], "f"
        ),
        "required_edge_volatility_remaining": format(
            required_components["volatility_remaining"], "f"
        ),
        "required_edge_depth_participation": format(
            required_components["depth_participation"], "f"
        ),
        "fee_rate": format(rate, "f"),
        "btc_log_speed_per_second": format(btc_speed, "f"),
        "btc_log_speed_source": "START_TO_DECISION_AVERAGE_LOG_RETURN_PROXY",
        "market_quote_reprice_risk_proxy": format(quote_reprice_risk_proxy, "f"),
        "market_quote_reprice_risk_source": "CURRENT_TOP_OF_BOOK_SPREAD_PROXY_1HZ",
        "market_quote_velocity_available": False,
        "depth_pressure": format(depth_pressure, "f"),
    }
    entry_price_min = getattr(config, "entry_price_min", ZERO)
    entry_price_max = getattr(config, "entry_price_max", ONE)
    edge_surplus_min = getattr(config, "edge_surplus_min", ZERO)
    volatility_shock_max = getattr(config, "volatility_shock_max", Decimal("100"))
    if not entry_price_min < decision_ask < entry_price_max:
        return {
            **base,
            "status": "NO_TRADE",
            "reason": "ENTRY_PRICE_OUTSIDE_V2_RANGE",
            "net_pnl": "0",
        }
    if signal["volatility_shock"] > volatility_shock_max:
        return {
            **base,
            "status": "NO_TRADE",
            "reason": "VOLATILITY_SHOCK_ABOVE_V2_GUARD",
            "net_pnl": "0",
        }
    if edge <= required_edge:
        return {
            **base,
            "status": "NO_TRADE",
            "reason": "EDGE_BELOW_DYNAMIC_EXECUTION_THRESHOLD",
            "net_pnl": "0",
        }
    if edge - required_edge <= edge_surplus_min:
        return {
            **base,
            "status": "NO_TRADE",
            "reason": "EDGE_SURPLUS_BELOW_V2_GUARD",
            "net_pnl": "0",
        }
    if edge > config.max_signal_edge:
        return {
            **base,
            "status": "NO_TRADE",
            "reason": "EDGE_ABOVE_STALE_QUOTE_GUARD",
            "net_pnl": "0",
        }

    intended_quantity = min(
        target_stake / decision_ask,
        decision_visible * config.book_participation,
    )
    intended_stake = intended_quantity * decision_ask
    intended_fee = _fee_per_share(rate, decision_ask) * intended_quantity
    if intended_stake < config.min_stake_usdc:
        return {
            **base,
            "status": "NO_TRADE",
            "reason": "BELOW_MINIMUM_INTENT_STAKE",
            "net_pnl": "0",
        }
    base = {
        **base,
        "intended_quantity": format(intended_quantity, "f"),
        "intended_stake": format(intended_stake, "f"),
        "intended_fee": format(intended_fee, "f"),
    }
    execution_book = row["books"].get("execution_base_1s")
    if not isinstance(execution_book, dict):
        return {
            **base,
            "status": "UNFILLED",
            "reason": "MISSING_EXECUTION_BOOK",
            "net_pnl": "0",
        }
    ask_key, size_key = ("au", "sau") if side == "UP" else ("ad", "sad")
    raw_fill_price = _d(execution_book[ask_key], "execution.ask")
    if not ZERO < raw_fill_price < ONE:
        return {
            **base,
            "status": "UNFILLED",
            "reason": "EXECUTION_PRICE_OUT_OF_RANGE",
            "net_pnl": "0",
        }
    fill_price = raw_fill_price + (
        config.tick_size if scenario is PaperScenario.STRESS_1S_PLUS_TICK else ZERO
    )
    if not ZERO < fill_price < ONE:
        return {
            **base,
            "status": "UNFILLED",
            "reason": "EXECUTION_PRICE_OUT_OF_RANGE",
            "net_pnl": "0",
        }
    visible = _d(execution_book[size_key], "execution.ask_size")
    if visible <= ZERO:
        return {
            **base,
            "status": "UNFILLED",
            "reason": "NO_VISIBLE_ASK_SIZE",
            "net_pnl": "0",
        }
    quantity = min(intended_quantity, visible * config.book_participation)
    if quantity <= ZERO:
        return {
            **base,
            "status": "UNFILLED",
            "reason": "NO_EXECUTABLE_QUANTITY",
            "net_pnl": "0",
        }
    stake = quantity * fill_price
    fee = _fee_per_share(rate, fill_price) * quantity
    if stake + fee > bankroll:
        return {
            **base,
            "status": "UNFILLED",
            "reason": "INSUFFICIENT_AVAILABLE_CASH",
            "net_pnl": "0",
        }
    won = side == str(row["winner"]).upper()
    payout = quantity if won else ZERO
    gross_pnl = payout - stake
    net_pnl = gross_pnl - fee
    intent_id = _event_id(
        ADAPTIVE_ENGINE_VERSION,
        row["condition_id"],
        AdaptiveStrategy.L_ADAPTIVE_EXECUTION.value,
        scenario.value,
        "intent",
    )
    fill_id = _event_id(intent_id, "fill")
    settlement_id = _event_id(row["condition_id"], row["winner"], "official-settlement")
    return {
        **base,
        "status": "FILLED",
        "reason": None,
        "intent_id": intent_id,
        "fill_id": fill_id,
        "settlement_id": settlement_id,
        "fill_time": _plus_seconds(str(row["decision_time"]), 1),
        "market_end": str(row["market_end"]),
        "settlement_evidence_time": str(row["fee_evidence"]["fetch_time"]),
        "fill_price": format(fill_price, "f"),
        "visible_ask_size": format(visible, "f"),
        "quantity": format(quantity, "f"),
        "partial_fill": quantity < intended_quantity,
        "stake": format(stake, "f"),
        "fee": format(fee, "f"),
        "cash_after_fill": format(bankroll - stake - fee, "f"),
        "position_before": "0",
        "position_after_fill": format(quantity, "f"),
        "position_after_settlement": "0",
        "payout": format(payout, "f"),
        "gross_pnl": format(gross_pnl, "f"),
        "net_pnl": format(net_pnl, "f"),
        "bankroll_after": format(bankroll + net_pnl, "f"),
    }


def simulate_decision(
    row: Mapping[str, Any],
    *,
    strategy: KJStrategy | AdaptiveStrategy,
    scenario: PaperScenario,
    bankroll: Decimal,
    config: KJConfig,
    volatility_sample: Mapping[str, Any] | None = None,
    adaptive_config: LAdaptiveConfig = LAdaptiveConfig(),
) -> dict[str, Any]:
    """Return one immutable decision/fill/settlement record for a historical market."""
    if strategy is AdaptiveStrategy.L_ADAPTIVE_EXECUTION:
        return simulate_l_adaptive_decision(
            row,
            scenario=scenario,
            bankroll=bankroll,
            config=adaptive_config,
        )
    probability, sigma = _probability(row, strategy, config, volatility_sample)
    signal_fidelity = (
        EWMA_SIGNAL_FIDELITY if volatility_sample is not None else SIGNAL_FIDELITY
    )
    current = _d(row["binance"]["current_price"], "current_price")
    opening = _d(row["binance"]["start_price"], "start_price")
    remaining = int(row["horizon_seconds"])
    base = {
        "market_id": str(row["condition_id"]),
        "slug": str(row["slug"]),
        "strategy": strategy.value,
        "scenario": scenario.value,
        "decision_time": str(row["decision_time"]),
        "horizon_seconds": remaining,
        "signal_fidelity": signal_fidelity,
        "probability_up": format(probability, "f"),
        "effective_sigma": format(sigma, "f"),
        "bankroll_before": format(bankroll, "f"),
        "winner": str(row["winner"]),
    }
    if remaining < config.critical_band_max_remaining_s and abs(current - opening) < config.critical_band_usd:
        return {**base, "status": "NO_TRADE", "reason": "CRITICAL_BAND", "net_pnl": "0"}

    decision_book = row["books"]["decision_plus_1s_visibility"]
    if not isinstance(decision_book, dict):
        return {**base, "status": "NO_TRADE", "reason": "MISSING_DECISION_BOOK", "net_pnl": "0"}
    ask_up = _d(decision_book["au"], "decision.ask_up")
    ask_down = _d(decision_book["ad"], "decision.ask_down")
    rate = _d(row["fee_evidence"]["fee_rate"], "fee_rate")
    if row["fee_evidence"]["grade"] not in {"POINT_IN_TIME_OFFICIAL", "MARKET_STATIC_OFFICIAL"}:
        return {**base, "status": "NO_TRADE", "reason": "UNVERIFIED_FEE", "net_pnl": "0"}
    candidates: list[tuple[str, Decimal, Decimal]] = []
    if ZERO < ask_up < ONE:
        candidates.append(("UP", probability, ask_up))
    if ZERO < ask_down < ONE:
        candidates.append(("DOWN", ONE - probability, ask_down))
    if not candidates:
        return {
            **base,
            "status": "NO_TRADE",
            "reason": "NO_VALID_DECISION_ASK",
            "net_pnl": "0",
        }
    side, side_probability, decision_ask = max(candidates, key=lambda item: item[1] - item[2])
    edge = side_probability - decision_ask
    spread_buffer = max(ZERO, (ask_up + ask_down - ONE) / Decimal("2"))
    threshold = config.edge_threshold + _fee_per_share(rate, decision_ask) + spread_buffer
    base = {
        **base,
        "side": side,
        "side_probability": format(side_probability, "f"),
        "decision_ask": format(decision_ask, "f"),
        "edge": format(edge, "f"),
        "required_edge": format(threshold, "f"),
        "fee_rate": format(rate, "f"),
    }
    if edge <= threshold:
        return {**base, "status": "NO_TRADE", "reason": "EDGE_BELOW_FEE_AWARE_THRESHOLD", "net_pnl": "0"}
    if edge > config.max_edge:
        return {**base, "status": "NO_TRADE", "reason": "EDGE_ABOVE_STALE_QUOTE_GUARD", "net_pnl": "0"}

    decision_size_key = "sau" if side == "UP" else "sad"
    decision_visible = _d(decision_book[decision_size_key], "decision.ask_size")
    if decision_visible <= ZERO:
        return {
            **base,
            "status": "NO_TRADE",
            "reason": "NO_VISIBLE_DECISION_ASK_SIZE",
            "net_pnl": "0",
        }
    kelly = max(ZERO, (side_probability - decision_ask) / (ONE - decision_ask))
    fraction = min(kelly * config.kelly_multiplier, config.max_stake_fraction)
    decision_fee_per_stake = rate * (ONE - decision_ask)
    decision_stake_cap = (
        bankroll * config.max_stake_fraction / (ONE + decision_fee_per_stake)
    )
    intended_stake = min(
        bankroll * fraction,
        decision_stake_cap,
        config.max_stake_abs_usdc,
    )
    intended_quantity = min(
        intended_stake / decision_ask,
        decision_visible * config.book_participation,
    )
    intended_stake = intended_quantity * decision_ask
    intended_fee = _fee_per_share(rate, decision_ask) * intended_quantity
    if intended_stake < config.min_stake_usdc:
        return {
            **base,
            "status": "NO_TRADE",
            "reason": "BELOW_MINIMUM_INTENT_STAKE",
            "net_pnl": "0",
        }
    base = {
        **base,
        "decision_visible_ask_size": format(decision_visible, "f"),
        "intended_quantity": format(intended_quantity, "f"),
        "intended_stake": format(intended_stake, "f"),
        "intended_fee": format(intended_fee, "f"),
    }

    execution_key = "execution_base_1s"
    execution_book = row["books"].get(execution_key)
    if not isinstance(execution_book, dict):
        return {**base, "status": "UNFILLED", "reason": "MISSING_EXECUTION_BOOK", "net_pnl": "0"}
    ask_key, size_key = ("au", "sau") if side == "UP" else ("ad", "sad")
    raw_fill_price = _d(execution_book[ask_key], "execution.ask")
    if not ZERO < raw_fill_price < ONE:
        return {
            **base,
            "status": "UNFILLED",
            "reason": "EXECUTION_PRICE_OUT_OF_RANGE",
            "net_pnl": "0",
        }
    fill_price = raw_fill_price
    if scenario is PaperScenario.STRESS_1S_PLUS_TICK:
        fill_price += config.tick_size
    if not ZERO < fill_price < ONE:
        return {**base, "status": "UNFILLED", "reason": "EXECUTION_PRICE_OUT_OF_RANGE", "net_pnl": "0"}
    visible = _d(execution_book[size_key], "execution.ask_size")
    if visible <= ZERO:
        return {**base, "status": "UNFILLED", "reason": "NO_VISIBLE_ASK_SIZE", "net_pnl": "0"}

    quantity = min(intended_quantity, visible * config.book_participation)
    if quantity <= ZERO:
        return {
            **base,
            "status": "UNFILLED",
            "reason": "NO_EXECUTABLE_QUANTITY",
            "net_pnl": "0",
        }
    stake = quantity * fill_price
    fee = _fee_per_share(rate, fill_price) * quantity
    if stake + fee > bankroll:
        return {**base, "status": "UNFILLED", "reason": "INSUFFICIENT_AVAILABLE_CASH", "net_pnl": "0"}

    won = side == str(row["winner"]).upper()
    payout = quantity if won else ZERO
    gross_pnl = payout - stake
    net_pnl = gross_pnl - fee
    intent_id = _event_id(ENGINE_VERSION, row["condition_id"], strategy.value, scenario.value, "intent")
    fill_id = _event_id(intent_id, "fill")
    settlement_id = _event_id(row["condition_id"], row["winner"], "official-settlement")
    return {
        **base,
        "status": "FILLED",
        "reason": None,
        "intent_id": intent_id,
        "fill_id": fill_id,
        "settlement_id": settlement_id,
        "fill_time": _plus_seconds(str(row["decision_time"]), 1),
        "market_end": str(row["market_end"]),
        "settlement_evidence_time": str(row["fee_evidence"]["fetch_time"]),
        "fill_price": format(fill_price, "f"),
        "visible_ask_size": format(visible, "f"),
        "quantity": format(quantity, "f"),
        "partial_fill": quantity < intended_quantity,
        "stake": format(stake, "f"),
        "fee": format(fee, "f"),
        "cash_after_fill": format(bankroll - stake - fee, "f"),
        "position_before": "0",
        "position_after_fill": format(quantity, "f"),
        "position_after_settlement": "0",
        "payout": format(payout, "f"),
        "gross_pnl": format(gross_pnl, "f"),
        "net_pnl": format(net_pnl, "f"),
        "bankroll_after": format(bankroll + net_pnl, "f"),
    }


def run_kj_paper(
    receipt: HistoricalDatasetReceipt,
    rows: Sequence[Mapping[str, Any]],
    *,
    strategies: Sequence[KJStrategy | AdaptiveStrategy],
    split: str = "FINAL_TEST",
    horizon_seconds: int = 30,
    scenario: PaperScenario = PaperScenario.BASE_1S,
    initial_cash: Decimal = Decimal("10000"),
    config: KJConfig = KJConfig(),
    ewma_artifact: KJEwmaArtifact | None = None,
    adaptive_config: LAdaptiveConfig = LAdaptiveConfig(),
) -> dict[str, Any]:
    if receipt.manifest["audit"]["gate"]["passed"] is not True:
        raise ValueError("historical dataset gate did not pass")
    if initial_cash <= ZERO:
        raise ValueError("initial_cash must be positive")
    if ewma_artifact is not None and ewma_artifact.dataset_hash != receipt.dataset_hash:
        raise ValueError("EWMA artifact belongs to another historical dataset")
    has_adaptive = AdaptiveStrategy.L_ADAPTIVE_EXECUTION in strategies
    if has_adaptive and len(strategies) != 1:
        raise ValueError("L_ADAPTIVE_EXECUTION must run separately from frozen J/K baselines")
    if has_adaptive and split not in {"TRAIN", "VALIDATION"}:
        raise ValueError("L_ADAPTIVE_EXECUTION permits only TRAIN or VALIDATION")
    if has_adaptive and ewma_artifact is not None:
        raise ValueError("L_ADAPTIVE_EXECUTION uses receipt volatility windows, not K/J EWMA")
    selected = sorted(
        (
            row for row in rows
            if row["split"] == split and int(row["horizon_seconds"]) == horizon_seconds
        ),
        key=lambda row: (row["decision_time"], row["condition_id"]),
    )
    if not selected:
        raise ValueError("no rows match split and horizon")

    runs: dict[str, Any] = {}
    all_events: list[dict[str, Any]] = []
    for strategy in strategies:
        cash = initial_cash
        peak = initial_cash
        max_drawdown = ZERO
        events: list[dict[str, Any]] = []
        for row in selected:
            event = simulate_decision(
                row,
                strategy=strategy,
                scenario=scenario,
                bankroll=cash,
                config=config,
                adaptive_config=adaptive_config,
                volatility_sample=(
                    None
                    if ewma_artifact is None
                    else ewma_artifact.samples.get(
                        (str(row["condition_id"]), int(row["horizon_seconds"]))
                    )
                ),
            )
            if (
                ewma_artifact is not None
                and isinstance(strategy, KJStrategy)
                and event["signal_fidelity"] != EWMA_SIGNAL_FIDELITY
            ):
                raise ValueError("EWMA artifact is missing a selected decision sample")
            event = {"sequence": len(events) + 1, **event}
            if event["status"] == "FILLED":
                cash += Decimal(event["net_pnl"])
                peak = max(peak, cash)
                max_drawdown = max(max_drawdown, peak - cash)
            events.append(event)
            all_events.append(event)
        fills = [event for event in events if event["status"] == "FILLED"]
        reason_counts: dict[str, int] = {}
        for event in events:
            reason = str(event.get("reason") or event["status"])
            reason_counts[reason] = reason_counts.get(reason, 0) + 1
        gross = sum((_d(event["gross_pnl"], "gross_pnl") for event in fills), ZERO)
        fees = sum((_d(event["fee"], "fee") for event in fills), ZERO)
        net = sum((_d(event["net_pnl"], "net_pnl") for event in fills), ZERO)
        daily: dict[str, Decimal] = {}
        for event in fills:
            day = str(event["decision_time"])[:10]
            daily[day] = daily.get(day, ZERO) + _d(event["net_pnl"], "net_pnl")
        best_days = sorted(daily.values(), reverse=True)
        concentration = {
            str(count): {
                "best_days_pnl": format(sum(best_days[:count], ZERO), "f"),
                "net_without_best_days": format(net - sum(best_days[:count], ZERO), "f"),
            }
            for count in (1, 2, 3)
        }
        best_three = sum(best_days[:3], ZERO)
        probabilities = [_d(event["probability_up"], "probability_up") for event in events]
        labels = [ONE if event["winner"] == "Up" else ZERO for event in events]
        brier = sum(
            ((probability - label) ** 2 for probability, label in zip(probabilities, labels)),
            ZERO,
        ) / Decimal(len(events))
        log_loss = sum(
            (
                Decimal(
                    str(
                        -math.log(
                            float(
                                probability if label == ONE else ONE - probability
                            )
                        )
                    )
                )
                for probability, label in zip(probabilities, labels)
            ),
            ZERO,
        ) / Decimal(len(events))
        wins = sum(_d(event["payout"], "payout") > ZERO for event in fills)
        runs[strategy.value] = {
            "strategy": strategy.value,
            "decision_count": len(events),
            "filled_count": len(fills),
            "no_trade_or_unfilled_count": len(events) - len(fills),
            "reason_counts": dict(sorted(reason_counts.items())),
            "initial_cash": format(initial_cash, "f"),
            "final_cash": format(cash, "f"),
            "gross_pnl": format(gross, "f"),
            "fees": format(fees, "f"),
            "net_pnl": format(net, "f"),
            "max_drawdown": format(max_drawdown, "f"),
            "win_count": wins,
            "loss_count": len(fills) - wins,
            "win_rate": format(Decimal(wins) / Decimal(len(fills)), "f") if fills else None,
            "brier_score": format(brier, "f"),
            "log_loss": format(log_loss, "f"),
            "daily_pnl": {
                day: format(value, "f") for day, value in sorted(daily.items())
            },
            "concentration_stress": concentration,
            "best_3_days_pnl": format(best_three, "f"),
            "net_without_best_3_days": format(net - best_three, "f"),
        }
    core = {
        "engine_version": ADAPTIVE_ENGINE_VERSION if has_adaptive else ENGINE_VERSION,
        "engine_code_sha256": ENGINE_CODE_SHA256,
        "dataset_hash": receipt.dataset_hash,
        "signal_fidelity": (
            ADAPTIVE_SIGNAL_FIDELITY
            if has_adaptive
            else EWMA_SIGNAL_FIDELITY if ewma_artifact is not None else SIGNAL_FIDELITY
        ),
        "signal_fidelity_reason": (
            "Smooth 30/60/120s receipt volatility blend plus execution-risk proxies; "
            "no historical Chainlink price or consecutive CLOB quote velocity is available"
            if has_adaptive
            else "Canonical 5s EWMA from pinned official Binance 1s closes; not legacy tick/source equivalence"
            if ewma_artifact is not None
            else "Frozen samples provide 30/60/120s realized volatility, not persisted legacy EWMA state"
        ),
        "ewma_artifact_hash": (
            None if ewma_artifact is None else ewma_artifact.artifact_hash
        ),
        "split": split,
        "horizon_seconds": horizon_seconds,
        "scenario": scenario.value,
        "config": (
            {
                "config_version": adaptive_config.config_version,
                **adaptive_config.to_mapping(),
            }
            if has_adaptive
            else config.to_mapping()
        ),
        "runs": runs,
        "safety": {
            "live_trading_enabled": False,
            "network_used": False,
            "credentials_used": False,
            "orders_submitted": False,
        },
        "disclaimer": (
            "Research-only historical paper reconstruction over third-party 1 Hz top-of-book "
            "samples with UNVERIFIED continuity; results are not live-profit evidence."
        ),
    }
    if has_adaptive:
        core["adaptive_config"] = {
            "config_version": adaptive_config.config_version,
            **adaptive_config.to_mapping(),
        }
        core["evaluation_protocol"] = L_ADAPTIVE_PREREGISTRATION
    result_hash = sha256(canonical_json(core).encode("utf-8")).hexdigest()
    return {**core, "result_hash": result_hash, "events": all_events}


def run_l_adaptive_paper(
    receipt: HistoricalDatasetReceipt,
    rows: Sequence[Mapping[str, Any]],
    *,
    split: str,
    horizon_seconds: int = 30,
    scenario: PaperScenario = PaperScenario.BASE_1S,
    initial_cash: Decimal = Decimal("10000"),
    config: LAdaptiveConfig = LAdaptiveConfig(),
) -> dict[str, Any]:
    """Run only the pre-registered TRAIN or VALIDATION L protocol.

    FINAL_TEST is deliberately unavailable through this command: a later approval must
    explicitly freeze the training/validation decision before any untouched holdout is opened.
    """
    if split not in {"TRAIN", "VALIDATION"}:
        raise ValueError("L_ADAPTIVE_EXECUTION permits only TRAIN or VALIDATION")
    result = run_kj_paper(
        receipt,
        rows,
        strategies=(AdaptiveStrategy.L_ADAPTIVE_EXECUTION,),
        split=split,
        horizon_seconds=horizon_seconds,
        scenario=scenario,
        initial_cash=initial_cash,
        adaptive_config=config,
    )
    evaluation_stage = (
            "TRAIN_FIXED_CONFIGURATION_AUDIT"
            if split == "TRAIN"
            else "VALIDATION_PRE_REGISTERED_CONFIGURATION"
    )
    core = {
        key: value
        for key, value in result.items()
        if key not in {"events", "result_hash"}
    }
    core["evaluation_stage"] = evaluation_stage
    return {
        **core,
        "result_hash": sha256(canonical_json(core).encode("utf-8")).hexdigest(),
        "events": result["events"],
    }


HISTORICAL_PAPER_PUBLICATION_VERSION = "kj-historical-paper-publication-v1"


def _durable_new_text(path: Path, value: str) -> None:
    """Write one new small artifact durably; never replace an existing file."""
    with path.open("x", encoding="utf-8") as handle:
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())


def export_kj_paper(result: Mapping[str, Any], output: Path) -> None:
    """Publish result sidecars, then commit their complete set with a durable manifest.

    A process interruption can leave the reserved directory and early sidecars behind, but
    it cannot create ``publication.json``.  Readers that need a complete export therefore
    require that manifest rather than treating an early ``summary.json`` as publication.
    """
    output.mkdir(parents=True, exist_ok=False)
    summary = {key: value for key, value in result.items() if key != "events"}
    _durable_new_text(
        output / "summary.json",
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    )
    events = result["events"]
    with (output / "events.ndjson").open("x", encoding="utf-8") as handle:
        for event in events:
            handle.write(canonical_json(event) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    columns = (
        "sequence", "market_id", "slug", "strategy", "scenario", "decision_time",
        "status", "reason", "side", "probability_up", "effective_sigma", "edge",
        "required_edge", "fill_price", "quantity", "stake", "fee", "payout",
        "gross_pnl", "net_pnl", "bankroll_before", "cash_after_fill",
        "bankroll_after", "position_before", "position_after_fill",
        "position_after_settlement", "winner",
    )
    with (output / "trades.csv").open("x", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(events)
        handle.flush()
        os.fsync(handle.fileno())
    files = {
        name: {
            "bytes": (output / name).stat().st_size,
            "sha256": file_sha256(output / name),
        }
        for name in ("summary.json", "events.ndjson", "trades.csv")
    }
    core = {
        "schema_version": HISTORICAL_PAPER_PUBLICATION_VERSION,
        "result_hash": summary["result_hash"],
        "files": files,
    }
    publication = {
        **core,
        "publication_hash": sha256(canonical_json(core).encode("utf-8")).hexdigest(),
    }
    _durable_new_text(
        output / "publication.json",
        json.dumps(publication, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    )
