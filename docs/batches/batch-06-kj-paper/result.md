# Batch 06: K/J historical paper loop result

## Result

The first usable offline loop now runs in `polymarket-money` through
`poly-lab paper-kj`.  It verifies the frozen data receipt, reconstructs J and K
as pure deterministic signals, simulates delayed taker fills with independent
cash/position accounting, settles against official labels, and exports
summary, NDJSON events, and CSV.

The initial realized-volatility proxy was superseded by a content-addressed
point-in-time EWMA artifact built from the receipt-pinned official Binance
one-second archives.  Current results classify signal fidelity as
`CANONICAL_5S_EWMA_OFFICIAL_BINANCE_1S_CLOSE`, which is still not strict legacy
equivalence because the old live trade stream, K USD conversion, and recovered
legacy phase are unavailable.

## Final Test evidence

Configuration: official dataset hash `a27d9d...e4425cafc`, `FINAL_TEST`,
30-second horizon, 10,000 USDC per independent strategy pool.

| Scenario | Strategy | Decisions | Fills | Net PnL | Final cash | Max drawdown |
|---|---:|---:|---:|---:|---:|---:|
| BASE_1S | J | 1,279 | 135 | +4.89566986 | 10,004.89566986 | 337.37332448 |
| BASE_1S | K | 1,279 | 137 | -298.45735874 | 9,701.54264126 | 572.16855299 |
| STRESS_1S_PLUS_TICK | J | 1,279 | 135 | -85.90779747 | 9,914.09220253 | 354.44458335 |
| STRESS_1S_PLUS_TICK | K | 1,279 | 137 | -387.15306309 | 9,612.84693691 | 591.23789223 |

J's BASE result is only +4.90 on 10,000 starting cash, becomes -85.91 under one
adverse tick, and falls to -240.91 after removing the best three days.  K is
negative in both scenarios and falls to -468.15 without its best three days.
The evidence therefore rejects promotion to research candidate and does not
support shadow or live trading.

## L_ADAPTIVE_EXECUTION pre-registered TRAIN/VALIDATION result

The new Python-only `L_ADAPTIVE_EXECUTION` was evaluated with its frozen
`l-adaptive-execution-v1-preregistered` configuration. It uses a dynamic
execution-risk edge instead of J/K's fixed 5 percentage-point base edge, a
smooth 30/60/120-second volatility blend, explicit volatility drag, a dynamic
opening-anchor ambiguity band, and a depth/latency/price-speed budget. It is a
separate strategy and did not change J/K or the TypeScript paper runtime.

| Split | Scenario | Decisions | Fills | Net PnL | Final cash | Max drawdown |
|---|---:|---:|---:|---:|---:|---:|
| TRAIN | BASE_1S | 2,880 | 807 | -20.6611192571958996264383882 | 9,979.33888074280410037356162 | 854.542569651265234441173650 |
| VALIDATION | BASE_1S | 1,440 | 338 | -1,287.046169895371064543169651 | 8,712.953830104628935456830346 | 1,379.390141899152981130344094 |

The configuration was not adjusted after TRAIN. VALIDATION is decisively
negative, so L **fails the historical research gate** and is not eligible for
real-time paper, shadow, or live use. The untouched `FINAL_TEST` split was not
opened: the `paper-l-adaptive` CLI/API accepts only `TRAIN` or `VALIDATION` and
rejects `FINAL_TEST` before any dataset read/run. This is a failed pre-registered
candidate, not evidence that more tuning on the final split is warranted.

This V1 is a single safe baseline, not an optimisation selection. A small
candidate grid is deliberately not retrofitted after seeing this result:
the observed receipt lacks both the consecutive CLOB quote sequence needed for
true quote velocity and a point-in-time Chainlink price needed for
Binance--Chainlink basis. Sweeping L's drag/depth/speed coefficients over the
same short TRAIN slice would select noise without repairing those missing
inputs. A future successor may only use a fixed, documented candidate grid on
TRAIN, select once by BASE/STRESS worst-case net PnL plus concentration gates,
then execute exactly one Validation run; it must still leave FINAL_TEST closed.

The run artifacts remain outside Git:

- `/root/polymarket-money-data/experiments/l-adaptive-execution-v1-train-20260717-r3`
  - result hash `7dde1a4fff3cb16414e71a6f90c3ea9d1693cf50dc5e66afa7459b2e03d05931`
- `/root/polymarket-money-data/experiments/l-adaptive-execution-v1-validation-20260717-r3`
  - result hash `9c5caea5b41707e6735983713cec1c2d6cd24234633787d0fe6592ceb08674d5`

The receipt has one point-in-time CLOB top of book per decision, not a prior
quote sequence. L therefore records current spread only as a 1 Hz
reprice-risk proxy and sets `market_quote_velocity_available=false`; it does
not derive a market-speed signal from the one-second-later execution snapshot.
It also has no point-in-time Chainlink price, so no Binance--Chainlink basis
claim is made.

Final artifacts outside Git:

- `/root/polymarket-money-data/paper-runs/kj-ewma-v4-final-test-30s-base`
  - result hash `3df7f5ba75ed596328251d984e8d6b6b5d7ef99edf8b81610d696f5f05283a29`
- `/root/polymarket-money-data/paper-runs/kj-ewma-v4-final-test-30s-stress`
  - result hash `f990a72b44dd8fc8e060cf4177be83f05715b48ab71d3d893e3b26207751d0c8`

Each run has 2,558 event records.  Independent verification recomputed each
result hash, CSV/NDJSON count, per-strategy net PnL, cash-after-fill identity,
gross-minus-fee identity, and zero position after settlement.

