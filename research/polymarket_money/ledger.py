"""In-memory deterministic fill ledger used by Batch 1 golden tests.

This is not an exchange account ledger or persistence implementation.  It
defines the accounting rules that later durable implementations must match.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from .domain import Fill, PnL, Position, Settlement, Side


class LedgerInvariantError(ValueError):
    """An event conflicts with previously applied ledger truth."""


@dataclass(frozen=True, slots=True)
class SettlementApplication:
    applied: bool
    pnl: PnL


@dataclass(slots=True)
class _MutablePosition:
    quantity: Decimal = Decimal("0")
    net_cash_outlay: Decimal = Decimal("0")
    fees: Decimal = Decimal("0")


class FillLedger:
    """Apply immutable fills and settlements exactly once by event identity."""

    def __init__(self) -> None:
        self._fills: dict[str, Fill] = {}
        self._positions: dict[tuple[str, str], _MutablePosition] = {}
        self._settlements: dict[str, Settlement] = {}
        self._settlement_results: dict[str, PnL] = {}
        self._settled_markets: dict[str, str] = {}

    def apply_fill(self, fill: Fill) -> bool:
        existing = self._fills.get(fill.fill_id)
        if existing is not None:
            if existing != fill:
                raise LedgerInvariantError("duplicate fill_id has conflicting content")
            return False
        if fill.market_id in self._settled_markets:
            raise LedgerInvariantError("cannot apply a fill after market settlement")

        key = (fill.market_id, fill.token_id)
        position = self._positions.setdefault(key, _MutablePosition())
        notional = fill.price * fill.quantity
        if fill.side is Side.BUY:
            position.quantity += fill.quantity
            position.net_cash_outlay += notional
        else:
            if fill.quantity > position.quantity:
                raise LedgerInvariantError("sell fill exceeds the held position")
            position.quantity -= fill.quantity
            position.net_cash_outlay -= notional
        position.fees += fill.fee
        self._fills[fill.fill_id] = fill
        return True

    def get_position(self, market_id: str, token_id: str) -> Position | None:
        position = self._positions.get((market_id, token_id))
        if position is None:
            return None
        return Position(
            market_id=market_id,
            token_id=token_id,
            quantity=position.quantity,
            net_cash_outlay=position.net_cash_outlay,
            fees=position.fees,
        )

    def apply_settlement(self, settlement: Settlement) -> SettlementApplication:
        existing = self._settlements.get(settlement.settlement_id)
        if existing is not None:
            if existing != settlement:
                raise LedgerInvariantError("duplicate settlement_id has conflicting content")
            return SettlementApplication(
                applied=False,
                pnl=self._settlement_results[settlement.settlement_id],
            )

        existing_settlement_id = self._settled_markets.get(settlement.market_id)
        if existing_settlement_id is not None:
            raise LedgerInvariantError(
                "market is already settled under a different settlement_id"
            )

        payout = Decimal("0")
        net_cash_outlay = Decimal("0")
        fees = Decimal("0")
        for (market_id, token_id), position in self._positions.items():
            if market_id != settlement.market_id:
                continue
            net_cash_outlay += position.net_cash_outlay
            fees += position.fees
            if token_id == settlement.winning_token_id:
                payout += position.quantity * settlement.payout_per_token

        gross_pnl = payout - net_cash_outlay
        pnl = PnL(
            market_id=settlement.market_id,
            payout=payout,
            net_cash_outlay=net_cash_outlay,
            gross_pnl=gross_pnl,
            fees=fees,
            net_pnl=gross_pnl - fees,
        )
        self._settlements[settlement.settlement_id] = settlement
        self._settlement_results[settlement.settlement_id] = pnl
        self._settled_markets[settlement.market_id] = settlement.settlement_id
        return SettlementApplication(applied=True, pnl=pnl)
