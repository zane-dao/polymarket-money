---
name: live-simulation-review
description: Audit or implement the polymarket-money live paper-simulation path without sending real orders. Use for real-time ingestion, strategy decisions, simulated execution, positions, PnL, reconnect recovery, market rotation, incidents, and cockpit state. Never enable live trading, call order endpoints, or use credentials.
metadata:
  version: "1.1.0"
---

# Live simulation review

Treat paper simulation as the full trading workflow with the final order submission replaced by a deterministic simulator.

## Non-negotiable boundary

- Keep `LIVE_TRADING_ENABLED=false`.
- Never call real order endpoints.
- Never load, request, print, copy, or persist private keys, wallet secrets, API secrets, or trading credentials.
- Do not add a hidden fallback from simulation to production.

## Checks

1. Preserve the chain: market data → normalized state → strategy decision → eligibility → simulated order → simulated fill → position → PnL → settlement.
2. Keep simulation and production modes structurally separated and test that the production adapter is unreachable in simulation.
3. Use local receive ordering and explicit clock domains; detect stale data, gaps, reconnects, market rotation, and one-sided books.
4. Record every no-trade, rejected, untradeable, submitted, partially filled, filled, cancelled, expired, settled, and unknown state with stable reason codes.
5. Use the same executable-price, visible-size, latency, partial-fill, fee, slippage, and order-lifetime rules as the backtest unless a documented difference is intentional.
6. Make restart recovery deterministic and idempotent; rebuild without duplicating orders, fills, positions, or settlements.
7. Surface health, continuity, risk state, exposure, recent decisions, incidents, and a paper-mode stop control to the frontend.
8. Add focused tests for reconnects, stale books, duplicate events, market rollover, process restart, simulator failure, and accidental production-adapter access.

## Verdicts

- `SAFE_SIMULATION`
- `FAIL`
- `DATA_INSUFFICIENT`

## Output

- Verdict
- End-to-end flow reviewed
- Production-boundary evidence
- Defects by severity
- Tests and remaining limitations