## Verification

```text
Python: 205 passed
Node/TypeScript: 123 passed
Ruff: All checks passed
git diff --check: passed
```

Approved bounded public network access was later used for official protocol
verification and paper-only runtime acceptance.  No credentials, private user
channel, signing, order submission, cancellation, shadow, or live action
occurred.

## Public real-time MVP evidence

The public runtime now has an exact Gamma resolution adapter, durable raw
settlement evidence, target-window cutoff, bounded settlement recovery, shared
initial/recovery acceptance, and replay-verified reports.  One complete public
market run at collector commit `476f21f` returned `accepted=true`, with no
pending risk or private/live activity.  That run predates hash-chained
`RUN_PLAN`, so its report is correctly labeled
`DESCRIPTIVE_PAPER_ONLY_LEGACY_UNBOUND_PLAN` rather than being promoted to a
precommitted multi-market study.

Current code adds `paper:mvp`, `paper:settle`, `paper:finalize`, and
`paper:report`.  The first plan-bound public multi-market run was completed at
collector commit `76131eb4b09af4509266d6bb9db8e0f409631ad2`: three targets in
the frozen 2026-07-16 23:00--23:15 UTC interval all reached official
settlement, and the result was `accepted=true` with `planBinding=HASH_CHAINED`.
The replay report is `DESCRIPTIVE_PAPER_ONLY`, explicitly sets
`profitabilityClaimEligible=false`, and has artifact hash
`6fb04978225a1680c5e747d8b8b2544111e650fafc197e4b163525608d38d775`.
It validates the product loop, not K/J profitability or shadow/live readiness.
The exact current completion boundary is in `completion-audit.md`.

A second independently planned three-market run at collector commit
`e6b27806a7ced5f2748bf4ff89b76797e65d76d1` covered the non-overlapping
2026-07-17 01:15--01:30 UTC window. Its `INITIAL` result was
`accepted=true`, `planBinding=HASH_CHAINED`, and all nine runtime safety/
identity/settlement checks passed; the journal contains 505 records. The
replay report has artifact hash
`15f776e2e972401cff33a3030889b728738018ac08232f0b3e260d307c061c30` and
remains `DESCRIPTIVE_PAPER_ONLY` with `profitabilityClaimEligible=false`.

The offline `paper:cohort-report` command now prepares independent-run
aggregation.  It accepts only replay-verified, hash-chained descriptive reports
and rejects duplicate IDs, overlapping target windows, legacy reports and hash
tampering. The current two-run cohort is outside Git at
`/root/polymarket-money-data/kj-paper-cohort-two-runs-20260717`, with cohort
hash `cba4f224237d0cd6a1c3984c1114920b101bc66a0e6cdd35e262c42417bc0410`.
It covers six non-overlapping markets (J: 20 trades, K: 18 trades) but remains
descriptive and has `profitabilityClaimEligible=false`.

A second, replay-verified operational artifact now keeps quality evidence
separate from cohort PnL: `/root/polymarket-money-data/kj-paper-cohort-observability-two-runs-20260717`
has report hash `e4cd5370760da77e75caccbf0e4ed308dbd619aa3f83deee41dbc1d391f46a4d`.
Across the same six targets, Gamma official-settlement delay is 3.91 minutes
minimum, 6.31 minutes P50 and 7.89 minutes P95/max. J recorded 22 intents,
20 fills, 12 partial fills and two `SLIPPAGE_LIMIT` no-fills; K recorded 20
intents, 18 fills, nine partial fills and two `SLIPPAGE_LIMIT` no-fills. This
artifact also preserves each public stream's events/reconnects/quarantines and
remains `DESCRIPTIVE_PAPER_ONLY`; it does not upgrade theoretical fills or PnL.

## Remaining gaps

1. Strict legacy-equivalent K/J still requires the historical trade-tick stream,
   recovered `vol_epoch`, and K's BTCUSDT/USDCUSDT conversion at every decision.
2. The frozen decision sample does not expose verified Up/Down token IDs in the
   paper row, so this study records outcome positions rather than pretending to
   create exchange-token positions.
3. One decision per market is implemented.  Old multi-batch entry, market-wide
   cash reservation, and overlapping-market portfolios need a separate event
   scheduler before they can be claimed equivalent.
4. Historical settlement uses official final outcome evidence, not point-in-time
   Chainlink open/close observations.  It is valid for outcome PnL but not an
   oracle-latency study.
5. Public runtime `paper` mode consumes the immutable K/J StrategyContext
   through `kj-paper-engine-v2`, with independent wallets, reservations,
   delayed/partial/no-fill handling, positions, and explicit official-only
   settlement state.  Mutation requires an explicit durable hash-chain journal;
   strict replay restores wallet/position/pending state, and checkpoint tests
   cover crash-ahead healing, record modification, incomplete tail and valid-line
   truncation.  Exact Gamma responses are now revalidated into official
   settlement; delayed results can be settled and finalized without opening a
   new market.  One plan-bound three-market public run has passed this
   runtime/replay/report path; it is still too small and too dependent on
   theoretical fills to establish a stable trading edge.
6. The TypeScript real-time probability uses a documented deterministic
   normal-CDF approximation.  A shared golden bounds probability error against
   Python `erf` to `0.0000002` on representative/clamped-tail z-scores.  A second
   shared golden verifies one J fee-threshold rejection and one K
   EWMA-to-intent-to-fill-to-official-settlement path, including fee, position
   and PnL.  Coverage is representative, not proof of exhaustive equivalence
   across every runtime branch.
