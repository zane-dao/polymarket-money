"""Run a bounded, offline L V2 parameter sweep on one verified dataset publication."""

from __future__ import annotations

import argparse
import json
from dataclasses import replace
from decimal import Decimal
from itertools import product
from pathlib import Path

from research.polymarket_money.historical_adapter import ExternalHistoricalDatasetAdapter
from strategies.src.python.kj_l import (
    AdaptiveStrategy,
    PaperScenario,
    l_adaptive_v2_midrange_train_selected_config,
    run_kj_paper,
)


def decimal_list(value: str) -> tuple[Decimal, ...]:
    return tuple(Decimal(item) for item in value.split(","))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--max-signal-edge", default="0.10,0.15,0.20,0.25,0.30,0.35,0.50")
    parser.add_argument("--max-stake-usdc", default="50,100,150,200,300,400")
    parser.add_argument("--book-participation", default="0.10,0.25,0.40,0.50,0.75,1.00")
    args = parser.parse_args()
    receipt, rows = ExternalHistoricalDatasetAdapter.load(args.dataset)
    selected = l_adaptive_v2_midrange_train_selected_config()
    results: list[dict[str, object]] = []
    for edge, stake, participation in product(
        decimal_list(args.max_signal_edge),
        decimal_list(args.max_stake_usdc),
        decimal_list(args.book_participation),
    ):
        config = replace(
            selected,
            max_signal_edge=edge,
            max_stake_abs_usdc=stake,
            book_participation=participation,
        )
        metrics_by_split: dict[str, object] = {}
        for split in ("TRAIN", "VALIDATION"):
            artifact = run_kj_paper(
                receipt,
                rows,
                strategies=(AdaptiveStrategy.L_ADAPTIVE_EXECUTION,),
                split=split,
                horizon_seconds=30,
                scenario=PaperScenario.BASE_1S,
                initial_cash=Decimal("10000"),
                adaptive_config=config,
            )
            metrics_by_split[split.lower()] = artifact["runs"][AdaptiveStrategy.L_ADAPTIVE_EXECUTION.value]
        results.append(
            {
                "parameters": {
                    "maxSignalEdge": format(edge, "f"),
                    "maxStakeUsdc": format(stake, "f"),
                    "bookParticipation": format(participation, "f"),
                },
                "metrics": metrics_by_split,
            }
        )
    results.sort(
        key=lambda item: (
            Decimal(str(item["metrics"]["train"]["net_pnl"])),
            -Decimal(str(item["metrics"]["train"]["max_drawdown"])),
            -Decimal(str(item["metrics"]["train"]["brier_score"])),
        ),
        reverse=True,
    )
    print(
        json.dumps(
            {
                "schemaVersion": "l-parameter-sweep-v1",
                "datasetHash": receipt.dataset_hash,
                "selectionSplit": "TRAIN",
                "holdoutSplit": "VALIDATION",
                "scenario": PaperScenario.BASE_1S.value,
                "initialCash": "10000",
                "candidateCount": len(results),
                "results": results,
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
