from decimal import Decimal
import unittest

from scripts.run_workbench_backtest import build_public_events


class WorkbenchEventMappingTests(unittest.TestCase):
    def test_filled_research_event_becomes_complete_public_ledger(self) -> None:
        source = [{
            "market_id": "market-1", "decision_time": "2026-01-01T00:00:01Z",
            "fill_time": "2026-01-01T00:00:02Z", "settlement_evidence_time": "2026-01-01T00:05:01Z",
            "status": "FILLED", "reason": None, "side": "UP", "probability_up": "0.61",
            "decision_ask": "0.52", "edge": "0.09", "winner": "UP", "net_pnl": "0.4",
            "intent_id": "intent-1", "fill_id": "fill-1", "settlement_id": "settlement-1",
            "intended_quantity": "2", "fill_price": "0.53", "quantity": "1.5",
            "fee": "0.01", "payout": "1.5", "bankroll_after": "100.4",
        }]
        events, equity = build_public_events(source, "run-1", Decimal("100"))
        self.assertEqual([item["kind"] for item in events], ["decision", "order", "fill", "settlement"])
        self.assertEqual(events[0]["payload"]["action"], "BUY")
        self.assertEqual(events[0]["payload"]["probability"], "0.61")
        self.assertEqual(events[1]["payload"]["orderId"], "intent-1")
        self.assertEqual(events[2]["payload"]["quantity"], "1.5")
        self.assertEqual(events[3]["payload"]["pnl"], "0.4")
        self.assertEqual(equity[-1]["equity"], "100.4")

    def test_no_trade_has_a_decision_but_no_fabricated_order(self) -> None:
        source = [{
            "market_id": "market-2", "decision_time": "2026-01-01T00:00:01Z",
            "status": "NO_TRADE", "reason": "EDGE_BELOW_FEE_AWARE_THRESHOLD",
            "side": "DOWN", "probability_up": "0.4", "decision_ask": "0.55",
            "edge": "0.05", "winner": "UP", "net_pnl": "0",
        }]
        events, equity = build_public_events(source, "run-2", Decimal("100"))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["payload"]["action"], "HOLD")
        self.assertEqual(events[0]["payload"]["reason"], "EDGE_BELOW_FEE_AWARE_THRESHOLD")
        self.assertEqual([item["equity"] for item in equity], ["100", "100"])


if __name__ == "__main__":
    unittest.main()
