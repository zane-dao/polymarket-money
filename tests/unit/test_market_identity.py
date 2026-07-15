from copy import deepcopy
import json
from pathlib import Path
import unittest

from research.polymarket_money.domain import Outcome
from research.polymarket_money.market_identity import discover_btc_five_minute_market
from research.polymarket_money.rules import token_for_outcome


ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "data" / "fixtures" / "batch-2" / "gamma-btc-5m.json"


class MarketIdentityTest(unittest.TestCase):
    def setUp(self) -> None:
        self.payload = json.loads(FIXTURE.read_text(encoding="utf-8"))

    def test_public_fixture_maps_up_down_by_label(self) -> None:
        result = discover_btc_five_minute_market(json.dumps(self.payload))
        self.assertTrue(result.accepted)
        self.assertEqual(
            token_for_outcome(result.market, Outcome.UP).token_id,
            "43327618351213667646391460691177105630991180325414735346402735306929604801558",
        )

    def test_reversed_token_arrays_still_map_by_label(self) -> None:
        payload = deepcopy(self.payload)
        up_token, down_token = json.loads(payload["clobTokenIds"])
        payload["outcomes"] = '["Down", "Up"]'
        payload["clobTokenIds"] = json.dumps([down_token, up_token])
        result = discover_btc_five_minute_market(json.dumps(payload))
        self.assertTrue(result.accepted)
        self.assertEqual(token_for_outcome(result.market, Outcome.UP).token_id, up_token)
        self.assertEqual(token_for_outcome(result.market, Outcome.DOWN).token_id, down_token)

    def test_lifecycle_is_exposed_separately_from_identity(self) -> None:
        historical = discover_btc_five_minute_market(json.dumps(self.payload))
        self.assertTrue(historical.accepted)
        self.assertFalse(historical.collectible)
        current = deepcopy(self.payload)
        current["closed"] = False
        current["acceptingOrders"] = True
        accepted = discover_btc_five_minute_market(json.dumps(current))
        self.assertTrue(accepted.accepted)
        self.assertTrue(accepted.collectible)
        current["eventStartTime"] = "2026-04-03T01:50:00.000Z"
        current["endDate"] = "2026-04-03T01:55:00.000Z"
        self.assertTrue(discover_btc_five_minute_market(json.dumps(current)).accepted)

    def test_non_decimal_token_id_is_quarantined(self) -> None:
        payload = deepcopy(self.payload)
        payload["clobTokenIds"] = '["token-up", "2"]'
        result = discover_btc_five_minute_market(json.dumps(payload))
        self.assertFalse(result.accepted)

    def test_slug_epoch_mismatch_is_quarantined(self) -> None:
        payload = deepcopy(self.payload)
        payload["eventStartTime"] = "2026-04-03T01:50:01Z"
        result = discover_btc_five_minute_market(json.dumps(payload))
        self.assertFalse(result.accepted)
        self.assertIn("slug epoch", " ".join(result.reasons))

    def test_non_five_minute_market_is_quarantined(self) -> None:
        payload = deepcopy(self.payload)
        payload["endDate"] = "2026-04-03T02:05:00Z"
        result = discover_btc_five_minute_market(json.dumps(payload))
        self.assertFalse(result.accepted)

    def test_wrong_oracle_is_quarantined(self) -> None:
        payload = deepcopy(self.payload)
        payload["resolutionSource"] = "https://example.invalid/btc-usd"
        result = discover_btc_five_minute_market(json.dumps(payload))
        self.assertFalse(result.accepted)

    def test_orderbook_must_be_enabled(self) -> None:
        payload = deepcopy(self.payload)
        payload["enableOrderBook"] = False
        result = discover_btc_five_minute_market(json.dumps(payload))
        self.assertFalse(result.accepted)


if __name__ == "__main__":
    unittest.main()
