"""Fixed offline workbench backtest adapter. It never performs network I/O or trading."""

from __future__ import annotations

from decimal import Decimal
import json
from pathlib import Path
import sys
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from research.polymarket_money.historical_adapter import ExternalHistoricalDatasetAdapter
from strategies.src.python.registry import run_registered_workbench_backtest


def _public_payload(event: dict[str, Any], kind: str, base: str) -> dict[str, str | int | float | bool | None]:
    """Map the Python research record into the public backend event contract.

    Keeping this mapping explicit prevents renderer-facing queries from depending
    on private snake_case research fields or accidentally exposing new fields.
    """
    common: dict[str, str | int | float | bool | None] = {
        "marketId": event.get("market_id"),
        "direction": event.get("side"),
        "status": event.get("status"),
    }
    if kind == "decision":
        status = event.get("status")
        return {**common, "decisionId": f"decision-{base}",
                "action": "BUY" if status == "FILLED" else "SKIP" if status == "UNFILLED" else "HOLD",
                "reason": event.get("reason"), "probability": event.get("probability_up"),
                "price": event.get("decision_ask"), "decisionAsk": event.get("decision_ask"),
                "executablePrice": event.get("fill_price"), "edge": event.get("edge"),
                "netEdge": event.get("net_edge"), "requiredEdge": event.get("required_edge"),
                "feeRate": event.get("fee_rate"), "estimatedFee": event.get("intended_fee"),
                "intendedQuantity": event.get("intended_quantity"),
                "intendedStake": event.get("intended_stake"),
                "targetPositionQuantity": event.get("target_position_quantity"),
                "currentPositionQuantity": event.get("position_before"),
                "openOrderQuantity": event.get("open_order_quantity"),
                "approvedOrderQuantity": event.get("intended_quantity"),
                "riskStatus": event.get("risk_status"),
                "riskReasonCodes": event.get("risk_reason_codes"),
                "visibleAskQuantity": event.get("visible_ask_size"),
                "decisionVisibleAskQuantity": event.get("decision_visible_ask_size"),
                "bookParticipation": event.get("book_participation"),
                "outcome": event.get("winner"), "pnl": event.get("net_pnl")}
    if kind == "order":
        return {**common, "orderId": event.get("intent_id") or f"order-{base}",
                "decisionId": f"decision-{base}", "side": "BUY",
                "price": event.get("decision_ask"), "quantity": event.get("intended_quantity"),
                "timeInForce": "FAK", "expiresAtUtc": event.get("fill_time")}
    if kind == "fill":
        return {**common, "fillId": event.get("fill_id") or f"fill-{base}",
                "orderId": event.get("intent_id") or f"order-{base}", "side": "BUY",
                "price": event.get("fill_price"), "quantity": event.get("quantity"),
                "fee": event.get("fee")}
    return {**common, "settlementId": event.get("settlement_id") or f"settlement-{base}",
            "outcome": event.get("winner"), "quantity": event.get("quantity"),
            "payout": event.get("payout"), "fee": event.get("fee"),
            "pnl": event.get("net_pnl")}


def build_public_events(source_events: list[dict[str, Any]], run_id: str, initial_cash: Decimal) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    events: list[dict[str, Any]] = []
    equity = [{"timeUtc": source_events[0]["decision_time"], "equity": str(initial_cash)}] if source_events else []
    current_equity = str(initial_cash)
    for ordinal, event in enumerate(source_events, 1):
        base = f"{run_id}-{ordinal}"
        events.append({"eventId": f"decision-{base}", "eventTimeUtc": event["decision_time"], "kind": "decision", "payload": _public_payload(event, "decision", base)})
        if event["status"] in {"FILLED", "UNFILLED"} and "intended_quantity" in event:
            events.append({"eventId": f"order-{base}", "eventTimeUtc": event["decision_time"], "kind": "order", "payload": _public_payload(event, "order", base)})
        if event["status"] == "FILLED":
            events.append({"eventId": f"fill-{base}", "eventTimeUtc": event["fill_time"], "kind": "fill", "payload": _public_payload(event, "fill", base)})
            events.append({"eventId": f"settlement-{base}", "eventTimeUtc": event["settlement_evidence_time"], "kind": "settlement", "payload": _public_payload(event, "settlement", base)})
            current_equity = str(event["bankroll_after"])
            equity.append({"timeUtc": event["settlement_evidence_time"], "equity": current_equity})
        else:
            # NO_TRADE is still an observed account state. Keeping the unchanged balance on the
            # common decision timeline makes the cash baseline a real horizontal comparison line.
            current_equity = str(event.get("bankroll_after", current_equity))
            equity.append({"timeUtc": event["decision_time"], "equity": current_equity})
    return events, equity


def run(input_value: dict[str, Any]) -> dict[str, Any]:
    dataset_path = Path(input_value["datasetPath"]).resolve(strict=True)
    receipt, rows = ExternalHistoricalDatasetAdapter.load(dataset_path)
    if receipt.dataset_hash != input_value["datasetVersionHash"]:
        raise ValueError("dataset hash mismatch")
    strategy_id = input_value["strategyId"]
    parameters = input_value["parameters"]
    initial_cash = Decimal(input_value["initialCash"])
    result, result_strategy_id = run_registered_workbench_backtest(
        strategy_id, receipt, rows, parameters, initial_cash, Decimal(input_value["maxPosition"]),
        input_value["request"].get("evaluationSplit"),
    )
    summary = result["runs"][result_strategy_id]
    source_events = [event for event in result["events"] if event["strategy"] == result_strategy_id]
    events, equity = build_public_events(source_events, input_value["runId"], initial_cash)
    decision_count = summary["decision_count"]
    fill_rate = Decimal(summary["filled_count"]) / Decimal(decision_count) if decision_count else Decimal(0)
    return {
        "schemaVersion": "backtest-result-v1", "runId": input_value["runId"], "request": input_value["request"],
        "startedAtUtc": input_value["startedAtUtc"], "completedAtUtc": input_value["completedAtUtc"],
        "evaluationScope": {"schemaVersion": "backtest-evaluation-scope-v1", "split": result["split"],
                            "horizonSeconds": result["horizon_seconds"], "scenario": result["scenario"],
                            "cohortHash": result["cohort_hash"], "cohortSize": result["cohort_size"]},
        "metrics": {"netPnl": summary["net_pnl"], "fees": summary["fees"], "maxDrawdown": summary["max_drawdown"], "fillRate": format(fill_rate, "f"), "winRate": summary["win_rate"], "brier": summary["brier_score"]},
        "equityCurve": equity, "events": events,
    }


if __name__ == "__main__":
    request = json.load(sys.stdin)
    print(json.dumps(run(request), separators=(",", ":"), sort_keys=True))
