# Batch 06 K/J research and paper MVP completion audit

Audit date: 2026-07-17

Code branch: `batch/06-kj-paper-loop`

Audited implementation HEAD: `ce1d819`

## Decision

The current engineering MVP is runnable and replay-verifiable, but the broader
project goal is not complete.

- `MVP_ENGINEERING_COMPLETE`: historical K/J research and a bounded public-data
  paper loop connect market identity, signal, intent, delayed theoretical fill,
  wallet reservation, token position, official settlement, PnL, durable journal,
  recovery, finalization, and report export.
- `CURRENT_PLAN_BOUND_MULTI_MARKET_EVIDENCE_COMPLETE`: the approved bounded
  public run at collector commit `76131eb` recorded `RUN_PLAN` before context,
  settled exactly three targets, returned `accepted=true`, and produced a
  replay-verified `DESCRIPTIVE_PAPER_ONLY` report.  This is product-path
  evidence only, not profitability evidence.
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
| Delayed resolution recovery closes the product workflow | Proven offline end to end | `paper:settle -> paper:finalize -> paper:report`; test covers initial pending, recovered acceptance, final-result selection, and no-overwrite | A post-plan-binding delayed-resolution public case has not occurred yet |
| Logs and research exports | Proven | Runtime NDJSON/metrics, journal, result JSON, `paper:inspect`, `paper:report` summary and per-market CSV | No graphical dashboard is claimed by this CLI MVP |
| Target selection cannot be silently changed during reporting | Proven in current code and one public run | `RUN_PLAN` is the first post-header journal record and binds run ID, target count/window, and collector commit; report compares it to artifacts; the 2026-07-16 run replayed 479 records with a matching plan and journal tail | The earlier accepted public run is explicitly `LEGACY_UNBOUND` |
| No credentials or real orders | Proven structurally and at runtime | No `ExecutionEngine` implementation exists; runtime safety counters are all false/zero and acceptance verifies them | The domain keeps a future `ExecutionEngine` interface, which is not an executable adapter |
| Strategy profitability | Not proven | Final Test: J is only slightly positive in base and negative under stress/concentration removal; K is negative in base and stress | No tuning on Final Test; no shadow/live promotion |

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
Python: 200 passed
Node/TypeScript: 120 passed
Ruff: passed
TypeScript typecheck: passed
git diff --check: passed
CLI help: paper:mvp, paper:settle, paper:finalize, paper:report passed
```

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

## Next evidence gate

The first plan-bound three-market gate has passed.  Subsequent bounded runs
should accumulate an independently precommitted multi-market sample and record
connection stability, official-resolution delay, fills/no-fills and PnL
distribution without parameter changes.  Every run must still meet all of the
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
