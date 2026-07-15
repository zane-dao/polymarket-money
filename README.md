# polymarket-money

`polymarket-money` is a clean-room workspace for research, deterministic strategy
logic, risk controls, and execution abstractions for Polymarket-related systems.
This repository contains contracts, a clean-room Python reference for domain
rules and replay, and credential-free public market-data adapters. Network use
is limited to an explicitly bounded read-only smoke capture; the project has no
user channel, signing client, or order submission path.

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
- `contracts/`: language-neutral, versioned wire contracts.
- `execution/src/strategy/`: pure strategy contracts.
- `execution/src/risk/`: risk policy configuration and decisions.
- `data/`: local data, deterministic fixtures, and golden outputs.
- `tests/`: unit, integration, replay, golden, and shadow test suites.
- `docs/batches/`: batch-scoped design and result documents.
- `reports/batches/`: test, environment, Git, and verification evidence.

## Development

Requirements: Python 3.11+ and Node.js 24+.

```bash
npm ci
npm test
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

`npm test` compiles TypeScript and runs Node runtime tests. The bounded public
smoke command requires an absolute `POLY_DATA_ROOT` outside the repository; no
test or script enables live trading.

The default Binance transport is the exact public `btcusdt` filter. A bounded,
explicit `--binance-transport all-symbols-quarantine` option exists only for
protocol smoke validation when that provider-side filter is silent; non-BTC
frames are retained as quarantine and can never enter the effective BTC stream.
Batch evidence and the canonical handoff live under `docs/batches/` and
`reports/batches/`; raw smoke data always remains outside Git.
