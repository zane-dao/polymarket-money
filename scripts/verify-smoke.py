#!/usr/bin/env python3
"""Verify one bounded public smoke run without copying or printing raw payloads."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from research.polymarket_money.data_quality import (  # noqa: E402
    CONTINUITY_LIMITATION,
    build_verified_data_quality_report,
)
from research.polymarket_money.market_identity import (  # noqa: E402
    discover_btc_five_minute_market,
)
from research.polymarket_money.replay import ManifestVerifier, RawReplay  # noqa: E402


EXPECTED_SOURCES = frozenset(
    {
        "polymarket.gamma",
        "polymarket.clob.market",
        "polymarket.rtds.chainlink",
        "polymarket.rtds.binance",
    }
)


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    return parser.parse_args()


def _clob_messages(raw_payload: str) -> list[dict[str, Any]]:
    try:
        decoded = json.loads(raw_payload)
    except json.JSONDecodeError:
        return []
    candidates = decoded if isinstance(decoded, list) else [decoded]
    return [item for item in candidates if isinstance(item, dict)]


def main() -> int:
    args = _arguments()
    data_root = args.data_root.resolve(strict=True)
    manifest_directory = data_root / "manifests"
    manifest_paths = sorted(manifest_directory.glob(f"{args.run_id}-*.manifest.json"))
    datasets = [ManifestVerifier.verify(path, data_root) for path in manifest_paths]
    source_to_dataset: dict[str, Any] = {}
    source_summaries: dict[str, Any] = {}
    observed_book_assets: set[str] = set()
    market_identity_ok = False
    market_collectible = False
    market_slugs: set[str] = set()
    chainlink_clock_ok = False
    binance_clock_ok = False

    for path, dataset in zip(manifest_paths, datasets, strict=True):
        manifest = json.loads(path.read_text(encoding="utf-8"))
        source = manifest["source"]
        if source in source_to_dataset:
            raise ValueError(f"duplicate smoke source manifest: {source}")
        source_to_dataset[source] = dataset
        events = list(RawReplay.iter_raw(dataset))
        quality = build_verified_data_quality_report(dataset)
        source_summaries[source] = {
            "dataset_id": dataset.dataset_id,
            "event_count": len(events),
            "segment_count": len(dataset.segments),
            "market_id_count": len(dataset.market_ids),
            "asset_id_count": len(dataset.asset_ids),
            "quality": quality.to_mapping(),
        }
        if source == "polymarket.gamma":
            for event in events:
                if event.event_type != "gamma_market_response" or event.parser_status != "parsed":
                    continue
                result = discover_btc_five_minute_market(event.raw_payload)
                market_identity_ok = market_identity_ok or result.accepted
                market_collectible = market_collectible or result.collectible
                if result.market is not None:
                    market_slugs.add(result.market.slug)
        elif source == "polymarket.clob.market":
            for event in events:
                if event.parser_status != "parsed":
                    continue
                for message in _clob_messages(event.raw_payload):
                    if message.get("event_type") != "book":
                        continue
                    asset_id = message.get("asset_id")
                    market = message.get("market")
                    if (
                        isinstance(asset_id, str)
                        and asset_id in dataset.asset_ids
                        and isinstance(market, str)
                        and event.condition_id == market
                    ):
                        observed_book_assets.add(asset_id)
        elif source in {"polymarket.rtds.chainlink", "polymarket.rtds.binance"}:
            clock_ok = any(
                event.event_type == "rtds_price_update"
                and event.parser_status == "parsed"
                and event.source_time is not None
                and event.server_time is not None
                for event in events
            )
            if source.endswith("chainlink"):
                chainlink_clock_ok = clock_ok
            else:
                binance_clock_ok = clock_ok

    recovery = ManifestVerifier.scan_recovery(data_root)
    clob_dataset = source_to_dataset.get("polymarket.clob.market")
    expected_book_assets = set() if clob_dataset is None else set(clob_dataset.asset_ids)
    checks = {
        "four_expected_sources": set(source_to_dataset) == EXPECTED_SOURCES,
        "four_final_manifests": len(manifest_paths) == 4,
        "market_identity_accepted": market_identity_ok,
        "market_was_collectible_at_discovery": market_collectible,
        "both_subscribed_book_snapshots_observed": (
            len(expected_book_assets) == 2 and observed_book_assets == expected_book_assets
        ),
        "chainlink_source_and_server_clocks_present": chainlink_clock_ok,
        "binance_source_and_server_clocks_present": binance_clock_ok,
        "no_partial_files": not recovery.partial_incomplete,
        "all_manifests_and_checksums_verified": all(
            summary["quality"]["manifest_consistent"]
            and summary["quality"]["segment_checksum_verified"]
            for summary in source_summaries.values()
        ),
    }
    result = {
        "run_id": args.run_id,
        "manifest_count": len(manifest_paths),
        "market_slugs": sorted(market_slugs),
        "sources": source_summaries,
        "checks": checks,
        "partial_file_count": len(recovery.partial_incomplete),
        "continuity": "UNVERIFIED",
        "continuity_limitation": CONTINUITY_LIMITATION,
        "passed": all(checks.values()),
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
