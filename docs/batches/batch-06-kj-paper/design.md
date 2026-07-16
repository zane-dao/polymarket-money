# Batch 06: K/J historical paper loop design

## Purpose

Create the shortest useful research loop inside `polymarket-money` without
adopting the legacy runtime: verified historical data → J/K probability →
fee-aware intent → delayed theoretical fill → position/cash → official
settlement → gross/fee/net PnL → deterministic JSON/NDJSON/CSV export.

This is offline paper research only.  It has no network, credential, private
channel, signing, order, or cancellation path and keeps
`LIVE_TRADING_ENABLED=false`.

## Reviewed source and provenance

The legacy source is read-only commit
`d08ba3e591617e45b2463777afc6ec64a3ad1a46` under
`/mnt/c/Users/seeta/Desktop/hello-world`:

- `config.toml`: J fee-aware and K dual-vol parameters;
- `polymarket_paper/strategy/signal.py`: zero-drift normal-CDF probability and
  dual-vol floor definition;
- `polymarket_paper/order/trader.py`: fee-aware edge, critical band, Kelly,
  stake/depth gates, and PnL rules;
- `polymarket_paper/strategy/main.py`: variant routing and per-strategy pools;
- `polymarket_paper/strategy/settlement.py` and `core/storage.py`: official
  outcome and pool settlement flow.

No legacy runtime file is copied or imported.  Rules were re-expressed behind
the new repository's immutable historical receipt and Decimal-based paper
accounting boundary.

The open-source engine at `/root/projects/olymarket-trade-engine` remains
read-only.  Its market lifecycle, StrategyContext, user-event buffering,
wallet reservations, recovery, and NDJSON ideas are retained as later design
inputs; its `number` accounting, in-memory idempotency, token array-position
mapping, simplified fills, and recovery implementation are not used here.

## Input contract

The runner accepts only an `ExternalHistoricalDatasetAdapter.load()` receipt.
That loader verifies the manifest content hash, decision-sample hash, label
evidence hash, row counts, and version directory.  The first accepted dataset
is:

```text
dataset_hash = a27d9d1bf4dc5276c7ae5b11abd64250b6e6dc17f01fd432ab0dc10e4425cafc
valid markets = 5,599
decision samples = 16,797
official label coverage = 100%
Binance decision-point coverage = 100%
continuity = UNVERIFIED
```

The paper command additionally pins split, horizon, execution scenario,
initial cash, and the full K/J parameter mapping in the result hash.

## Point-in-time EWMA artifact

`poly-lab build-kj-ewma` verifies all 21 Binance zip hashes and checksum-file
hashes pinned by the historical receipt, then streams 1,814,400 consecutive
one-second closes.  It applies the reviewed legacy equations on a canonical
five-second phase and publishes 16,797 decision-point rows under a
content-addressed directory.  The manifest records source gaps, parameters,
builder code hash, output hash, and fidelity limits.  The observed source has
zero missing seconds.

Artifact hash:

```text
387201c1eacbbe54f81d4519407bdb4acf50c9f6ce9f46a2bdb6f924796265da
```

The paper result also pins the running engine code digest.  An implementation
change can therefore no longer silently retain the same result identity.

## Strategy reconstruction

Both variants use the old normal-CDF mapping, a 5 percentage-point base edge,
official market-static fee, half-overround buffer, $10 critical band, 25%
fractional Kelly, 2% per-trade cash cap, $400 absolute cap, 50% visible-depth
participation, and $1 minimum stake.

- J uses the canonical five-second EWMA with 100-second half-life and
  `0.00002` floor.
- K uses the same stream for 180-second fast and 2,700-second slow EWMA, waits
  180 seconds, then applies `max(fast, 0.4 * slow, 0.000012)`.

Every authoritative event and summary carries
`signal_fidelity=CANONICAL_5S_EWMA_OFFICIAL_BINANCE_1S_CLOSE`.  This is stronger
than the initial realized-volatility proxy but still not Strict legacy
equivalence: one-second kline closes are not live trade ticks, BTCUSDT is not
K's historical `binance_usd` conversion, and the archive start fixes a
canonical phase instead of recovering an old process `vol_epoch`.

## Paper execution and accounting

- Signal and intent use the point-in-time decision book.
- Base execution uses the recorded 1-second-later ask and visible ask size.
- Stress execution adds one $0.01 adverse tick.
- Intent quantity is frozen at decision time from fractional Kelly, cash cap,
  absolute cap, and 50% of decision ask size.  Execution may only reduce it
  against later visible size; future price cannot create or resize an intent.
- Fee is `rate * price * (1-price) * quantity` and remains separate from gross
  and net PnL.
- Each filled record includes stable intent/fill/settlement IDs, cash after
  fill, position before/after fill/after settlement, payout, and bankroll after
  settlement.
- Each strategy owns an independent cash path.  This historical slice uses one
  decision per market, so a position settles before the next selected market's
  decision.
- Unknown fee, critical band, missing/invalid book, no depth, minimum stake,
  insufficient cash, stale-quote edge, and weak edge all fail closed.

## Output contract

The output directory is created with no-overwrite semantics and contains:

- `summary.json`: dataset/config/result hashes, safety flags, totals, cash,
  gross/fee/net PnL, drawdown, and reason counts;
- `events.ndjson`: one canonical audit record per strategy decision;
- `trades.csv`: flat research export containing decisions and all filled
  accounting fields.

The same core mapping always produces the same SHA-256 result hash.

## Public runtime input boundary

The public TypeScript runtime now exposes a paper-only K/J StrategyContext with
full market/token identity, top-of-book, fee evidence, signal source/receive
times, connection/input hashes, and receive stamps.  It fails closed for stale,
crossed, missing-fee, mixed-clock, future-time, and non-running market inputs.
See `live-context.md`.  This does not yet execute the Python strategy or mutate
a real-time paper portfolio.
