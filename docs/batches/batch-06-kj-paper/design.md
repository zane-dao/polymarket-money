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

## L_ADAPTIVE_EXECUTION (separate, pre-registered research strategy)

`L_ADAPTIVE_EXECUTION` is a new offline Python strategy; it does not alter the
frozen J/K enum, `paper-kj` CLI, TypeScript runtime, or any current public
paper configuration. It is intentionally a separate invocation:

```text
poly-lab paper-l-adaptive --split TRAIN|VALIDATION ...
```

`FINAL_TEST` is not an accepted CLI/API value. The immutable configuration is
`l-adaptive-execution-v1-preregistered`; it is an execution-risk specification,
not a set of values selected against FINAL_TEST. The protocol records
`TRAIN_FIXED_CONFIGURATION_AUDIT` and then
`VALIDATION_PRE_REGISTERED_CONFIGURATION`. Opening the untouched final split
requires a later explicit decision after the train/validation outcome is
recorded.

L has no absolute base edge. For the selected outcome at decision time its
required edge is the sum of these separately exported terms:

```text
official taker fee per share
+ half overround
+ latency tick/slippage budget
+ Binance log-price speed × latency budget
+ current top-of-book spread reprice-risk proxy × latency budget
+ smoothed sigma × sqrt(remaining time) uncertainty budget
+ visible-depth / permitted-participation pressure budget
```

The order size is still bounded by fractional Kelly, cash, absolute cash cap,
and permitted visible ask depth; the depth term does not claim that a single
top-of-book level reveals the whole L2 curve.

Instead of K's `max(fast, 0.4*slow, floor)`, L combines the receipt's causal
30/60/120-second realised volatilities as a weighted RMS (50%/30%/20%), adds a
small variance-space numerical floor, then applies a continuous short-vs-medium
and medium-vs-long divergence shock multiplier. The normal-CDF probability is
also pulled continuously toward 0.5 using a bounded function of
`sigma * sqrt(remaining)`. This is an explicit volatility drag rather than
assuming that wider uncertainty alone is sufficient.

The fixed `$10` K/J critical band is not used. L fails closed in a dynamic
opening-anchor ambiguity band:

```text
current BTC price × sqrt((1 bp noise)^2
                         + (0.35 × sigma × sqrt(remaining))^2)
```

The historical receipt contains one point-in-time top of book per decision and
one one-second-later execution book. It does **not** contain a prior quote
sequence suitable for CLOB quote velocity. L therefore records
`market_quote_velocity_available=false` and uses only the current bid/ask
width as `CURRENT_TOP_OF_BOOK_SPREAD_PROXY_1HZ`; it never uses the later
execution book to manufacture a speed measurement. Historical rows also lack
a point-in-time Chainlink price, so Binance--Chainlink basis is unavailable in
this study. Both are prerequisites for a later real-time L context, not
assumed alpha here.

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
a real-money portfolio.

With an explicit `--kj-paper-journal`, the TypeScript runtime passes only ready
contexts to `kj-paper-engine-v2`.  Without that option it emits context evidence
but disables K/J wallet mutation.  The engine owns independent J/K wallets,
five-second EWMA state, frozen intents, worst-case cash reservations, one-second
fill latency, maximum-slippage/no-visible-size rejection, partial fills,
positions, and `INIT -> RUNNING -> STOPPING -> DONE` market state.  Context,
signal-input, intent, and settlement identities are idempotent and conflicting
reuse fails closed.  A later context can reduce a frozen quantity but cannot
recompute it from a future price.

Every applied context or Gamma resolution response is first fsynced to a strict
append-only NDJSON input journal.  Records carry contiguous sequence numbers and
a SHA-256 chain; a separately atomically published checkpoint anchors the tail.
New MVP journals place a `RUN_PLAN` record before all contexts so the selected
target interval and collector commit cannot be silently changed during later
reporting.
Recovery validates exact fields, context reconstruction, engine version/config,
market/signal/context identity, the exact public settlement body, per-clock
watermarks, the hash chain, and the checkpoint before deterministic replay.
Only a matching closed Gamma market with `umaResolutionStatus=resolved` and a
unique exact 1/0 result is converted to official settlement evidence.  A
durable journal record ahead of its checkpoint is healed; an incomplete line,
modified record, missing checkpoint, or tail truncation fails closed.  Journals
are Linux-native, non-symlinked, and outside Git.  `paper:inspect` replays one
journal and exports the full wallet, position, market-ledger, pending-intent,
and event-count snapshot.

