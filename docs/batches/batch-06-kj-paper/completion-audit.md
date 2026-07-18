# Batch 06 K/J research and paper MVP completion audit

Audit date: 2026-07-18

Code branch: `batch/06-kj-paper-loop`

Audited baseline: `e6b2780`; the L research boundary and recovery hardening
below were verified in the current working tree.

## Decision

The current engineering MVP is runnable and replay-verifiable, but the broader
project goal is not complete.

- `MVP_ENGINEERING_COMPLETE`: historical K/J research and a bounded public-data
  paper loop connect market identity, signal, intent, delayed theoretical fill,
  wallet reservation, token position, official settlement, PnL, durable journal,
  recovery, finalization, and report export.
- `CURRENT_PLAN_BOUND_MULTI_MARKET_EVIDENCE_COMPLETE`: two approved bounded
  public runs, each with three non-overlapping targets, recorded `RUN_PLAN`
  before context, returned `accepted=true`, and produced replay-verified
  `DESCRIPTIVE_PAPER_ONLY` reports.  This is product-path evidence only, not
  profitability evidence.
- `NOT_SHADOW_OR_LIVE_READY`: public CLOB continuity remains `UNVERIFIED`, fills
  are theoretical, historical K/J does not have strict legacy signal fidelity,
  and K/J has no stable independent-sample positive edge.

## Requirement-by-requirement evidence

| Requirement | Status | Authoritative evidence | Residual limit |
|---|---|---|---|
| `polymarket-money` is the only future main project | Proven current | Repository contains all new code and engineering docs; project decision D-022 marks the workbench and reference repositories read-only | Old products remain historical references and are not deleted |
| Understand old K/J and the complete legacy path | Proven for the available source | `docs/current-project-audit.md`, `docs/module-inventory.md`, and Batch 06 design identify config, signal, sizing, fill, storage, and settlement responsibilities | Missing old live tick stream, K USD conversion, and recovered `vol_epoch` prevent strict tick equivalence |
| Decide reuse/adapt/rewrite/abandon | Proven current | `docs/reuse-register.md` and `docs/engine-review.md` record per-module decisions, provenance, and license boundaries | Decisions must be revisited if a future live adapter is authorized |
| Historical or public data reaches K/J signals | Proven | `build-kj-ewma` plus `paper-kj` consume hash-pinned historical inputs; public runtime builds immutable `StrategyContext` from Gamma, CLOB, and Binance evidence | Runtime and Python historical paths are representative-contract aligned, not byte-identical |
| Market identity and Up/Down mapping are verified | Proven | Public market adapter validates slug/condition/time and maps labels to token IDs; settlement adapter checks the same identity again | Upstream has no gap-free public cursor |
| Five-minute lifecycle isolation | Proven | `kj-paper-engine-v2` implements `INIT -> RUNNING -> STOPPING -> DONE`; target cutoff prevents the following market entering an MVP run; the 2026-07-16 run completed exactly three planned targets | One bounded run is not long-run reliability evidence |
| Delayed, partial, no-fill paper execution | Proven as a paper model | Frozen intent, one-second latency, slippage guard, visible-size partial fill, reservation release, and deterministic tests | No queue position, hidden liquidity, or proof a live order would fill |
| Independent wallet, position, fee, and PnL | Proven | Decimal `Money`, independent J/K wallets, reservations, token positions, settlement events, golden tests, and report identities | Not exchange reconciliation; no private account truth is read |
| Official resolution only | Proven | Exact Gamma response is journaled and revalidated; market/token/time, closed/status, and unique exact 1/0 winner must agree | Ambiguous or delayed results remain pending and are never inferred from last price |
| Durable restart and tamper detection | Proven for paper inputs | fsync append, sequence/hash chain, checkpoint, replay, plan binding, tamper/truncation/symlink tests | This is not future exchange open-order reconciliation |
| Delayed resolution recovery closes the product workflow | Proven offline end to end | `paper:settle -> paper:finalize -> paper:report -> paper:cohort-observability-report`; one integration test covers initial pending, recovered acceptance, final-result selection, report export, runtime/journal observability replay, no-overwrite, and a missing outer `result.json` only when the durable runtime summary proves clean paper-only completion | A post-plan-binding delayed-resolution public case has not occurred yet |
| Logs and research exports | Proven | Runtime NDJSON/metrics, journal, result JSON, `paper:inspect`, `paper:report` summary/per-market CSV, PnL-only `paper:cohort-report`, and replay-verified `paper:cohort-observability-report` for stream/settlement/execution quality | Static dashboards are offline snapshots; all cohort results remain descriptive |
| Target selection cannot be silently changed during reporting | Proven in current code and one public run | `RUN_PLAN` is the first post-header journal record and binds run ID, target count/window, and collector commit; report compares it to artifacts; the 2026-07-16 run replayed 479 records with a matching plan and journal tail | The earlier accepted public run is explicitly `LEGACY_UNBOUND` |
| No credentials or real orders | Proven structurally and at runtime | No `ExecutionEngine` implementation exists; runtime safety counters are all false/zero and acceptance verifies them | The domain keeps a future `ExecutionEngine` interface, which is not an executable adapter |
| Strategy profitability | Not proven | Final Test: J is only slightly positive in base and negative under stress/concentration removal; K is negative in base and stress | No tuning on Final Test; no shadow/live promotion |
| L adaptive research candidate | Rejected at historical gate | Separate Python-only V1 has dynamic execution edge, volatility drag, dynamic anchor band and depth/reprice-risk proxies; TRAIN is -20.66 and frozen VALIDATION is -1,287.05 | No verified historical Chainlink boundary series or continuous CLOB quote velocity; L does not enter real-time paper/shadow/live and leaves Final Test closed |

