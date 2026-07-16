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

The TypeScript public runtime also emits a paper-only
`kjStrategyContextReady/reason/context` envelope.  It binds verified Up/Down
token IDs, fee evidence, book and signal receive stamps, freshness, and source
identity.  In `paper` mode, `kj-paper-engine-v2` consumes only ready contexts
and emits versioned decision, intent, delayed fill/no-fill, wallet, position,
market-state, and explicit official-settlement events only when an explicit
durable journal is supplied.  Without `--kj-paper-journal`, the runtime still
emits StrategyContext evidence but K/J wallet mutation is disabled.

```bash
npm run runtime:live -- paper \
  --duration-seconds 300 --record metrics \
  --git-commit "$(git rev-parse HEAD)" \
  --kj-paper-journal /root/polymarket-money-data/paper-runtime/kj-inputs.ndjson
```

The journal must be absolute, Linux-native, non-symlinked, and outside Git.  It
fsyncs every accepted input, chains record hashes, maintains an independent
tail checkpoint, and strictly replays contexts, fills, reservations, wallets,
positions, and settlements after restart.  Inspect it offline with
`npm run paper:inspect -- /absolute/path/to/kj-inputs.ndjson`.

For a bounded end-to-end product run, use the single-command MVP:

```bash
npm run paper:mvp -- --markets 1
```

It waits for the next complete five-minute market, runs K and J with independent
paper wallets, polls the public Gamma market endpoint for the resolved outcome,
revalidates and journals the exact response, and writes a final `result.json`
below `/root/polymarket-money-data/paper-mvp`.  It accepts 1 through 12 markets,
refuses dirty tracked runtime code, never overwrites a run, and marks the run
accepted only after every target market is settled with no pending intents,
terminal failure, credential access, live client, user channel, or real order.
The default settlement grace is ten minutes and the target interval cutoff
prevents the next market from leaking into the run.  The process exits early
when capture has ended and every registered market has official settlement.
Before any market context, the MVP also hash-binds its run ID, target count,
half-open time window, and committed code ID into the journal.

If an official result arrives after the finite run or the process was
interrupted, resume only the frozen target window without collecting another
market:

```bash
npm run paper:settle -- /absolute/path/to/kj-inputs.ndjson \
  --start-at 2026-07-17T12:00:00.000Z \
  --start-before 2026-07-17T12:05:00.000Z \
  --wait-seconds 600 --output /absolute/path/to/recovery-result.json
```

Recovery reopens and validates the hash-chained journal, polls only ended
markets in that half-open interval, and appends the exact official response.  A
still-open result remains pending rather than being inferred from price.

For a plan-bound run whose original result was unaccepted only because official
resolution arrived after its finite window, complete the local acceptance step:

```bash
npm run paper:finalize -- /absolute/path/to/mvp-run
```

Finalization requires the original result to prove a clean child exit, then
reuses the same acceptance builder as `paper:mvp` to check runtime identity,
paper-only safety, hash-chained plan, exact target count, current journal tail,
settlement, and pending risk.  It writes a no-overwrite `final-result.json` with
`resultKind=RECOVERED_FINAL`; it cannot legitimize legacy unbound plans or a
runtime safety failure.

After an accepted run, generate a replay-verified research report:

```bash
npm run paper:report -- /absolute/path/to/mvp-run \
  --output /absolute/path/to/new-report-directory
```

The report refuses failed runs, pending risk, snapshot drift, target-window
drift, non-paper safety counters, missing settlement pairs, or broken per-market
and aggregate PnL identities.  It writes a no-overwrite `summary.json` and
`markets.csv`, with source-file hashes, CSV hash, and an artifact hash.  Reports
from runs created before journal plan binding are explicitly labeled
`LEGACY_UNBOUND` and remain descriptive only.  All reports set
`profitabilityClaimEligible=false`; multiple paper markets are still not live
fill evidence.  When `final-result.json` exists, `paper:report` validates and
uses it in preference to the original timed-out result.

`data/golden/batch-06/kj-ewma-intent-parity-v1.json` feeds the same five-second
price path, book, fee, delayed fill, and official settlement to Python and
TypeScript.  It verifies a representative J no-trade and K
intent-to-settlement path within explicit numeric tolerances.

The real-time paper engine completes its public-data loop without becoming a
live-trading system.  Only a closed Gamma market with matching market/token/time
identity, `umaResolutionStatus=resolved`, and a unique exact 1/0 outcome can
create `OFFICIAL_RESOLUTION`; unresolved, ambiguous, premature, or conflicting
evidence fails closed.  `monitor` mode never mutates K/J wallets, and neither
mode has an order-submission path.  See
`docs/batches/batch-06-kj-paper/live-context.md` for the exact boundary and
`docs/batches/batch-06-kj-paper/completion-audit.md` for the requirement-by-
requirement completion status and next evidence gate.
