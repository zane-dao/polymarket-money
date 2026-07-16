from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path
import subprocess

import pytest

from research.polymarket_money.normalized import NormalizedDatasetBuilder, NormalizerConfig
from research.polymarket_money.raw_events import (
    RawContractViolation,
    RawEventEnvelopeV1,
    RawEventEnvelopeV2,
    parse_raw_event,
    require_subsecond_receive_stamp,
)
from research.polymarket_money.replay import ManifestVerifier, RawReplay


ROOT = Path(__file__).resolve().parents[2]
GAMMA = ROOT / "data/fixtures/batch-2/gamma-btc-5m.json"


def v2_mapping() -> dict[str, object]:
    payload = GAMMA.read_text(encoding="utf-8")
    return {
        "schema_version": "raw-event-v2",
        "event_id": "gamma-v2-1",
        "source": "polymarket.gamma",
        "stream": "market-discovery",
        "event_type": "market_metadata",
        "transport_connection_id": "gamma-http-1",
        "subscription_id": "gamma-subscription-1",
        "market_id": "1822773",
        "condition_id": "0x29789033e9636c68c85f55bc4731d6ffbe8f41d37caf0df655a383b626e29c23",
        "asset_id": None,
        "provider_source_time": None,
        "provider_server_time": None,
        "local_wall_receive_time": "2026-07-15T00:00:00.100Z",
        "local_monotonic_receive_ns": "100000000",
        "local_receive_ordinal": "1",
        "clock_domain": "process-test-1",
        "process_time": "2026-07-15T00:00:00.110Z",
        "persist_time": "2026-07-15T00:00:00.120Z",
        "source_sequence": None,
        "source_hash": None,
        "raw_payload": payload,
        "raw_sha256": sha256(payload.encode("utf-8")).hexdigest(),
        "parser_status": "parsed",
        "parser_error": None,
    }


def verified_v2_dataset(root: Path):
    event = RawEventEnvelopeV2.from_mapping(v2_mapping())
    data = (json.dumps(event.to_mapping(), separators=(",", ":")) + "\n").encode()
    relative = Path("polymarket.gamma/2026-07-15/market-discovery/segment.jsonl")
    segment = root / relative
    segment.parent.mkdir(parents=True)
    segment.write_bytes(data)
    manifest = {
        "dataset_id": "gamma-v2-dataset",
        "schema_version": "dataset-manifest-v1",
        "source": "polymarket.gamma",
        "stream": "market-discovery",
        "subscription": {"endpoint": "gamma-market-by-slug", "slug": "btc-updown-5m-1775181000"},
        "collector_git_commit": "a" * 40,
        "collection_start": "2026-07-15T00:00:00.100Z",
        "collection_end": "2026-07-15T00:00:00.120Z",
        "segments": [{
            "ordinal": 0,
            "relative_path": str(relative),
            "sha256": sha256(data).hexdigest(),
            "byte_count": len(data),
            "event_count": 1,
            "parse_error_count": 0,
            "unknown_event_count": 0,
            "first_receive_time": "2026-07-15T00:00:00.100Z",
            "last_receive_time": "2026-07-15T00:00:00.100Z",
        }],
        "event_count": 1,
        "parse_error_count": 0,
        "unknown_event_count": 0,
        "first_receive_time": "2026-07-15T00:00:00.100Z",
        "last_receive_time": "2026-07-15T00:00:00.100Z",
        "market_ids": ["1822773"],
        "asset_ids": [],
        "continuity": "UNVERIFIED",
        "sanitized_config": {"endpointClass": "public-read-only"},
    }
    manifest_path = root / "manifests/gamma-v2.manifest.json"
    manifest_path.parent.mkdir()
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    return ManifestVerifier.verify(manifest_path, root)


def test_raw_v2_parses_and_exposes_full_receive_stamp() -> None:
    event = parse_raw_event(json.dumps(v2_mapping()))
    assert isinstance(event, RawEventEnvelopeV2)
    stamp = require_subsecond_receive_stamp(event)
    assert stamp.clock_domain == "process-test-1"
    assert stamp.local_monotonic_receive_ns == "100000000"
    assert stamp.local_receive_ordinal == "1"


def test_raw_v1_remains_readable_but_is_ineligible_for_subsecond() -> None:
    event = RawEventEnvelopeV1.from_json_line(
        (ROOT / "data/fixtures/batch-2/raw-event-v1.golden.jsonl").read_text().rstrip("\n")
    )
    assert parse_raw_event(json.dumps(event.to_mapping())) == event
    with pytest.raises(RawContractViolation, match="ineligible for subsecond"):
        require_subsecond_receive_stamp(event)


def test_manifest_replay_and_normalizer_consume_raw_v2(tmp_path: Path) -> None:
    verified = verified_v2_dataset(tmp_path)
    replayed = list(RawReplay.iter_raw(verified))
    assert len(replayed) == 1
    assert isinstance(replayed[0], RawEventEnvelopeV2)
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout.strip()
    build = NormalizedDatasetBuilder.normalize_verified(
        [verified], "raw-v2-normalized", commit, NormalizerConfig()
    )
    assert any(item.raw_lineage.event_id == "gamma-v2-1" for item in build.records)
