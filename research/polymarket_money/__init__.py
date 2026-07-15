"""Vendor-neutral research domain, rules, safety gates, and offline accounting."""

from .domain import (
    Decision,
    DecisionAction,
    Fill,
    Market,
    OracleDefinition,
    OraclePrice,
    OrderBookSnapshot,
    OrderIntent,
    Outcome,
    OutcomeToken,
    PnL,
    Position,
    PriceLevel,
    Settlement,
    Side,
)
from .market_identity import MarketDiscoveryResult, discover_btc_five_minute_market
from .raw_events import RawEventEnvelopeV1, RtdsPriceObservation, parse_rtds_price
from .data_quality import (
    DataQualityReport,
    build_data_quality_report,
    build_verified_data_quality_report,
)

__all__ = [
    "Decision",
    "DecisionAction",
    "Fill",
    "Market",
    "OracleDefinition",
    "OraclePrice",
    "OrderBookSnapshot",
    "OrderIntent",
    "Outcome",
    "OutcomeToken",
    "PnL",
    "Position",
    "PriceLevel",
    "Settlement",
    "Side",
    "MarketDiscoveryResult",
    "RawEventEnvelopeV1",
    "RtdsPriceObservation",
    "discover_btc_five_minute_market",
    "parse_rtds_price",
    "DataQualityReport",
    "build_data_quality_report",
    "build_verified_data_quality_report",
]