## Reference-engine lessons: adopted versus deferred

| Reference lesson | Current disposition |
|---|---|
| Per-market lifecycle state machine | Adapted in `kj-paper-engine-v2` |
| Unified strategy context | Adapted with explicit market, book, signal, fee, and receive-time evidence |
| Wallet balance/position/order reservation | Adapted for independent paper wallets |
| Append-only NDJSON and dashboard loop | Adapted as runtime NDJSON, durable journal, inspection, and report CLI |
| Crash recovery that stops risk expansion | Adapted for paper inputs and pending intent release |
| Private user-order channel and exchange reconciliation | Deliberately deferred; there is no private channel or live adapter |
| JavaScript number money and `Date.now` as the only clock | Rejected; exact decimal money and ReceiveStamp/source/server/receive/decision times are used |
| Array-position outcome mapping, unofficial result, unbounded retry | Rejected; label/token identity, official exact response, and bounded loops are required |

## Current verification

```text
Python: 205 passed
Node/TypeScript: 137 passed
Ruff: passed
TypeScript typecheck: passed
git diff --check: passed
CLI help: paper:mvp, paper:signal-compare-mvp, paper:signal-compare-report, paper:campaign-plan, paper:settle, paper:finalize, paper:report, paper:cohort-report, paper:campaign-cohort-report, paper:cohort-observability-report, paper:campaign-cohort-observability-report, paper-l-adaptive passed
```

The report keeps an explicit `pnlReconciliationResidual` for the aggregate
per-market PnL versus final-wallet subtraction. It only accepts an absolute
residual at or below `1e-60`, and separately requires the accepted result's
final cash/net PnL to match the wallet. This records finite decimal operation
ordering dust without weakening the report's accounting gate.

K now has a separate 180-second, journaled input warmup: `WARMUP_SIGNAL`
records replay into EWMA only and are rejected after a market session starts.
They cannot create a market, intent, wallet event, or settlement candidate, and
one journal rejects a Binance/Chainlink source-family change. This replaces the
invalid practice of using a pre-target market session as implicit K warmup.

Accepted public artifact (pre-plan-binding code):

- Run: `/root/polymarket-money-data/paper-mvp/kj-paper-20260716194322-59e2d360`
- Runtime collector commit: `476f21f2ea62091decb194add3a8737aeb63e7cd`
- Result: `accepted=true`, one target market, zero credentials/private channel/orders
- Replay report: `/root/polymarket-money-data/kj-paper-report-20260716194322-v3`
- Report artifact hash: `ea4d4b952a0835c988e12d97c0a1c7954119023277cf27cf30cf9dcf9fc98a02`
- Evidence status: `DESCRIPTIVE_PAPER_ONLY_LEGACY_UNBOUND_PLAN`

Accepted public artifact (plan-bound multi-market code):

