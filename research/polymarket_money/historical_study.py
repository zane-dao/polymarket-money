"""Pre-registered, deterministic Batch 3B baseline study over verified normalized samples."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from hashlib import sha256
import math
import random
from statistics import mean, pstdev
from typing import Any, Mapping, Sequence

from .baseline_research import action_from_probability
from .historical_adapter import HistoricalDatasetReceipt, canonical_json


MODELS = ("B0_NO_TRADE", "B1_MARKET_PROBABILITY", "B2_GBM_BINANCE_PROXY", "B3_MARKET_PRIOR_LOGISTIC")
HORIZONS = (60, 30, 15)
THRESHOLDS = (Decimal("0.00"), Decimal("0.01"), Decimal("0.02"))
EXECUTION_SCENARIOS = ("DEBUG_0S", "BASE_1S", "CONSERVATIVE_2S", "STRESS_1S_PLUS_TICK")
FEE_SCENARIOS = ("OFFICIAL_MARKET_STATIC", "CONSERVATIVE_0_0625", "CONSERVATIVE_0_07")
FEATURE_NAMES = (
    "binance_log_return",
    "realized_vol_30s",
    "realized_vol_60s",
    "realized_vol_120s",
    "remaining_seconds",
    "up_spread",
    "down_spread",
    "up_best_ask_size",
    "down_best_ask_size",
    "up_top_imbalance",
    "market_midpoint",
)


def _d(value: Any) -> Decimal:
    if value is None:
        raise ValueError("required Decimal source value is missing")
    return Decimal(str(value))


def _book(row: Mapping[str, Any]) -> Mapping[str, Any]:
    book = row["books"]["decision_plus_1s_visibility"]
    if not isinstance(book, dict):
        raise ValueError("headline decision book is missing")
    return book


def market_probability_float(row: Mapping[str, Any]) -> float:
    book = _book(row)
    return (float(book["bu"]) + float(book["au"])) / 2.0


def feature_vector(row: Mapping[str, Any]) -> tuple[float, ...]:
    book = _book(row)
    bu, au = float(book["bu"]), float(book["au"])
    bd, ad = float(book["bd"]), float(book["ad"])
    su = float(book["su"]) if book["su"] is not None else 0.0
    sau = float(book["sau"]) if book["sau"] is not None else 0.0
    sad = float(book["sad"]) if book["sad"] is not None else 0.0
    imbalance = (su - sau) / (su + sau) if su + sau else 0.0
    return (
        float(row["binance"]["log_return_from_start"]),
        float(row["binance"]["realized_vol_30s"]),
        float(row["binance"]["realized_vol_60s"]),
        float(row["binance"]["realized_vol_120s"]),
        float(row["horizon_seconds"]),
        au - bu,
        ad - bd,
        math.log1p(sau),
        math.log1p(sad),
        imbalance,
        (bu + au) / 2.0,
    )


def _sigmoid(value: float) -> float:
    if value >= 0:
        z = math.exp(-value)
        return 1.0 / (1.0 + z)
    z = math.exp(value)
    return z / (1.0 + z)


def _logit(value: float) -> float:
    clipped = min(max(value, 1e-6), 1 - 1e-6)
    return math.log(clipped / (1 - clipped))


@dataclass(frozen=True, slots=True)
class OffsetLogisticModel:
    means: tuple[float, ...]
    scales: tuple[float, ...]
    weights: tuple[float, ...]

    @classmethod
    def fit(cls, rows: Sequence[Mapping[str, Any]]) -> "OffsetLogisticModel":
        if not rows:
            raise ValueError("logistic training requires non-empty Train rows")
        vectors = [feature_vector(row) for row in rows]
        columns = tuple(zip(*vectors))
        means = tuple(mean(column) for column in columns)
        scales = tuple(pstdev(column) or 1.0 for column in columns)
        standardized = [
            tuple((value - means[index]) / scales[index] for index, value in enumerate(vector))
            for vector in vectors
        ]
        labels = [1.0 if row["winner"] == "Up" else 0.0 for row in rows]
        offsets = [_logit(market_probability_float(row)) for row in rows]
        weights = [0.0] * len(FEATURE_NAMES)
        learning_rate = 0.08
        l2 = 0.01
        for _ in range(350):
            gradients = [0.0] * len(weights)
            for vector, label, offset in zip(standardized, labels, offsets):
                probability = _sigmoid(offset + sum(w * x for w, x in zip(weights, vector)))
                error = probability - label
                for index, value in enumerate(vector):
                    gradients[index] += error * value
            count = len(rows)
            for index in range(len(weights)):
                gradient = gradients[index] / count + l2 * weights[index]
                weights[index] -= learning_rate * gradient
        return cls(means, scales, tuple(weights))

    def predict(self, row: Mapping[str, Any]) -> float:
        vector = feature_vector(row)
        standardized = tuple(
            (value - self.means[index]) / self.scales[index]
            for index, value in enumerate(vector)
        )
        return _sigmoid(
            _logit(market_probability_float(row))
            + sum(weight * value for weight, value in zip(self.weights, standardized))
        )

    def to_mapping(self) -> dict[str, Any]:
        return {
            "feature_names": list(FEATURE_NAMES),
            "means": list(self.means),
            "scales": list(self.scales),
            "weights": list(self.weights),
            "optimizer": {"iterations": 350, "learning_rate": 0.08, "l2": 0.01},
            "market_logit_offset": True,
        }


def gbm_proxy_probability(row: Mapping[str, Any], volatility_window: int) -> float:
    current = float(row["binance"]["current_price"])
    start = float(row["binance"]["start_price"])
    sigma = float(row["binance"][f"realized_vol_{volatility_window}s"])
    remaining = float(row["horizon_seconds"])
    if sigma <= 0:
        return 1.0 if current >= start else 0.0
    denominator = sigma * math.sqrt(remaining)
    score = (math.log(current / start) - 0.5 * sigma * sigma * remaining) / denominator
    return 0.5 * (1.0 + math.erf(score / math.sqrt(2.0)))


def probability_metrics(probabilities: Sequence[float], labels: Sequence[int]) -> dict[str, Any]:
    if not probabilities or len(probabilities) != len(labels):
        raise ValueError("probability metrics require aligned non-empty inputs")
    brier = sum((p - y) ** 2 for p, y in zip(probabilities, labels)) / len(labels)
    loss = -sum(
        y * math.log(min(max(p, 1e-15), 1 - 1e-15))
        + (1 - y) * math.log(1 - min(max(p, 1e-15), 1 - 1e-15))
        for p, y in zip(probabilities, labels)
    ) / len(labels)
    bins: list[dict[str, Any]] = []
    for index in range(10):
        selected = [
            (p, y)
            for p, y in zip(probabilities, labels)
            if index / 10 <= p < (index + 1) / 10 or (index == 9 and p == 1)
        ]
        bins.append(
            {
                "lower": index / 10,
                "upper": (index + 1) / 10,
                "count": len(selected),
                "mean_probability": mean(p for p, _ in selected) if selected else None,
                "hit_rate": mean(y for _, y in selected) if selected else None,
            }
        )
    return {"count": len(labels), "brier_score": brier, "log_loss": loss, "calibration": bins}


def _prediction(model: str, row: Mapping[str, Any], config: Mapping[str, Any]) -> float | None:
    if model == "B0_NO_TRADE":
        return None
    if model == "B1_MARKET_PROBABILITY":
        return market_probability_float(row)
    if model == "B2_GBM_BINANCE_PROXY":
        return gbm_proxy_probability(row, int(config["volatility_window_seconds"]))
    if model == "B3_MARKET_PRIOR_LOGISTIC":
        logistic = OffsetLogisticModel(
            tuple(config["means"]), tuple(config["scales"]), tuple(config["weights"])
        )
        return logistic.predict(row)
    raise ValueError(f"unknown baseline: {model}")


def _fee_rate(row: Mapping[str, Any], fee_scenario: str) -> Decimal:
    if fee_scenario == "CONSERVATIVE_0_0625":
        return Decimal("0.0625")
    if fee_scenario == "CONSERVATIVE_0_07":
        return Decimal("0.07")
    evidence = row["fee_evidence"]
    if evidence["grade"] not in {"POINT_IN_TIME_OFFICIAL", "MARKET_STATIC_OFFICIAL"}:
        raise ValueError("headline fee evidence is not verifiable")
    return _d(evidence["fee_rate"])


def _execution_book(row: Mapping[str, Any], scenario: str) -> Mapping[str, Any] | None:
    key = {
        "DEBUG_0S": "execution_debug_0s",
        "BASE_1S": "execution_base_1s",
        "CONSERVATIVE_2S": "execution_conservative_2s",
        "STRESS_1S_PLUS_TICK": "execution_base_1s",
    }[scenario]
    value = row["books"].get(key)
    return value if isinstance(value, dict) else None


def simulate_trade(
    row: Mapping[str, Any],
    *,
    probability: float | None,
    threshold: Decimal,
    execution_scenario: str,
    fee_scenario: str,
) -> dict[str, Any]:
    if probability is None:
        return {"action": "NO_TRADE", "filled_quantity": Decimal("0"), "gross_pnl": Decimal("0"), "fee": Decimal("0"), "net_pnl": Decimal("0"), "status": "NO_TRADE"}
    decision = _book(row)
    decision_up = _d(decision["au"])
    decision_down = _d(decision["ad"])
    decision_rate = _fee_rate(row, fee_scenario)
    action = action_from_probability(
        p_up=Decimal(str(probability)),
        ask_up=decision_up,
        ask_down=decision_down,
        fee_up=decision_rate * decision_up * (1 - decision_up),
        fee_down=decision_rate * decision_down * (1 - decision_down),
        threshold=threshold,
    )
    if action.direction == "NO_TRADE":
        return {"action": "NO_TRADE", "filled_quantity": Decimal("0"), "gross_pnl": Decimal("0"), "fee": Decimal("0"), "net_pnl": Decimal("0"), "status": "NO_TRADE"}
    book = _execution_book(row, execution_scenario)
    if book is None:
        return {"action": action.direction, "filled_quantity": Decimal("0"), "gross_pnl": Decimal("0"), "fee": Decimal("0"), "net_pnl": Decimal("0"), "status": "UNFILLED_NO_SAMPLE"}
    suffix = "u" if action.direction == "BUY_UP" else "d"
    ask = _d(book[f"a{suffix}"])
    size_value = book[f"sa{suffix}"]
    if size_value is None:
        return {"action": action.direction, "filled_quantity": Decimal("0"), "gross_pnl": Decimal("0"), "fee": Decimal("0"), "net_pnl": Decimal("0"), "status": "UNFILLED_NO_ASK_SIZE"}
    if execution_scenario == "STRESS_1S_PLUS_TICK":
        ask += Decimal("0.01")
    if ask > 1:
        return {"action": action.direction, "filled_quantity": Decimal("0"), "gross_pnl": Decimal("0"), "fee": Decimal("0"), "net_pnl": Decimal("0"), "status": "UNFILLED_PRICE_RANGE"}
    quantity = min(Decimal("1"), _d(size_value))
    if quantity <= 0:
        return {"action": action.direction, "filled_quantity": Decimal("0"), "gross_pnl": Decimal("0"), "fee": Decimal("0"), "net_pnl": Decimal("0"), "status": "UNFILLED_NO_ASK_SIZE"}
    won = (action.direction == "BUY_UP" and row["winner"] == "Up") or (
        action.direction == "BUY_DOWN" and row["winner"] == "Down"
    )
    payout = quantity if won else Decimal("0")
    gross = payout - ask * quantity
    fee = _fee_rate(row, fee_scenario) * ask * (1 - ask) * quantity
    return {
        "action": action.direction,
        "filled_quantity": quantity,
        "fill_price": ask,
        "gross_pnl": gross,
        "fee": fee,
        "net_pnl": gross - fee,
        "status": "FILLED" if quantity == 1 else "PARTIAL_FILL",
    }


def _aggregate(trades: Sequence[tuple[Mapping[str, Any], Mapping[str, Any]]]) -> dict[str, Any]:
    decisions = len(trades)
    actual = [trade for _, trade in trades if trade["action"] != "NO_TRADE"]
    filled = [trade for trade in actual if trade["filled_quantity"] > 0]
    daily: dict[str, Decimal] = {}
    weekly: dict[str, Decimal] = {}
    pnl_sequence: list[Decimal] = []
    for row, trade in trades:
        day = row["market_start"][:10]
        daily[day] = daily.get(day, Decimal("0")) + trade["net_pnl"]
        iso = datetime.fromisoformat(row["market_start"].replace("Z", "+00:00")).isocalendar()
        week = f"{iso.year}-W{iso.week:02d}"
        weekly[week] = weekly.get(week, Decimal("0")) + trade["net_pnl"]
        if trade["filled_quantity"] > 0:
            pnl_sequence.append(trade["net_pnl"])
    gross = sum((trade["gross_pnl"] for trade in filled), Decimal("0"))
    fees = sum((trade["fee"] for trade in filled), Decimal("0"))
    net = sum((trade["net_pnl"] for trade in filled), Decimal("0"))
    equity = Decimal("0")
    peak = Decimal("0")
    max_drawdown = Decimal("0")
    longest_loss = current_loss = 0
    for value in pnl_sequence:
        equity += value
        peak = max(peak, equity)
        max_drawdown = max(max_drawdown, peak - equity)
        current_loss = current_loss + 1 if value < 0 else 0
        longest_loss = max(longest_loss, current_loss)
    ordered_days = sorted(daily.values(), reverse=True)
    best_three = sum(ordered_days[:3], Decimal("0"))
    without_best = net - best_three
    concentration = None if net == 0 else best_three / net
    rng = random.Random(20260716)
    days = sorted(daily)
    bootstrap: list[Decimal] = []
    if days:
        for _ in range(2_000):
            bootstrap.append(sum((daily[rng.choice(days)] for _ in days), Decimal("0")))
        bootstrap.sort()
        lower = bootstrap[int(0.025 * len(bootstrap))]
        upper = bootstrap[int(0.975 * len(bootstrap)) - 1]
    else:
        lower = upper = Decimal("0")
    return {
        "decision_count": decisions,
        "trade_count": len(actual),
        "no_trade_ratio": format(Decimal(decisions - len(actual)) / Decimal(decisions), "f") if decisions else None,
        "filled_count": sum(trade["status"] == "FILLED" for trade in actual),
        "partial_fill_count": sum(trade["status"] == "PARTIAL_FILL" for trade in actual),
        "unfilled_count": sum(str(trade["status"]).startswith("UNFILLED") for trade in actual),
        "gross_pnl": format(gross, "f"),
        "fees": format(fees, "f"),
        "scenario_net_pnl": format(net, "f"),
        "average_per_filled_trade": format(net / Decimal(len(filled)), "f") if filled else None,
        "max_drawdown": format(max_drawdown, "f"),
        "longest_consecutive_loss": longest_loss,
        "daily_pnl": {key: format(value, "f") for key, value in sorted(daily.items())},
        "weekly_pnl": {key: format(value, "f") for key, value in sorted(weekly.items())},
        "best_3_days_pnl": format(best_three, "f"),
        "best_3_days_share_of_total": format(concentration, "f") if concentration is not None else None,
        "net_without_best_3_days": format(without_best, "f"),
        "daily_block_bootstrap_95pct": [format(lower, "f"), format(upper, "f")],
        "bootstrap_repetitions": 2_000,
    }


def _quantile_boundaries(values: Sequence[float]) -> tuple[float, float]:
    ordered = sorted(values)
    if not ordered:
        raise ValueError("volatility segmentation requires Train values")
    return ordered[len(ordered) // 3], ordered[(2 * len(ordered)) // 3]


def _segment_summary(
    trades: Sequence[tuple[Mapping[str, Any], Mapping[str, Any]]],
    *,
    volatility_boundaries: tuple[float, float],
) -> dict[str, Any]:
    by_time: dict[str, list[tuple[Mapping[str, Any], Mapping[str, Any]]]] = {}
    by_volatility: dict[str, list[tuple[Mapping[str, Any], Mapping[str, Any]]]] = {}
    low, high = volatility_boundaries
    for item in trades:
        row, _ = item
        hour = int(row["market_start"][11:13])
        time_bucket = f"UTC_{(hour // 6) * 6:02d}_{(hour // 6) * 6 + 5:02d}"
        by_time.setdefault(time_bucket, []).append(item)
        volatility = float(row["binance"]["realized_vol_120s"])
        volatility_bucket = "LOW" if volatility <= low else "MID" if volatility <= high else "HIGH"
        by_volatility.setdefault(volatility_bucket, []).append(item)

    def summarize(groups: Mapping[str, Sequence[tuple[Mapping[str, Any], Mapping[str, Any]]]]) -> dict[str, Any]:
        output: dict[str, Any] = {}
        for key, values in sorted(groups.items()):
            aggregate = _aggregate(values)
            output[key] = {
                "decision_count": aggregate["decision_count"],
                "trade_count": aggregate["trade_count"],
                "scenario_net_pnl": aggregate["scenario_net_pnl"],
            }
        return output

    return {"utc_time_buckets": summarize(by_time), "volatility_buckets": summarize(by_volatility)}


def run_frozen_diagnostics(
    result: Mapping[str, Any], rows: Sequence[Mapping[str, Any]]
) -> dict[str, Any]:
    """Recompute fixed-config descriptive slices without tuning or changing the primary result."""
    if not result.get("models_trained") or "frozen_config" not in result:
        raise ValueError("frozen diagnostics require a completed primary study")
    frozen = result["frozen_config"]
    configs = frozen["configs"]
    by_split_horizon: dict[tuple[str, int], list[Mapping[str, Any]]] = {}
    for row in rows:
        by_split_horizon.setdefault((row["split"], int(row["horizon_seconds"])), []).append(row)

    output: dict[str, Any] = {}
    for horizon in HORIZONS:
        train_volatility = [
            float(row["binance"]["realized_vol_120s"])
            for row in by_split_horizon[("TRAIN", horizon)]
        ]
        boundaries = _quantile_boundaries(train_volatility)
        for split in ("TRAIN", "VALIDATION", "FINAL_TEST"):
            split_rows = by_split_horizon[(split, horizon)]
            for model in MODELS:
                key = f"{model}:{horizon}"
                config: Mapping[str, Any] = (
                    {"threshold": "0.00"} if model == "B0_NO_TRADE" else configs[key]
                )
                probabilities = [_prediction(model, row, config) for row in split_rows]
                for scenario in ("BASE_1S", "STRESS_1S_PLUS_TICK"):
                    trades = [
                        (
                            row,
                            simulate_trade(
                                row,
                                probability=probability,
                                threshold=Decimal(str(config.get("threshold", "0"))),
                                execution_scenario=scenario,
                                fee_scenario="OFFICIAL_MARKET_STATIC",
                            ),
                        )
                        for row, probability in zip(split_rows, probabilities)
                    ]
                    aggregate = _aggregate(trades)
                    output[f"{split}:{key}:{scenario}"] = {
                        "aggregate": aggregate,
                        "segments": _segment_summary(
                            trades, volatility_boundaries=boundaries
                        ),
                    }
    return {
        "dataset_hash": result["dataset_hash"],
        "frozen_config_hash": result["frozen_config_hash"],
        "purpose": "POST_RUN_FIXED_CONFIG_DIAGNOSTICS_NO_TUNING",
        "volatility_bucket_definition": "Train-only realized_vol_120s tertiles per horizon",
        "results": output,
    }


def _select_threshold(
    rows: Sequence[Mapping[str, Any]], model: str, config: Mapping[str, Any]
) -> Decimal:
    scored: list[tuple[Decimal, Decimal]] = []
    for threshold in THRESHOLDS:
        total = Decimal("0")
        for row in rows:
            trade = simulate_trade(
                row,
                probability=_prediction(model, row, config),
                threshold=threshold,
                execution_scenario="BASE_1S",
                fee_scenario="OFFICIAL_MARKET_STATIC",
            )
            total += trade["net_pnl"]
        scored.append((total, threshold))
    return max(scored, key=lambda item: (item[0], item[1]))[1]


def run_preregistered_study(
    receipt: HistoricalDatasetReceipt,
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    audit = receipt.manifest["audit"]
    if not audit["gate"]["passed"]:
        return {
            "conclusion": "DATA_INSUFFICIENT",
            "dataset_hash": receipt.dataset_hash,
            "gate": audit["gate"],
            "models_trained": False,
        }
    by_split_horizon: dict[tuple[str, int], list[Mapping[str, Any]]] = {}
    for row in rows:
        by_split_horizon.setdefault((row["split"], int(row["horizon_seconds"])), []).append(row)

    configs: dict[str, dict[str, Any]] = {}
    for horizon in HORIZONS:
        train = by_split_horizon[("TRAIN", horizon)]
        validation = by_split_horizon[("VALIDATION", horizon)]
        market_config: dict[str, Any] = {}
        market_config["threshold"] = format(
            _select_threshold(validation, "B1_MARKET_PROBABILITY", market_config), "f"
        )
        configs[f"B1_MARKET_PROBABILITY:{horizon}"] = market_config

        window_scores = []
        for window in (30, 60, 120):
            probabilities = [gbm_proxy_probability(row, window) for row in validation]
            labels = [1 if row["winner"] == "Up" else 0 for row in validation]
            window_scores.append((probability_metrics(probabilities, labels)["log_loss"], window))
        selected_window = min(window_scores, key=lambda item: (item[0], item[1]))[1]
        gbm_config: dict[str, Any] = {"volatility_window_seconds": selected_window, "drift": 0}
        gbm_config["threshold"] = format(
            _select_threshold(validation, "B2_GBM_BINANCE_PROXY", gbm_config), "f"
        )
        configs[f"B2_GBM_BINANCE_PROXY:{horizon}"] = gbm_config

        fitted = OffsetLogisticModel.fit(train)
        logistic_config = fitted.to_mapping()
        logistic_config["threshold"] = format(
            _select_threshold(validation, "B3_MARKET_PRIOR_LOGISTIC", logistic_config), "f"
        )
        configs[f"B3_MARKET_PRIOR_LOGISTIC:{horizon}"] = logistic_config

    frozen_config = {
        "dataset_hash": receipt.dataset_hash,
        "train": "[2026-04-29,2026-05-09)",
        "validation": "[2026-05-09,2026-05-14)",
        "final_test": "[2026-05-14,2026-05-19)",
        "horizons_seconds": list(HORIZONS),
        "threshold_candidates": [format(value, "f") for value in THRESHOLDS],
        "configs": configs,
    }
    config_hash = sha256(canonical_json(frozen_config).encode("utf-8")).hexdigest()

    probability_results: dict[str, Any] = {}
    execution_results: dict[str, Any] = {}
    market_metrics: dict[int, dict[str, Any]] = {}
    for horizon in HORIZONS:
        final = by_split_horizon[("FINAL_TEST", horizon)]
        labels = [1 if row["winner"] == "Up" else 0 for row in final]
        market_probs = [market_probability_float(row) for row in final]
        market_metrics[horizon] = probability_metrics(market_probs, labels)
        for model in MODELS:
            key = f"{model}:{horizon}"
            if model == "B0_NO_TRADE":
                probability_results[key] = {"status": "NOT_APPLICABLE_NO_PROBABILITY"}
                config: Mapping[str, Any] = {"threshold": "0.00"}
                probabilities: list[float | None] = [None] * len(final)
            else:
                config = configs[key]
                probabilities = [_prediction(model, row, config) for row in final]
                metrics = probability_metrics([float(value) for value in probabilities], labels)
                metrics["brier_delta_vs_market"] = metrics["brier_score"] - market_metrics[horizon]["brier_score"]
                metrics["log_loss_delta_vs_market"] = metrics["log_loss"] - market_metrics[horizon]["log_loss"]
                probability_results[key] = metrics
            threshold = Decimal(str(config.get("threshold", "0")))
            for scenario in EXECUTION_SCENARIOS:
                for fee_scenario in FEE_SCENARIOS:
                    trades = [
                        (
                            row,
                            simulate_trade(
                                row,
                                probability=probability,
                                threshold=threshold,
                                execution_scenario=scenario,
                                fee_scenario=fee_scenario,
                            ),
                        )
                        for row, probability in zip(final, probabilities)
                    ]
                    aggregate = _aggregate(trades)
                    aggregate["net_pnl_verified"] = fee_scenario == "OFFICIAL_MARKET_STATIC"
                    execution_results[f"{key}:{scenario}:{fee_scenario}"] = aggregate

    positive = False
    candidate = False
    for model in MODELS[1:]:
        for horizon in HORIZONS:
            prefix = f"{model}:{horizon}"
            base = execution_results[f"{prefix}:BASE_1S:OFFICIAL_MARKET_STATIC"]
            stress = execution_results[f"{prefix}:STRESS_1S_PLUS_TICK:OFFICIAL_MARKET_STATIC"]
            base_net = Decimal(base["scenario_net_pnl"])
            stress_net = Decimal(stress["scenario_net_pnl"])
            positive = positive or base_net > 0 or stress_net > 0
            base_lower = Decimal(base["daily_block_bootstrap_95pct"][0])
            stress_lower = Decimal(stress["daily_block_bootstrap_95pct"][0])
            not_concentrated = (
                Decimal(base["net_without_best_3_days"]) > 0
                and Decimal(stress["net_without_best_3_days"]) > 0
            )
            if base_net > 0 and stress_net > 0 and base_lower > 0 and stress_lower > 0 and not_concentrated:
                candidate = True
    conclusion = (
        "CANDIDATE_EDGE_REQUIRES_SHADOW_VALIDATION"
        if candidate
        else "WEAK_RESEARCH_SIGNAL"
        if positive
        else "NO_EVIDENCE_OF_EDGE"
    )
    return {
        "conclusion": conclusion,
        "dataset_hash": receipt.dataset_hash,
        "gate": audit["gate"],
        "models_trained": True,
        "frozen_config": frozen_config,
        "frozen_config_hash": config_hash,
        "probability_results": probability_results,
        "execution_results": execution_results,
        "disclaimer": "Results are conditional on third-party 1 Hz top-of-book samples with UNVERIFIED continuity.",
    }
