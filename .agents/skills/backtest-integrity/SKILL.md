---
name: backtest-integrity
description: Audit or implement polymarket-money backtests and simulations using point-in-time decisions, executable prices, fees, slippage, partial fills, position accounting, and reproducible PnL. Use for backtest engines, replay, scoring, calibration, simulation, and performance reports. Do not use for visual styling alone.
metadata:
  version: "1.1.0"
---

# Backtest integrity

Never equate theoretical edge with executable profit.

## Checks

1. Every decision uses only information available at its decision timestamp.
2. Use executable bid or ask, visible size, latency assumptions, slippage, order lifetime, queue assumptions, and partial-fill rules.
3. Centralize fee and edge calculations; do not maintain parallel formulas in multiple languages or modules.
4. Use fixed-point or decimal arithmetic for money and document rounding rules.
5. Keep signal generation, execution simulation, portfolio accounting, settlement, and evaluation separate.
6. Record strategy version, validated config, config hash, dataset manifest/hash, Git commit, code version, and random seed.
7. Distinguish no-trade, rejected, stale, untradeable, cancelled, expired, unknown outcome, partially filled, filled, and settled states.
8. Prevent duplicate fills, duplicate settlement, position drift, market rollover leakage, and restart-induced double counting.
9. Report gross PnL, fees, slippage, net PnL, drawdown, turnover, fill rate, exposure, and calibration metrics when relevant.
10. Add adversarial tests for look-ahead, duplicated fills, stale prices, missing books, reconnect gaps, and unknown outcomes.

## Verdicts

- `PASS`
- `FAIL`
- `DATA_INSUFFICIENT`

## Output

- Verdict
- Material assumptions
- Defects by severity
- Corrected metrics, if calculable
- Reproduction command
- Remaining uncertainty
