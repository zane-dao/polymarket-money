"""Authoritative catalog for the Python strategies already present in this repository.

This module is intentionally free of network, storage and order-side effects.  During the
incremental directory migration it exposes the reviewed implementations in ``research`` through
one stable strategy boundary.  Paper orchestration remains outside this package.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from decimal import Decimal
from hashlib import sha256
import json
from pathlib import Path
from typing import Any, Callable

from .baselines import (
    action_from_probability,
    market_probability,
    no_trade_probability,
)
from research.polymarket_money.historical_study import (
    OffsetLogisticModel,
    _aggregate,
    _prediction,
    gbm_proxy_probability,
    probability_metrics,
    simulate_trade,
)
from research.polymarket_money.historical_adapter import canonical_json
from .kj_l import (
    AdaptiveStrategy,
    KJConfig,
    KJStrategy,
    LAdaptiveConfig,
    LAdaptiveV2Config,
    PaperScenario,
    l_adaptive_v2_midrange_train_selected_config,
    run_kj_paper,
    simulate_decision,
    simulate_l_adaptive_decision,
)


@dataclass(frozen=True, slots=True)
class StrategyDescriptor:
    strategy_id: str
    family: str
    version: str
    status: str
    implementation: Callable[..., object]
    workbench_backtest: Callable[..., tuple[dict[str, Any], str]] | None = None


def _decimal(parameters: dict[str, Any], name: str, default: Decimal) -> Decimal:
    value = parameters.get(name)
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ValueError(f"{name} must be numeric")
    result = Decimal(str(value))
    if not result.is_finite():
        raise ValueError(f"{name} must be finite")
    return result


def _kj_workbench_runner(strategy: KJStrategy) -> Callable[..., tuple[dict[str, Any], str]]:
    def run(receipt: object, rows: object, parameters: dict[str, Any], initial_cash: Decimal,
            max_position: Decimal, evaluation_split: str | None = None) -> tuple[dict[str, Any], str]:
        common = KJConfig()
        config = KJConfig(
            edge_threshold=_decimal(parameters, "edgeThreshold", common.edge_threshold),
            max_edge=_decimal(parameters, "maxEdge", common.max_edge),
            max_stake_abs_usdc=min(_decimal(parameters, "maxStakeUsdc", common.max_stake_abs_usdc), max_position),
            book_participation=_decimal(parameters, "bookParticipation", common.book_participation),
        )
        split = evaluation_split or "FINAL_TEST"
        if split not in {"VALIDATION", "FINAL_TEST"}:
            raise ValueError("J/K workbench evaluation split is invalid")
        result = run_kj_paper(receipt, rows, strategies=(strategy,), split=split,
                              horizon_seconds=30, scenario=PaperScenario.BASE_1S,
                              initial_cash=initial_cash, config=config)
        return result, strategy.value
    return run


def _l_v2_workbench_runner(receipt: object, rows: object, parameters: dict[str, Any],
                           initial_cash: Decimal, max_position: Decimal,
                           evaluation_split: str | None = None) -> tuple[dict[str, Any], str]:
    common = KJConfig()
    selected = l_adaptive_v2_midrange_train_selected_config()
    adaptive = replace(
        selected,
        max_stake_abs_usdc=min(_decimal(parameters, "maxStakeUsdc", common.max_stake_abs_usdc), max_position),
        book_participation=_decimal(parameters, "bookParticipation", common.book_participation),
        max_signal_edge=_decimal(parameters, "maxSignalEdge", selected.max_signal_edge),
    )
    split = evaluation_split or "VALIDATION"
    if split != "VALIDATION":
        raise ValueError("L V2 workbench evaluation is restricted to VALIDATION")
    result = run_kj_paper(receipt, rows, strategies=(AdaptiveStrategy.L_ADAPTIVE_EXECUTION,),
                          split=split, horizon_seconds=30,
                          scenario=PaperScenario.BASE_1S, initial_cash=initial_cash,
                          adaptive_config=adaptive)
    return result, AdaptiveStrategy.L_ADAPTIVE_EXECUTION.value


def _baseline_workbench_runner(model: str) -> Callable[..., tuple[dict[str, Any], str]]:
    """Expose each frozen research baseline through the same workbench result boundary."""
    def run(receipt: object, rows: object, _parameters: dict[str, Any], initial_cash: Decimal,
            _max_position: Decimal, evaluation_split: str | None = None) -> tuple[dict[str, Any], str]:
        if not hasattr(receipt, "manifest") or receipt.manifest["audit"]["gate"]["passed"] is not True:
            raise ValueError("historical dataset gate did not pass")
        split = evaluation_split or "VALIDATION"
        if split not in {"VALIDATION", "FINAL_TEST"}:
            raise ValueError("baseline workbench evaluation split is invalid")
        source = tuple(rows) if not isinstance(rows, tuple) else rows
        train = [row for row in source if row["split"] == "TRAIN" and int(row["horizon_seconds"]) == 30]
        selected = sorted((row for row in source if row["split"] == split and int(row["horizon_seconds"]) == 30), key=lambda row: (row["decision_time"], row["condition_id"]))
        if not selected:
            raise ValueError("no rows match split and horizon")
        config: dict[str, Any] = {"threshold": "0.00"}
        if model == "B2_GBM_BINANCE_PROXY":
            config["volatility_window_seconds"] = 60
        elif model == "B3_MARKET_PRIOR_LOGISTIC":
            config.update(OffsetLogisticModel.fit(train).to_mapping())
        probabilities = [_prediction(model, row, config) for row in selected]
        trades = [(row, simulate_trade(row, probability=probability, threshold=Decimal("0"), execution_scenario="BASE_1S", fee_scenario="OFFICIAL_MARKET_STATIC")) for row, probability in zip(selected, probabilities)]
        aggregate = _aggregate(trades)
        labels = [1 if row["winner"] == "Up" else 0 for row in selected]
        brier = None if model == "B0_NO_TRADE" else format(Decimal(str(probability_metrics([float(value) for value in probabilities], labels)["brier_score"])), "f")
        events: list[dict[str, Any]] = []
        bankroll = initial_cash
        for row, probability, trade in zip(selected, probabilities, (item[1] for item in trades)):
            bankroll += trade["net_pnl"]
            event = {"strategy": model, "market_id": str(row["condition_id"]), "decision_time": str(row["decision_time"]), "settlement_evidence_time": str(row["fee_evidence"]["fetch_time"]), "status": trade["status"], "reason": "FROZEN_BASELINE", "probability_up": None if probability is None else format(Decimal(str(probability)), "f"), "winner": str(row["winner"]), "net_pnl": format(trade["net_pnl"], "f"), "bankroll_after": format(bankroll, "f")}
            if trade["filled_quantity"] > 0:
                side = "UP" if trade["action"] == "BUY_UP" else "DOWN"
                event.update({"status": "FILLED", "side": side, "decision_ask": format(trade["fill_price"], "f"), "fill_price": format(trade["fill_price"], "f"), "intended_quantity": format(trade["filled_quantity"], "f"), "quantity": format(trade["filled_quantity"], "f"), "fee": format(trade["fee"], "f"), "payout": format(trade["gross_pnl"] + trade["fill_price"] * trade["filled_quantity"], "f"), "fill_time": str(row["decision_time"])})
            events.append(event)
        filled = int(aggregate["filled_count"]) + int(aggregate["partial_fill_count"])
        wins = sum(1 for _, trade in trades if trade["filled_quantity"] > 0 and trade["gross_pnl"] > 0)
        cohort_hash = sha256(canonical_json([{"condition_id": str(row["condition_id"]), "decision_time": str(row["decision_time"]), "horizon_seconds": int(row["horizon_seconds"])} for row in selected]).encode("utf-8")).hexdigest()
        summary = {"decision_count": len(selected), "filled_count": filled, "net_pnl": aggregate["scenario_net_pnl"], "fees": aggregate["fees"], "max_drawdown": aggregate["max_drawdown"], "win_rate": format(Decimal(wins) / Decimal(filled), "f") if filled else None, "brier_score": brier}
        return {"split": split, "horizon_seconds": 30, "scenario": "BASE_1S", "cohort_hash": cohort_hash, "cohort_size": len(selected), "runs": {model: summary}, "events": events}, model
    return run


_EXECUTORS: dict[str, tuple[Callable[..., object], Callable[..., tuple[dict[str, Any], str]] | None]] = {
    "B0_NO_TRADE": (no_trade_probability, _baseline_workbench_runner("B0_NO_TRADE")),
    "B1_MARKET_PROBABILITY": (market_probability, _baseline_workbench_runner("B1_MARKET_PROBABILITY")),
    "B2_GBM_BINANCE_PROXY": (gbm_proxy_probability, _baseline_workbench_runner("B2_GBM_BINANCE_PROXY")),
    "B3_MARKET_PRIOR_LOGISTIC": (OffsetLogisticModel, _baseline_workbench_runner("B3_MARKET_PRIOR_LOGISTIC")),
    "KJ_J": (simulate_decision, _kj_workbench_runner(KJStrategy.J_FEE_AWARE)),
    "KJ_K": (simulate_decision, _kj_workbench_runner(KJStrategy.K_DUAL_VOL)),
    "L_V1": (simulate_l_adaptive_decision, None),
    "L_V2": (simulate_l_adaptive_decision, _l_v2_workbench_runner),
}


def _load_catalog() -> dict[str, StrategyDescriptor]:
    """Build the Python execution view from the shared reviewed catalog."""
    source = json.loads((Path(__file__).parents[2] / "catalog.json").read_text(encoding="utf-8"))
    if source.get("schemaVersion") != "strategy-catalog-v1":
        raise ValueError("unsupported strategy catalog")
    result: dict[str, StrategyDescriptor] = {}
    for item in source.get("strategies", []):
        executor = _EXECUTORS.get(item.get("executor"))
        if executor is None:
            raise ValueError(f"unknown strategy executor: {item.get('executor')}")
        strategy_id = str(item["strategyId"])
        result[strategy_id] = StrategyDescriptor(
            strategy_id=strategy_id,
            family=str(item["family"]),
            version=str(item["implementationVersion"]),
            status=str(item["executionStatus"]),
            implementation=executor[0],
            workbench_backtest=executor[1],
        )
    return result


STRATEGY_CATALOG = _load_catalog()


def resolve_strategy(strategy_id: str) -> StrategyDescriptor:
    """Return one registered strategy or fail closed for an unknown identifier."""
    try:
        return STRATEGY_CATALOG[strategy_id]
    except KeyError as exc:
        raise ValueError(f"unknown strategy: {strategy_id}") from exc


def run_registered_workbench_backtest(strategy_id: str, receipt: object, rows: object,
                                      parameters: dict[str, Any], initial_cash: Decimal,
                                      max_position: Decimal,
                                      evaluation_split: str | None = None) -> tuple[dict[str, Any], str]:
    """Run a reviewed registry adapter; never import or execute user-provided code."""
    descriptor = resolve_strategy(strategy_id)
    if descriptor.workbench_backtest is None:
        raise ValueError(f"strategy has no offline workbench runner: {strategy_id}")
    return descriptor.workbench_backtest(receipt, rows, parameters, initial_cash, max_position, evaluation_split)


__all__ = [
    "KJConfig",
    "LAdaptiveConfig",
    "LAdaptiveV2Config",
    "STRATEGY_CATALOG",
    "StrategyDescriptor",
    "action_from_probability",
    "resolve_strategy",
    "run_registered_workbench_backtest",
]