- Run: `/root/polymarket-money-data/paper-mvp/kj-paper-20260716225739-48ff7c99`
- Runtime collector commit: `76131eb4b09af4509266d6bb9db8e0f409631ad2`
- Plan: 3 targets, 2026-07-16 23:00--23:15 UTC, hash-chained before contexts
- Result: `INITIAL`, `accepted=true`, `planBinding=HASH_CHAINED`, 3/3 targets
  settled, 479 journal records, no pending risk, and zero credentials/private
  channel/orders
- Replay report: `/root/polymarket-money-data/kj-paper-report-20260716225739-48ff7c99`
- Report: `DESCRIPTIVE_PAPER_ONLY`, `profitabilityClaimEligible=false`, artifact
  hash `6fb04978225a1680c5e747d8b8b2544111e650fafc197e4b163525608d38d775`

Accepted public artifact (second plan-bound multi-market code):

- Run: `/root/polymarket-money-data/paper-mvp/kj-paper-20260717011239-edcb5933`
- Runtime collector commit: `e6b27806a7ced5f2748bf4ff89b76797e65d76d1`
- Plan: 3 targets, 2026-07-17 01:15--01:30 UTC, hash-chained before contexts
- Result: `INITIAL`, `accepted=true`, `planBinding=HASH_CHAINED`, 3/3 targets
  settled, 505 journal records, no pending risk, terminal failure, credentials,
  private channel, or real orders
- Replay report: `/root/polymarket-money-data/kj-paper-report-20260717011239-edcb5933`
- Report: `DESCRIPTIVE_PAPER_ONLY`, `profitabilityClaimEligible=false`, artifact
  hash `15f776e2e972401cff33a3030889b728738018ac08232f0b3e260d307c061c30`

Current descriptive cohort:

- `/root/polymarket-money-data/kj-paper-cohort-two-runs-20260717`
- 2 non-overlapping plan-bound runs, 6 markets; cohort hash
  `cba4f224237d0cd6a1c3984c1114920b101bc66a0e6cdd35e262c42417bc0410`
- `profitabilityClaimEligible=false`; it neither establishes profitability nor
  changes J/K parameters.

Current descriptive operational cohort:

- `/root/polymarket-money-data/kj-paper-cohort-observability-two-runs-20260717`
- 2 replay-verified runs, 6 target markets; report hash
  `e4cd5370760da77e75caccbf0e4ed308dbd619aa3f83deee41dbc1d391f46a4d`
- Reopens each journal and cross-checks runtime-summary hashes, tail, record and
  event counts before aggregating public-stream counters, official-settlement
  delay and J/K execution outcomes. It is permanently descriptive paper evidence.

Future formal campaigns must use `paper:campaign-plan`, campaign-bound `paper:mvp`
runs plus the matching `paper:campaign-cohort-report` and
`paper:campaign-cohort-observability-report`; no such public campaign has yet been
collected. The two existing plan-bound runs predate this v2 binding and remain
descriptive PnL/observability cohorts only.

The delayed-resolution recovery integration test uses a v2 campaign-bound run:
it verifies journal recovery, `paper:finalize`, `paper:report`, and report
campaign binding remain intact after the original finite wrapper has no result.

## Next evidence gate

The first plan-bound three-market gate has passed.  Subsequent bounded runs
should accumulate an independently precommitted multi-market sample and record
connection stability, official-resolution delay, fills/no-fills and PnL
distribution without parameter changes. `paper:cohort-report` aggregates only
the PnL distribution, while `paper:cohort-observability-report` independently
rechecks runtime/journal evidence and aggregates quality metrics. Both reject
duplicate/overlapping inputs and never make a profitability claim. Every run
must still meet all of the
following, not merely process exit zero:

1. `resultKind=INITIAL`, `accepted=true`, and `planBinding=HASH_CHAINED`;
2. exactly three observed and completed target markets, with no other unsettled
   market or pending intent;
3. collector commit, target cutoff, journal path, and runtime mode match the
   hash-chained plan;
4. terminal failure is null and credential/user-channel/order counters are zero;
5. `paper:report` returns `planBinding=HASH_CHAINED`, verifies all settlement/PnL
   identities, and produces stable source/CSV/artifact hashes;
6. results remain descriptive paper evidence and do not authorize parameter
   selection, shadow, or live trading.

If official resolution exceeds the bounded window, only this recovery chain is
allowed:

```text
paper:settle -> paper:finalize -> paper:report
```
