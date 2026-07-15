"""Strict BTC five-minute Gamma market discovery and normalization."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
import re
from typing import Any

from .domain import Market, OracleDefinition, Outcome, OutcomeToken
from .rules import validate_btc_five_minute_market


CHAINLINK_BTC_USD_URL = "https://data.chain.link/streams/btc-usd"
_SLUG = re.compile(r"^btc-updown-5m-([0-9]+)$")
_CONDITION_ID = re.compile(r"^0x[0-9a-fA-F]{64}$")
_TOKEN_ID = re.compile(r"^[1-9][0-9]*$")
_MARKET_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?Z$")


@dataclass(frozen=True, slots=True)
class MarketDiscoveryResult:
    accepted: bool
    raw_response: str
    market: Market | None
    reasons: tuple[str, ...]
    active: bool | None
    closed: bool | None
    accepting_orders: bool | None
    collectible: bool

    @property
    def normalized_mapping(self) -> dict[str, Any] | None:
        if self.market is None:
            return None
        tokens = {token.outcome.value: token.token_id for token in self.market.outcome_tokens}
        return {
            "market_id": self.market.market_id,
            "condition_id": self.market.condition_id,
            "slug": self.market.slug,
            "interval_start": self.market.interval_start.isoformat().replace("+00:00", "Z"),
            "interval_end": self.market.interval_end.isoformat().replace("+00:00", "Z"),
            "oracle_provider": self.market.oracle.provider,
            "oracle_pair": self.market.oracle.pair,
            "tokens": tokens,
            "active": self.active,
            "closed": self.closed,
            "accepting_orders": self.accepting_orders,
            "collectible": self.collectible,
        }


def _parse_utc(value: Any, field: str) -> datetime:
    if not isinstance(value, str) or _MARKET_UTC.fullmatch(value) is None:
        raise ValueError(f"{field} must be an explicit whole-second UTC timestamp")
    normalized = value.replace(".000Z", "Z")
    return datetime.strptime(normalized, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def _json_string_array(value: Any, field: str) -> list[str]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{field} must contain a JSON string array") from exc
    if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
        raise ValueError(f"{field} must be a non-empty string array")
    return value


def discover_btc_five_minute_market(raw_response: str) -> MarketDiscoveryResult:
    """Return a quarantined result instead of guessing when identity fields disagree."""

    reasons: list[str] = []
    market: Market | None = None
    active: bool | None = None
    closed: bool | None = None
    accepting_orders: bool | None = None
    try:
        payload = json.loads(raw_response)
        if not isinstance(payload, dict):
            raise ValueError("Gamma response must be an object")
        slug = payload.get("slug")
        if not isinstance(slug, str):
            raise ValueError("slug is required")
        match = _SLUG.fullmatch(slug)
        if match is None:
            raise ValueError("slug is not an exact BTC Up/Down five-minute slug")
        epoch = int(match.group(1))
        if epoch % 300 != 0:
            raise ValueError("slug epoch is not aligned to a five-minute UTC boundary")
        interval_start = _parse_utc(payload.get("eventStartTime"), "eventStartTime")
        expected_start = datetime.fromtimestamp(epoch, tz=timezone.utc)
        if interval_start != expected_start:
            raise ValueError("slug epoch does not match eventStartTime")
        interval_end = _parse_utc(payload.get("endDate"), "endDate")
        if interval_end != interval_start + timedelta(seconds=300):
            raise ValueError("endDate must equal eventStartTime plus 300 seconds")

        condition_id = payload.get("conditionId")
        if not isinstance(condition_id, str) or not _CONDITION_ID.fullmatch(condition_id):
            raise ValueError("conditionId must be a 32-byte hex identifier")
        market_id = payload.get("id")
        if not isinstance(market_id, str) or not market_id:
            raise ValueError("market id is required")
        if payload.get("enableOrderBook") is not True:
            raise ValueError("orderbook must be enabled")
        for field in ("active", "closed", "acceptingOrders"):
            if field in payload and payload[field] is not None and not isinstance(payload[field], bool):
                raise ValueError(f"{field} must be boolean when present")
        active = payload.get("active")
        closed = payload.get("closed")
        accepting_orders = payload.get("acceptingOrders")
        resolution_source = payload.get("resolutionSource")
        if not isinstance(resolution_source, str) or resolution_source.rstrip("/") != CHAINLINK_BTC_USD_URL:
            raise ValueError("resolution source must be Chainlink BTC/USD")
        description = payload.get("description")
        if not isinstance(description, str):
            raise ValueError("market description is required")
        description_folded = description.casefold()
        if "greater than or equal" not in description_folded or 'resolve to "down"' not in description_folded:
            raise ValueError("market rules do not prove tie=Up and otherwise=Down")

        labels = _json_string_array(payload.get("outcomes"), "outcomes")
        token_ids = _json_string_array(payload.get("clobTokenIds"), "clobTokenIds")
        if len(labels) != 2 or len(token_ids) != 2 or len(set(token_ids)) != 2:
            raise ValueError("market must expose exactly two distinct CLOB tokens")
        label_map: dict[Outcome, str] = {}
        for label, token_id in zip(labels, token_ids, strict=True):
            if _TOKEN_ID.fullmatch(token_id) is None:
                raise ValueError("CLOB token IDs must be positive decimal integers")
            folded = label.strip().casefold()
            if folded == "up":
                outcome = Outcome.UP
            elif folded == "down":
                outcome = Outcome.DOWN
            else:
                raise ValueError(f"unsupported outcome label: {label!r}")
            if outcome in label_map:
                raise ValueError(f"duplicate outcome label: {label!r}")
            label_map[outcome] = token_id
        if set(label_map) != {Outcome.UP, Outcome.DOWN}:
            raise ValueError("outcome labels must contain exactly Up and Down")

        market = Market(
            market_id=market_id,
            condition_id=condition_id,
            slug=slug,
            interval_start=interval_start,
            interval_end=interval_end,
            oracle=OracleDefinition(provider="Chainlink", pair="BTC/USD"),
            outcome_tokens=tuple(
                OutcomeToken(token_id=label_map[outcome], market_id=market_id, outcome=outcome)
                for outcome in (Outcome.UP, Outcome.DOWN)
            ),
        )
        validate_btc_five_minute_market(market)
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        reasons.append(str(exc))
        market = None
    return MarketDiscoveryResult(
        accepted=market is not None,
        raw_response=raw_response,
        market=market,
        reasons=tuple(reasons),
        active=active,
        closed=closed,
        accepting_orders=accepting_orders,
        collectible=(
            market is not None
            and active is True
            and closed is False
            and accepting_orders is True
        ),
    )
