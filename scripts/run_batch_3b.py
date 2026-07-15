#!/usr/bin/env python3
"""Build and run the pre-registered Batch 3B study from cached, public, read-only inputs."""

from __future__ import annotations

import argparse
from hashlib import sha256
import json
from pathlib import Path
import subprocess

from research.polymarket_money.historical import HistoricalSourceContract
from research.polymarket_money.historical_adapter import (
    ExternalHistoricalDatasetAdapter,
    canonical_json,
)
from research.polymarket_money.historical_study import run_preregistered_study


REVISION = "42d917dc8e3205dde8ac909792af0cce2d715c9f"
MARKETS_SHA256 = "8e0ed78021bd98d3dba18829266103ebd9b46a77f6ba872a1c7f98be77b506bd"
TICKS_SHA256 = "173760b951ac0a2c795e1c3873a506e2fd4372db356dd3515f06582820ff975e"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    data_root = args.data_root.resolve()
    repo_root = args.repo_root.resolve()
    if data_root == repo_root or repo_root in data_root.parents:
        raise SystemExit("POLY_DATA_ROOT must remain outside the Git repository")
    status = subprocess.run(
        ["git", "status", "--porcelain"], cwd=repo_root, check=True, capture_output=True, text=True
    ).stdout
    if status:
        raise SystemExit("Batch 3B normalized build requires a clean worktree")
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo_root, check=True, capture_output=True, text=True
    ).stdout.strip()
    hf = data_root / "external/huggingface/kachoio-polymarket-5m" / f"revision={REVISION}"
    source = HistoricalSourceContract.required(
        revision=REVISION,
        markets_sha256=MARKETS_SHA256,
        ticks_sha256=TICKS_SHA256,
    )
    adapter = ExternalHistoricalDatasetAdapter(source)
    version, audit = adapter.build(
        markets_path=hf / "btc_markets.parquet",
        ticks_path=hf / "btc_ticks.parquet",
        gamma_directory=data_root / "external/polymarket/gamma/primary-v2-events-daily",
        binance_directory=data_root / "external/binance/BTCUSDT/1s",
        output_root=data_root / "external-research",
        build_commit=commit,
    )
    receipt, rows = adapter.load(version)
    result = run_preregistered_study(receipt, rows)
    result_bytes = (canonical_json(result) + "\n").encode("utf-8")
    experiment_hash = sha256(result_bytes).hexdigest()
    experiment = (
        data_root
        / "external-research/research-runs"
        / f"experiment={result['frozen_config_hash'] if result.get('frozen_config_hash') else experiment_hash}"
    )
    experiment.mkdir(parents=True, exist_ok=False)
    (experiment / "result.json").write_bytes(result_bytes)
    audit_summary = audit.to_mapping()
    audit_summary["excluded_market_count"] = len(audit_summary.pop("excluded_markets"))
    summary = {
        "normalized_version": str(version),
        "dataset_hash": receipt.dataset_hash,
        "audit": audit_summary,
        "experiment_directory": str(experiment),
        "result_sha256": sha256(result_bytes).hexdigest(),
        "conclusion": result["conclusion"],
    }
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
