from __future__ import annotations

from datetime import datetime
from decimal import Decimal, ROUND_HALF_EVEN
import json
from pathlib import Path

from research.polymarket_money.backtest import (
    FeeEvidenceStatus,
    FeeModel,
    FeeRate,
    FeeSchedule,
    LiquidityRole,
)


FIXTURE = json.loads(
    (Path(__file__).parents[2] / "data/fixtures/batch-4b-r1/fee-edge-v1.json").read_text()
)


def test_python_fee_model_matches_cross_language_fixture() -> None:
    schedule = FIXTURE["schedule"]
    for item in FIXTURE["fee_cases"]:
        rate = Decimal(item.get("fee_rate", schedule["fee_rate"]))
        model = FeeModel(
            FeeSchedule(
                version="fee-edge-v1",
                historical_verified=True,
                rates=(
                    FeeRate(
                        market_id=schedule["market_id"],
                        condition_id=schedule["condition_id"],
                        liquidity_role=LiquidityRole(item["role"]),
                        effective_from=datetime.fromisoformat(schedule["effective_from"].replace("Z", "+00:00")),
                        effective_to=datetime.fromisoformat(schedule["effective_to"].replace("Z", "+00:00")),
                        rate=rate,
                        quantum=Decimal("0.00001"),
                        rounding=ROUND_HALF_EVEN,
                        evidence_reference=schedule["evidence_reference"],
                        evidence_status=FeeEvidenceStatus.VERIFIED,
                    ),
                ),
            )
        )
        result = model.charge(
            market_id=schedule["market_id"],
            condition_id=schedule["condition_id"],
            executable_time=datetime.fromisoformat("2026-07-16T12:00:00+00:00"),
            liquidity_role=LiquidityRole(item["role"]),
            price=Decimal(item["price"]),
            quantity=Decimal(item["quantity"]),
        )
        formatted = None
        if result.amount is not None:
            formatted = format(result.amount, "f").rstrip("0").rstrip(".") or "0"
        assert formatted == item["amount"]
        assert result.reason_code == item["reason"]
