# Batch 2 fixture provenance

These fixtures contain public, credential-free examples only. They do not contain account data,
wallet addresses, API keys, orders, or private channels.

| Fixture | Source | Treatment |
|---|---|---|
| `gamma-btc-5m.json` | `GET https://gamma-api.polymarket.com/markets/slug/btc-updown-5m-1775181000`, observed 2026-07-15 | Minimal public-field projection; business wording retained; no user data |
| `clob-market-events.json` | https://docs.polymarket.com/market-data/websocket/market-channel | Synthetic IDs with message shapes adapted from official examples; `.48` retains the documented price lexeme |
| `rtds-events.json` | https://docs.polymarket.com/market-data/websocket/rtds | Official BTC message shapes retained as raw JSON strings so numeric lexemes remain testable |
| `raw-event-v1.golden.jsonl` | Project-authored cross-language contract case | Synthetic, deterministic, credential-free |

The Gamma slug convention is an observed public contract, not a guarantee that Polymarket will
never change it. Runtime discovery therefore verifies the slug epoch against `eventStartTime` and
`endDate`, and quarantines disagreement.
