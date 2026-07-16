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
from pathlib import Path
from typing import Any, Mapping, Sequence

from .historical_adapter import HistoricalDatasetReceipt, canonical_json
from .kj_ewma import KJEwmaArtifact, SIGNAL_FIDELITY as EWMA_SIGNAL_FIDELITY


ZERO = Decimal("0")
ONE = Decimal("1")
SIGNAL_FIDELITY = "APPROXIMATE_VOLATILITY_PROXY"
ENGINE_VERSION = "kj-paper-v2"
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


def _fee_per_share(rate: Decimal, price: Decimal) -> Decimal:
    return rate * price * (ONE - price)


def _event_id(*parts: object) -> str:
    return sha256("\0".join(str(part) for part in parts).encode("utf-8")).hexdigest()


def _plus_seconds(value: str, seconds: int) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.utcoffset() != timedelta(0):
        raise ValueError("event time must be explicit UTC")
    return (parsed + timedelta(seconds=seconds)).isoformat(timespec="seconds").replace("+00:00", "Z")


def simulate_decision(
    row: Mapping[str, Any],
    *,
    strategy: KJStrategy,
    scenario: PaperScenario,
    bankroll: Decimal,
    config: KJConfig,
    volatility_sample: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Return one immutable decision/fill/settlement record for a historical market."""
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
    strategies: Sequence[KJStrategy],
    split: str = "FINAL_TEST",
    horizon_seconds: int = 30,
    scenario: PaperScenario = PaperScenario.BASE_1S,
    initial_cash: Decimal = Decimal("10000"),
    config: KJConfig = KJConfig(),
    ewma_artifact: KJEwmaArtifact | None = None,
) -> dict[str, Any]:
    if receipt.manifest["audit"]["gate"]["passed"] is not True:
        raise ValueError("historical dataset gate did not pass")
    if initial_cash <= ZERO:
        raise ValueError("initial_cash must be positive")
    if ewma_artifact is not None and ewma_artifact.dataset_hash != receipt.dataset_hash:
        raise ValueError("EWMA artifact belongs to another historical dataset")
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
                volatility_sample=(
                    None
                    if ewma_artifact is None
                    else ewma_artifact.samples.get(
                        (str(row["condition_id"]), int(row["horizon_seconds"]))
                    )
                ),
            )
            if ewma_artifact is not None and event["signal_fidelity"] != EWMA_SIGNAL_FIDELITY:
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
        best_three = sum(sorted(daily.values(), reverse=True)[:3], ZERO)
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
            "best_3_days_pnl": format(best_three, "f"),
            "net_without_best_3_days": format(net - best_three, "f"),
        }
    core = {
        "engine_version": ENGINE_VERSION,
        "engine_code_sha256": ENGINE_CODE_SHA256,
        "dataset_hash": receipt.dataset_hash,
        "signal_fidelity": (
            EWMA_SIGNAL_FIDELITY if ewma_artifact is not None else SIGNAL_FIDELITY
        ),
        "signal_fidelity_reason": (
            "Canonical 5s EWMA from pinned official Binance 1s closes; not legacy tick/source equivalence"
            if ewma_artifact is not None
            else "Frozen samples provide 30/60/120s realized volatility, not persisted legacy EWMA state"
        ),
        "ewma_artifact_hash": (
            None if ewma_artifact is None else ewma_artifact.artifact_hash
        ),
        "split": split,
        "horizon_seconds": horizon_seconds,
        "scenario": scenario.value,
        "config": config.to_mapping(),
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
    result_hash = sha256(canonical_json(core).encode("utf-8")).hexdigest()
    return {**core, "result_hash": result_hash, "events": all_events}


def export_kj_paper(result: Mapping[str, Any], output: Path) -> None:
    """Atomically publish summary JSON, append-only-style NDJSON events, and trade CSV."""
    output.mkdir(parents=True, exist_ok=False)
    summary = {key: value for key, value in result.items() if key != "events"}
    (output / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    events = result["events"]
    with (output / "events.ndjson").open("x", encoding="utf-8") as handle:
        for event in events:
            handle.write(canonical_json(event) + "\n")
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
