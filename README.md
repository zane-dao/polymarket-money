# polymarket-money

`polymarket-money` is a clean-room workspace for research, deterministic strategy
logic, risk controls, and execution abstractions for Polymarket-related systems.
This repository contains contracts plus a clean-room, offline Python reference
for domain rules, safety gates, and golden PnL accounting. It does not connect
to an exchange and cannot place live orders.

## Safety defaults

- `LIVE_TRADING_ENABLED=false` is the required default.
- Never commit private keys, seed phrases, API keys, cookies, or account data.
- Strategy code is pure and deterministic. I/O belongs behind adapters.
- No code has been migrated from `polymarket-paper` or
  `polymarket-trade-engine`.

## Layout

- `research/`: notebooks, datasets, feature studies, backtests, and reports.
- `research/polymarket_money/`: vendor-neutral Python domain, rules, safety,
  and offline fill accounting.
- `execution/src/domain/`: shared domain contracts.
- `execution/src/adapters/`: external-system interfaces.
- `execution/src/strategy/`: pure strategy contracts.
- `execution/src/risk/`: risk policy configuration and decisions.
- `data/`: local data, deterministic fixtures, and golden outputs.
- `tests/`: unit, integration, replay, golden, and shadow test suites.
- `docs/`: architecture, migration policy, inventory, and known risks.

## Development

Requirements: Python 3.11+ and Node.js 20+.

```bash
npm install
npm run typecheck
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

`npm test` currently performs the TypeScript contract test through compilation.
No test or script enables live trading.