This real-time path is not claimed byte-equivalent to the Python historical
runner: TypeScript uses the deterministic Abramowitz-Stegun 7.1.26 normal-CDF
approximation, while Python uses its platform `erf`.  The runtime polls the
public Gamma market endpoint after interval end and keeps the exact response as
replayable settlement evidence.  The bounded `paper:mvp` wrapper aligns capture
to the next complete interval, prevents the following market from entering the
run, adds a finite settlement grace window, and emits a machine-readable
acceptance result.  `paper:settle` can resume a frozen half-open target window
when official resolution is delayed beyond that bound, and `paper:finalize`
re-runs the same acceptance contract against the advanced journal before
writing `RECOVERED_FINAL`.  `paper:report` replays
the journal, verifies source/snapshot/safety/settlement/PnL identities, and
exports a hashed descriptive summary plus per-market CSV.  A shared probability
golden bounds the TypeScript approximation to `0.0000002` absolute error against
Python `erf` at representative and clamped-tail z-scores.  A second shared
golden feeds both languages the same five-second price path, final book, fee,
delayed fill and official Up settlement.  It verifies J's fee-threshold
rejection and K's EWMA/probability/edge/intent quantity/fill/fee/position/PnL
path within explicit tolerances.  This is a representative contract, not
exhaustive parity over every book, timing, no-fill and lifecycle branch.

`paper:cohort-report` is an offline-only aggregation layer over completed
single-run report directories.  It rechecks each artifact hash, accepts only
`HASH_CHAINED` `DESCRIPTIVE_PAPER_ONLY` reports, rejects duplicate run IDs and
overlapping target windows, and publishes a no-overwrite cohort hash.  It
aggregates per-strategy market/trade/PnL and per-run sign counts but permanently
retains `profitabilityClaimEligible=false`; it neither changes parameters nor
creates fill, alpha, shadow, or live evidence.

`paper:cohort-observability-report` is deliberately a second, offline-only
layer rather than a change to the PnL cohort. For every accepted report it
re-hashes the referenced runtime summary, strictly reopens the durable journal,
checks record count/tail/event count against both the report and runtime
summary, then reports the six public-stream event/reconnect/quarantine counters,
target-market Gamma official-settlement delay, and J/K intent/fill/partial/no-
fill/reason distribution. It rejects runtime safety/identity/tail conflicts and
keeps the same permanent `DESCRIPTIVE_PAPER_ONLY`/`profitabilityClaimEligible=false`
boundary. It measures paper execution quality; it does not turn a theoretical
fill into exchange evidence.

To prevent choosing a convenient subset of completed runs after seeing their
PnL, `kj-paper-campaign-v1` pre-registers a deterministic sequence of complete
five-minute windows, market count, settlement grace, run IDs and collector
commit under a canonical SHA-256 hash. A campaign-selected MVP run writes a
`kj-paper-run-plan-v2` binding before contexts. `paper:campaign-cohort-report`
accepts a cohort only if it contains every registered run once and every report
matches the campaign hash/index/window/count/commit. This is an evidence
selection constraint, not a profitability claim or an execution change.

`paper:campaign-cohort-observability-report` applies that exact same complete
campaign verification before it reopens journals and runtime summaries. It
therefore makes the PnL and execution-quality cohort refer to the identical
immutable run set; neither report may substitute a convenient post-hoc subset.
The delayed-settlement `paper:finalize` path separately validates the optional
campaign binding in `run-plan.json` before rebuilding its result, so recovery
cannot silently downgrade a v2 journal run-plan to an unbound plan.

The runtime's `--kj-signal-source` selector now permits either the existing
Binance spot signal or a separately identified public Chainlink relay context.
It deliberately does not mix two prices into one K/J engine: each source must
have an independent EWMA/anchor/wallet in the forthcoming paired comparison
mode, otherwise source attribution and PnL would be invalid.

`kj-signal-compare-v1` freezes a matched two-leg plan. Its supervisor creates
one ordinary campaign per source and invokes two existing `paper:mvp` children
concurrently, both with the same half-open target window and commit. This
reuses the hardened wallet, journal, official settlement and recovery path per
source rather than introducing a mixed-source engine.

`kj-signal-compare-campaign-artifact-v1` extends that contract across a whole
pre-registered schedule. One artifact contains both ordinary source campaigns
and one hash-bound compare plan per scheduled window. A selected runner index
must be imminent and maps to the matching source campaign index in both legs;
it cannot substitute a standalone run or a different source's result. This is
an evidence-selection control only: each child still uses the existing public
paper engine, durable journal, official Gamma settlement and independent wallet.
The campaign launcher waits for each fixed pre-warmup timestamp, may overlap a
prior run's Gamma wait with a later run's capture, and writes an immutable exit
summary only after every scheduled child ends. It never moves a missed window
to a later market; any missed/failed run remains visible to the eventual cohort.

Before a plan-bound K/J run, the launcher reserves 180 seconds and the runtime
records only source-specific `WARMUP_SIGNAL` inputs in the same fsync/hash-chain
journal. Replay applies them solely to volatility state. The engine refuses a
warmup after the first market session; the journal also rejects a source-family
change, so Chainlink warmup cannot influence a Binance leg (or conversely).
Warmup has no market identity, order-book input, intent, wallet mutation or
official-settlement candidate. The planned target window remains unchanged.

The current Chainlink RTDS relay is observability only.  A future boundary-based
preliminary outcome must not settle wallets or replace Gamma/UMA final evidence;
the proposed evidence/state contract is in
[`chainlink-provisional-settlement.md`](chainlink-provisional-settlement.md).
