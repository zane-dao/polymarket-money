"""Authoritative catalog for the Python strategies already present in this repository.

This module is intentionally free of network, storage and order-side effects.  During the
incremental directory migration it exposes the reviewed implementations in ``research`` through
one stable strategy boundary.  Paper orchestration remains outside this package.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from decimal import Decimal
from typing import Any, Callable

from .baselines import (
    action_from_probability,
    market_probability,
    no_trade_probability,
)
from research.polymarket_money.historical_study import (
    OffsetLogisticModel,
    gbm_proxy_probability,
)
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


STRATEGY_CATALOG: dict[str, StrategyDescriptor] = {
    "B0_NO_TRADE": StrategyDescriptor(
        "B0_NO_TRADE", "POLYMARKET_PAPER_BASELINE", "batch-3b-v1", "FROZEN_BASELINE",
        no_trade_probability,
    ),
    "B1_MARKET_PROBABILITY": StrategyDescriptor(
        "B1_MARKET_PROBABILITY", "POLYMARKET_PAPER_BASELINE", "batch-3b-v1",
        "FROZEN_BASELINE", market_probability,
    ),
    "B2_GBM_BINANCE_PROXY": StrategyDescriptor(
        "B2_GBM_BINANCE_PROXY", "POLYMARKET_PAPER_BASELINE", "batch-3b-v1",
        "FROZEN_BASELINE", gbm_proxy_probability,
    ),
    "B3_MARKET_PRIOR_LOGISTIC": StrategyDescriptor(
        "B3_MARKET_PRIOR_LOGISTIC", "POLYMARKET_PAPER_BASELINE", "batch-3b-v1",
        "FROZEN_BASELINE", OffsetLogisticModel,
    ),
    KJStrategy.J_FEE_AWARE.value: StrategyDescriptor(
        KJStrategy.J_FEE_AWARE.value, "POLYMARKET_PAPER_MAIN_RECONSTRUCTION", "kj-paper-v2",
        "FROZEN_RESEARCH", simulate_decision, _kj_workbench_runner(KJStrategy.J_FEE_AWARE),
    ),
    KJStrategy.K_DUAL_VOL.value: StrategyDescriptor(
        KJStrategy.K_DUAL_VOL.value, "POLYMARKET_PAPER_MAIN_RECONSTRUCTION", "kj-paper-v2",
        "FROZEN_RESEARCH", simulate_decision, _kj_workbench_runner(KJStrategy.K_DUAL_VOL),
    ),
    "L_ADAPTIVE_EXECUTION_V1": StrategyDescriptor(
        "L_ADAPTIVE_EXECUTION_V1", "L_ADAPTIVE_EXECUTION",
        LAdaptiveConfig().config_version, "RESEARCH_GATE_FAILED", simulate_l_adaptive_decision,
    ),
    "L_ADAPTIVE_EXECUTION_V2": StrategyDescriptor(
        "L_ADAPTIVE_EXECUTION_V2", "L_ADAPTIVE_EXECUTION",
        l_adaptive_v2_midrange_train_selected_config().config_version,
        "RESEARCH_ONLY_CANDIDATE", simulate_l_adaptive_decision, _l_v2_workbench_runner,
    ),
}


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
