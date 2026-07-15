"""Manifest-gated verification and deterministic replay for immutable raw JSONL."""

from __future__ import annotations

from dataclasses import dataclass, field
from hashlib import sha256
import json
from pathlib import Path
import re
from typing import Any, Iterator

from .raw_events import RawEventEnvelopeV1, RawContractViolation, parse_utc_iso, utc_iso


class ManifestVerificationError(ValueError):
    """The dataset is not complete and must yield no replay events."""


_VERIFICATION_PROOF = object()
_SAFE_PART = re.compile(r"^[A-Za-z0-9._-]+$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_COMMIT = re.compile(r"^(?:UNCOMMITTED|[0-9a-f]{7,64})$")
_TOKEN_ID = re.compile(r"^[0-9]+$")
_BTC_5M_SLUG = re.compile(r"^btc-updown-5m-[0-9]+$")
_SECRET_TEXT = re.compile(
    r"(secret|api.?key|private.?key|mnemonic|seed|passphrase|credential|gamma.?auth|wallet)",
    re.I,
)
_MANIFEST_FIELDS = frozenset(
    {
        "dataset_id",
        "schema_version",
        "source",
        "stream",
        "subscription",
        "collector_git_commit",
        "collection_start",
        "collection_end",
        "segments",
        "event_count",
        "parse_error_count",
        "unknown_event_count",
        "first_receive_time",
        "last_receive_time",
        "market_ids",
        "asset_ids",
        "continuity",
        "sanitized_config",
    }
)
_SEGMENT_FIELDS = frozenset(
    {
        "ordinal",
        "relative_path",
        "sha256",
        "byte_count",
        "event_count",
        "parse_error_count",
        "unknown_event_count",
        "first_receive_time",
        "last_receive_time",
    }
)


@dataclass(frozen=True, slots=True)
class VerifiedSegment:
    ordinal: int
    relative_path: str
    raw_bytes: bytes = field(repr=False)
    sha256: str
    event_count: int


@dataclass(frozen=True, slots=True)
class VerifiedDataset:
    dataset_id: str
    root: Path
    segments: tuple[VerifiedSegment, ...]
    market_ids: frozenset[str]
    asset_ids: frozenset[str]
    _proof: object = field(repr=False, compare=False)
    manifest_path: Path | None = None
    manifest_bytes: bytes = field(default=b"", repr=False)
    manifest_sha256: str = ""
    source: str = ""
    stream: str = ""
    subscription_json: str = "{}"
    collector_git_commit: str = ""
    continuity: str = "UNVERIFIED"
    sanitized_config_json: str = "{}"

    def __post_init__(self) -> None:
        if self._proof is not _VERIFICATION_PROOF:
            raise ManifestVerificationError(
                "VerifiedDataset can only be created by ManifestVerifier"
            )


@dataclass(frozen=True, slots=True)
class RecoveryReport:
    partial_incomplete: tuple[Path, ...]


def _require_exact_fields(value: dict[str, Any], expected: frozenset[str], field_name: str) -> None:
    actual = frozenset(value)
    missing = expected - actual
    unknown = actual - expected
    if missing or unknown:
        raise ManifestVerificationError(
            f"{field_name} fields mismatch: missing={sorted(missing)} unknown={sorted(unknown)}"
        )


def _require_int(value: Any, field_name: str, *, minimum: int = 0, maximum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ManifestVerificationError(f"{field_name} must be an integer >= {minimum}")
    if maximum is not None and value > maximum:
        raise ManifestVerificationError(f"{field_name} must be <= {maximum}")
    return value


def _require_string(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ManifestVerificationError(f"{field_name} must be a non-empty string")
    return value


def _require_string_list(value: Any, field_name: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        raise ManifestVerificationError(f"{field_name} must be a string list")
    if len(value) != len(set(value)):
        raise ManifestVerificationError(f"{field_name} must not contain duplicates")
    return value


def _require_safe_part(value: Any, field_name: str) -> str:
    text = _require_string(value, field_name)
    if _SAFE_PART.fullmatch(text) is None or text in {".", ".."}:
        raise ManifestVerificationError(f"{field_name} is not path-safe")
    return text


def _validate_subscription(source: str, value: Any) -> None:
    if not isinstance(value, dict):
        raise ManifestVerificationError("subscription must be an object")
    serialized = json.dumps(value, sort_keys=True, separators=(",", ":"))
    if _SECRET_TEXT.search(serialized):
        raise ManifestVerificationError("credential-like subscription content is forbidden")
    if source == "polymarket.gamma":
        _require_exact_fields(value, frozenset({"endpoint", "slug"}), "subscription")
        if value["endpoint"] != "gamma-market-by-slug" or not isinstance(value["slug"], str):
            raise ManifestVerificationError("invalid Gamma public subscription")
        if _BTC_5M_SLUG.fullmatch(value["slug"]) is None:
            raise ManifestVerificationError("Gamma subscription slug is not BTC five-minute")
        return
    if source == "polymarket.clob.market":
        _require_exact_fields(
            value,
            frozenset({"assets_ids", "type", "custom_feature_enabled"}),
            "subscription",
        )
        asset_ids = _require_string_list(value["assets_ids"], "subscription.assets_ids")
        if not asset_ids or any(_TOKEN_ID.fullmatch(asset_id) is None for asset_id in asset_ids):
            raise ManifestVerificationError("CLOB subscription requires decimal token IDs")
        if value["type"] != "market" or value["custom_feature_enabled"] is not True:
            raise ManifestVerificationError("invalid CLOB public Market Channel subscription")
        return
    if source in {"polymarket.rtds.chainlink", "polymarket.rtds.binance"}:
        _require_exact_fields(value, frozenset({"action", "subscriptions"}), "subscription")
        subscriptions = value["subscriptions"]
        if value["action"] != "subscribe" or not isinstance(subscriptions, list) or len(subscriptions) != 1:
            raise ManifestVerificationError("RTDS subscription must contain exactly one public topic")
        item = subscriptions[0]
        if not isinstance(item, dict):
            raise ManifestVerificationError("RTDS subscription item must be an object")
        if source.endswith("chainlink"):
            _require_exact_fields(
                item,
                frozenset({"topic", "type", "filters"}),
                "subscription item",
            )
            expected = {
                "topic": "crypto_prices_chainlink",
                "type": "*",
                "filters": '{"symbol":"btc/usd"}',
            }
            if item != expected:
                raise ManifestVerificationError("RTDS subscription does not match its declared source")
            return
        expected = (
            {"topic": "crypto_prices", "type": "update"}
            if "filters" not in item
            else {"topic": "crypto_prices", "type": "update", "filters": "btcusdt"}
        )
        _require_exact_fields(item, frozenset(expected), "subscription item")
        if item != expected:
            raise ManifestVerificationError("RTDS subscription does not match its declared source")
        return
    if source.startswith("fixture."):
        if value != {"topic": "public-fixture"}:
            raise ManifestVerificationError("fixture subscription must use the public-fixture marker")
        return
    raise ManifestVerificationError(f"unsupported public dataset source: {source}")


def _validate_sanitized_config(value: Any) -> None:
    if not isinstance(value, dict):
        raise ManifestVerificationError("sanitized_config must be an object")
    validators = {
        "endpointClass": lambda item: isinstance(item, str)
        and item in {"public", "public-read-only", "fixture"},
        "heartbeatSeconds": lambda item: isinstance(item, int)
        and not isinstance(item, bool)
        and item in {5, 10},
        "maxEvents": lambda item: isinstance(item, int)
        and not isinstance(item, bool)
        and 1 <= item <= 10_000,
        "timeoutSeconds": lambda item: isinstance(item, int)
        and not isinstance(item, bool)
        and 1 <= item <= 300,
        "customFeatures": lambda item: isinstance(item, bool),
        "symbolFilter": lambda item: isinstance(item, str)
        and item in {"btc/usd", "btcusdt"},
        "transportScope": lambda item: isinstance(item, str)
        and item in {"btc-only", "all-symbols-quarantine"},
        "maxFrameBytes": lambda item: isinstance(item, int)
        and not isinstance(item, bool)
        and 1 <= item <= 50 * 1024 * 1024,
        "maxTotalBytes": lambda item: isinstance(item, int)
        and not isinstance(item, bool)
        and 1 <= item <= 50 * 1024 * 1024,
        "maxResponseBytes": lambda item: isinstance(item, int)
        and not isinstance(item, bool)
        and 1 <= item <= 50 * 1024 * 1024,
    }
    for key, item in value.items():
        validator = validators.get(key)
        if validator is None or not validator(item):
            raise ManifestVerificationError(f"sanitized_config value is not allowlisted: {key}")


def _assert_ingress_config_matches_subscription(
    source: str,
    subscription: dict[str, Any],
    config: dict[str, Any],
) -> None:
    if source == "polymarket.rtds.chainlink":
        if config.get("symbolFilter") != "btc/usd" or "transportScope" in config:
            raise ManifestVerificationError(
                "Chainlink manifest must record the btc/usd effective filter"
            )
        return
    if source == "polymarket.rtds.binance":
        item = subscription["subscriptions"][0]
        expected_scope = (
            "all-symbols-quarantine" if "filters" not in item else "btc-only"
        )
        if (
            config.get("symbolFilter") != "btcusdt"
            or config.get("transportScope") != expected_scope
        ):
            raise ManifestVerificationError(
                "Binance effective filter and transport scope do not match subscription"
            )
        return
    if "symbolFilter" in config or "transportScope" in config:
        raise ManifestVerificationError(
            "symbolFilter and transportScope are reserved for RTDS manifests"
        )


def _reject_symlink_components(root: Path, relative_path: Path) -> None:
    current = root
    for part in relative_path.parts:
        current = current / part
        try:
            if current.is_symlink():
                raise ManifestVerificationError(f"symlink forbidden in verified path: {relative_path}")
        except OSError as exc:
            raise ManifestVerificationError("unable to inspect dataset path") from exc


class ManifestVerifier:
    @staticmethod
    def verify(manifest_path: Path, data_root: Path) -> VerifiedDataset:
        try:
            if data_root.is_symlink():
                raise ManifestVerificationError("data_root must not be a symlink")
            root = data_root.resolve(strict=True)
            if manifest_path.name.endswith(".partial") or not manifest_path.name.endswith(".manifest.json"):
                raise ManifestVerificationError("only a final .manifest.json is a commit record")
            if manifest_path.is_symlink():
                raise ManifestVerificationError("manifest must not be a symlink")
            resolved_manifest = manifest_path.resolve(strict=True)
            manifest_directory = (root / "manifests").resolve(strict=True)
            if resolved_manifest.parent != manifest_directory:
                raise ManifestVerificationError("manifest must be directly inside data_root/manifests")
            manifest_bytes = resolved_manifest.read_bytes()
            manifest = json.loads(manifest_bytes.decode("utf-8"))
        except ManifestVerificationError:
            raise
        except (OSError, json.JSONDecodeError) as exc:
            raise ManifestVerificationError("manifest is unreadable") from exc
        if not isinstance(manifest, dict):
            raise ManifestVerificationError("manifest must be an object")
        _require_exact_fields(manifest, _MANIFEST_FIELDS, "manifest")
        if manifest["schema_version"] != "dataset-manifest-v1":
            raise ManifestVerificationError("unsupported manifest schema")
        if manifest["continuity"] != "UNVERIFIED":
            raise ManifestVerificationError("public stream continuity cannot be VERIFIED")
        source = _require_safe_part(manifest["source"], "source")
        stream = _require_safe_part(manifest["stream"], "stream")
        dataset_id = _require_safe_part(manifest["dataset_id"], "dataset_id")
        collector_commit = _require_string(manifest["collector_git_commit"], "collector_git_commit")
        if _COMMIT.fullmatch(collector_commit) is None or (
            collector_commit == "UNCOMMITTED" and not source.startswith("fixture.")
        ):
            raise ManifestVerificationError("collector_git_commit must be a Git object ID or UNCOMMITTED")
        _validate_subscription(source, manifest["subscription"])
        _validate_sanitized_config(manifest["sanitized_config"])
        _assert_ingress_config_matches_subscription(
            source,
            manifest["subscription"],
            manifest["sanitized_config"],
        )
        try:
            collection_start = parse_utc_iso(manifest["collection_start"], "collection_start")
            collection_end = parse_utc_iso(manifest["collection_end"], "collection_end")
        except RawContractViolation as exc:
            raise ManifestVerificationError("manifest collection clocks are invalid") from exc
        if collection_end < collection_start:
            raise ManifestVerificationError("collection_end precedes collection_start")
        segments_value = manifest["segments"]
        if not isinstance(segments_value, list) or not segments_value:
            raise ManifestVerificationError("manifest must reference at least one segment")

        verified: list[VerifiedSegment] = []
        referenced_paths: set[str] = set()
        total_events = total_errors = total_unknown = 0
        first_receive: str | None = None
        last_receive: str | None = None
        market_ids: set[str] = set()
        asset_ids: set[str] = set()
        event_fingerprints: dict[str, str] = {}
        for expected_ordinal, segment in enumerate(segments_value):
            if not isinstance(segment, dict):
                raise ManifestVerificationError("segment entry must be an object")
            _require_exact_fields(segment, _SEGMENT_FIELDS, "segment")
            ordinal = _require_int(segment["ordinal"], "segment.ordinal")
            if ordinal != expected_ordinal:
                raise ManifestVerificationError("segment ordinals must be contiguous and ordered")
            relative = _require_string(segment["relative_path"], "segment.relative_path")
            if relative in referenced_paths:
                raise ManifestVerificationError("manifest repeats a segment path")
            referenced_paths.add(relative)
            relative_path = Path(relative)
            if (
                relative_path.is_absolute()
                or ".." in relative_path.parts
                or len(relative_path.parts) != 4
                or relative_path.parts[0] != source
                or relative_path.parts[2] != stream
                or not relative_path.name.endswith(".jsonl")
                or relative_path.name.endswith(".partial")
            ):
                raise ManifestVerificationError("segment path does not match source/date/stream")
            partition_date = relative_path.parts[1]
            _reject_symlink_components(root, relative_path)
            try:
                path = (root / relative_path).resolve(strict=True)
                if not path.is_relative_to(root) or not path.is_file():
                    raise ManifestVerificationError("segment escapes data root")
                raw = path.read_bytes()
            except ManifestVerificationError:
                raise
            except OSError as exc:
                raise ManifestVerificationError("segment is unreadable") from exc
            if not raw.endswith(b"\n"):
                raise ManifestVerificationError("segment must end with LF")
            if len(raw) != _require_int(segment["byte_count"], "segment.byte_count"):
                raise ManifestVerificationError("segment byte count mismatch")
            digest = sha256(raw).hexdigest()
            expected_digest = segment["sha256"]
            if not isinstance(expected_digest, str) or _SHA256.fullmatch(expected_digest) is None:
                raise ManifestVerificationError("segment sha256 is malformed")
            if digest != expected_digest:
                raise ManifestVerificationError("segment checksum mismatch")
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise ManifestVerificationError("segment is not valid UTF-8") from exc
            lines = text[:-1].split("\n")
            if not lines or any(line == "" for line in lines):
                raise ManifestVerificationError("segment contains an empty or torn line")
            expected_count = _require_int(segment["event_count"], "segment.event_count")
            if len(lines) != expected_count:
                raise ManifestVerificationError("segment event count mismatch")
            try:
                envelopes = [RawEventEnvelopeV1.from_json_line(line) for line in lines]
            except RawContractViolation as exc:
                raise ManifestVerificationError("segment contains an invalid envelope") from exc
            if any(event.source != source or event.stream != stream for event in envelopes):
                raise ManifestVerificationError("segment envelope source/stream mismatch")
            if any(event.receive_time.date().isoformat() != partition_date for event in envelopes):
                raise ManifestVerificationError("segment partition date does not match receive_time")
            for event in envelopes:
                fingerprint = sha256(
                    json.dumps(
                        event.to_mapping(),
                        sort_keys=True,
                        separators=(",", ":"),
                        ensure_ascii=False,
                    ).encode("utf-8")
                ).hexdigest()
                prior = event_fingerprints.setdefault(event.event_id, fingerprint)
                if prior != fingerprint:
                    raise ManifestVerificationError("duplicate event_id has conflicting envelope content")
                if event.market_id is not None:
                    market_ids.add(event.market_id)
                if event.asset_id is not None:
                    asset_ids.add(event.asset_id)
            error_count = sum(event.parser_status == "error" for event in envelopes)
            unknown_count = sum(event.parser_status == "unparsed" for event in envelopes)
            if error_count != _require_int(segment["parse_error_count"], "parse_error_count"):
                raise ManifestVerificationError("segment parse error count mismatch")
            if unknown_count != _require_int(segment["unknown_event_count"], "unknown_event_count"):
                raise ManifestVerificationError("segment unknown event count mismatch")
            receive_values = [utc_iso(event.receive_time) for event in envelopes]
            segment_first = min(item for item in receive_values if item is not None)
            segment_last = max(item for item in receive_values if item is not None)
            if segment["first_receive_time"] != segment_first:
                raise ManifestVerificationError("segment first receive time mismatch")
            if segment["last_receive_time"] != segment_last:
                raise ManifestVerificationError("segment last receive time mismatch")
            first_receive = segment_first if first_receive is None else min(first_receive, segment_first)
            last_receive = segment_last if last_receive is None else max(last_receive, segment_last)
            total_events += expected_count
            total_errors += error_count
            total_unknown += unknown_count
            verified.append(
                VerifiedSegment(
                    ordinal=ordinal,
                    relative_path=relative,
                    raw_bytes=raw,
                    sha256=digest,
                    event_count=expected_count,
                )
            )

        if total_events != _require_int(manifest["event_count"], "event_count"):
            raise ManifestVerificationError("manifest event count mismatch")
        if total_errors != _require_int(manifest["parse_error_count"], "parse_error_count"):
            raise ManifestVerificationError("manifest parse error count mismatch")
        if total_unknown != _require_int(manifest["unknown_event_count"], "unknown_event_count"):
            raise ManifestVerificationError("manifest unknown event count mismatch")
        if manifest["first_receive_time"] != first_receive:
            raise ManifestVerificationError("manifest first receive time mismatch")
        if manifest["last_receive_time"] != last_receive:
            raise ManifestVerificationError("manifest last receive time mismatch")
        if first_receive is None or last_receive is None:
            raise ManifestVerificationError("manifest has no receive time range")
        try:
            first_dt = parse_utc_iso(first_receive, "first_receive_time")
            last_dt = parse_utc_iso(last_receive, "last_receive_time")
        except RawContractViolation as exc:
            raise ManifestVerificationError("manifest receive range is invalid") from exc
        if first_dt < collection_start or last_dt > collection_end:
            raise ManifestVerificationError("events fall outside collection range")
        declared_market_ids = _require_string_list(manifest["market_ids"], "market_ids")
        declared_asset_ids = _require_string_list(manifest["asset_ids"], "asset_ids")
        if source == "polymarket.clob.market":
            subscribed_assets = manifest["subscription"]["assets_ids"]
            asset_ids.update(subscribed_assets)
        if declared_market_ids != sorted(market_ids):
            raise ManifestVerificationError("manifest market_ids do not match segment contents")
        if declared_asset_ids != sorted(asset_ids):
            raise ManifestVerificationError("manifest asset_ids do not match segment contents")
        return VerifiedDataset(
            dataset_id=dataset_id,
            root=root,
            segments=tuple(verified),
            market_ids=frozenset(market_ids),
            asset_ids=frozenset(asset_ids),
            _proof=_VERIFICATION_PROOF,
            manifest_path=resolved_manifest,
            manifest_bytes=manifest_bytes,
            manifest_sha256=sha256(manifest_bytes).hexdigest(),
            source=source,
            stream=stream,
            subscription_json=json.dumps(
                manifest["subscription"], sort_keys=True, separators=(",", ":")
            ),
            collector_git_commit=collector_commit,
            continuity="UNVERIFIED",
            sanitized_config_json=json.dumps(
                manifest["sanitized_config"], sort_keys=True, separators=(",", ":")
            ),
        )

    @staticmethod
    def scan_recovery(data_root: Path) -> RecoveryReport:
        try:
            root = data_root.resolve(strict=True)
            partials = tuple(sorted(path for path in root.rglob("*.partial") if path.is_file()))
        except OSError as exc:
            raise ManifestVerificationError("data root is unreadable") from exc
        return RecoveryReport(partial_incomplete=partials)


class RawReplay:
    @staticmethod
    def _assert_verified(dataset: VerifiedDataset) -> None:
        if not isinstance(dataset, VerifiedDataset) or dataset._proof is not _VERIFICATION_PROOF:
            raise ManifestVerificationError("replay requires a ManifestVerifier result")

    @staticmethod
    def iter_raw(dataset: VerifiedDataset) -> Iterator[RawEventEnvelopeV1]:
        RawReplay._assert_verified(dataset)
        for segment in sorted(dataset.segments, key=lambda item: item.ordinal):
            if sha256(segment.raw_bytes).hexdigest() != segment.sha256:
                raise ManifestVerificationError("verified in-memory segment digest changed")
            text = segment.raw_bytes.decode("utf-8")
            lines = text[:-1].split("\n")
            if len(lines) != segment.event_count:
                raise ManifestVerificationError("verified in-memory segment count changed")
            for line in lines:
                yield RawEventEnvelopeV1.from_json_line(line)

    @staticmethod
    def iter_effective(dataset: VerifiedDataset) -> Iterator[RawEventEnvelopeV1]:
        seen: set[str] = set()
        for event in RawReplay.iter_raw(dataset):
            if event.parser_status != "parsed" or event.event_id in seen:
                continue
            seen.add(event.event_id)
            yield event

    @staticmethod
    def iter_quarantine(dataset: VerifiedDataset) -> Iterator[RawEventEnvelopeV1]:
        for event in RawReplay.iter_raw(dataset):
            if event.parser_status in {"error", "quarantined"}:
                yield event
