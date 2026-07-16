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
- No legacy runtime or open-source engine module is imported.  The historical
  J/K paper study is a reviewed clean-room reconstruction of explicit legacy
  rules and records its remaining signal-fidelity limit in every result.

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

## Historical J/K paper loop

`poly-lab build-kj-ewma` builds a content-addressed point-in-time volatility
artifact from the official Binance one-second archives pinned by Batch 3B.
`poly-lab paper-kj` then runs a credential-free, deterministic J/K
reconstruction over the hash-verified historical dataset.  It exports `summary.json`,
`events.ndjson`, and `trades.csv` with signal, intent, theoretical fill,
position, cash, fee, settlement, and PnL fields.  The current frozen dataset
can now use canonical 5-second J/K EWMA derived from 1-second closes.  Results
are explicitly classified `CANONICAL_5S_EWMA_OFFICIAL_BINANCE_1S_CLOSE`, not
strict tick-for-tick legacy reproduction or live-profit evidence: the source is
not the old live trade stream, K's USD conversion is unavailable, and the
canonical archive phase is not a recovered legacy `vol_epoch`.

```bash
.venv/bin/poly-lab paper-kj \
  --dataset /root/polymarket-money-data/external-research/normalized/\
dataset_id=btc-5m-primary-v2-baseline-samples/\
version=a27d9d1bf4dc5276c7ae5b11abd64250b6e6dc17f01fd432ab0dc10e4425cafc \
  --dataset-hash a27d9d1bf4dc5276c7ae5b11abd64250b6e6dc17f01fd432ab0dc10e4425cafc \
  --ewma-artifact /root/polymarket-money-data/external-research/kj-ewma/\
artifact=387201c1eacbbe54f81d4519407bdb4acf50c9f6ce9f46a2bdb6f924796265da \
  --strategy both --split FINAL_TEST --horizon 30 --scenario BASE_1S \
  --output /root/polymarket-money-data/paper-runs/my-kj-run
```

The output directory must not already exist.  This prevents an earlier run
from being silently overwritten.
