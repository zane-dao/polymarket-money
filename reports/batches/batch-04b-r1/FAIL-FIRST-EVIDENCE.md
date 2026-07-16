# Batch 4B-R1 fail-first evidence

每节记录实现前的真实失败。后续实现提交不得删除这些失败证据。

## Group 1 — ReceiveStamp and raw-event-v2

Fail-first commit input: `tests/unit/receive-time-r1.test.ts`。

Command:

```text
npm test
```

Expected failure observed:

```text
tests/unit/receive-time-r1.test.ts(9,8): error TS2307: Cannot find module '../../execution/src/domain/receive-time.js' or its corresponding type declarations.
tests/unit/receive-time-r1.test.ts(11,3): error TS2724: '"../../execution/src/domain/raw-event.js"' has no exported member named 'createEnvelopeDraftV2'. Did you mean 'createEnvelopeDraft'?
tests/unit/receive-time-r1.test.ts(13,3): error TS2305: Module '"../../execution/src/domain/raw-event.js"' has no exported member 'requireSubsecondReceiveStamp'.
```

This proves the reviewed baseline had no comparable ReceiveStamp contract, no active raw-event-v2
constructor, and no guard preventing v1 records from entering subsecond work.

## Group 2 — RuntimeIncident and terminal fallback

Fail-first input: `tests/unit/runtime-incidents-r1.test.ts`。The test requires a structured incident
contract, a fail-closed runtime controller, and a one-shot emergency receipt path. These symbols do
not exist on the reviewed baseline; `npm test` must fail at TypeScript compilation before the
implementation commit.

Observed failure:

```text
tests/unit/runtime-incidents-r1.test.ts(10,8): error TS2307: Cannot find module '../../execution/src/runtime/incidents.js' or its corresponding type declarations.
tests/unit/runtime-incidents-r1.test.ts(43,36): error TS7006: Parameter 'receipt' implicitly has an 'any' type.
tests/unit/runtime-incidents-r1.test.ts(44,19): error TS7006: Parameter 'line' implicitly has an 'any' type.
tests/unit/runtime-incidents-r1.test.ts(45,19): error TS7006: Parameter 'code' implicitly has an 'any' type.
tests/unit/runtime-incidents-r1.test.ts(65,19): error TS7006: Parameter 'line' implicitly has an 'any' type.
tests/unit/runtime-incidents-r1.test.ts(66,19): error TS7006: Parameter 'code' implicitly has an 'any' type.
```

## Group 3 — Decimal reuse and unified fee/edge

Fail-first inputs are the shared `fee-edge-v1.json` fixture plus TypeScript and Python contract
tests. The reviewed baseline has no `decimal.js` dependency, no private MoneyDecimal wrapper, no
single FeeEdgeCalculator, and no Python fee evidence/status fields. Both language suites must fail
before implementation.

Observed failures:

```text
tests/unit/fee-edge-r1.test.ts(5,21): error TS2307: Cannot find module 'decimal.js' or its corresponding type declarations.
tests/unit/fee-edge-r1.test.ts(9,8): error TS2307: Cannot find module '../../execution/src/runtime/fee-edge.js' or its corresponding type declarations.
tests/unit/fee-edge-r1.test.ts(10,64): error TS2307: Cannot find module '../../execution/src/domain/money.js' or its corresponding type declarations.

ImportError: cannot import name 'FeeEvidenceStatus' from 'research.polymarket_money.backtest'
```

## Group 4 — Opportunity observation and route evaluation separation

Fail-first input: `tests/unit/opportunity-observation-r1.test.ts`. It requires the immutable,
versioned and canonically hashed `OpportunityObservationV1` fact contract plus a separate
`RouteEvaluationV1` aggregate whose only current decision is `DATA_INSUFFICIENT`. The reviewed
baseline has only mutable-shallow ad-hoc opportunity records and no such module, so TypeScript
compilation must fail before implementation.

Observed failure:

```text
tests/unit/opportunity-observation-r1.test.ts(9,8): error TS2307: Cannot find module '../../execution/src/domain/opportunity-observation.js' or its corresponding type declarations.
```

## Group 5 — Cross-venue lead-lag causal contract

Fail-first input: `tests/unit/lead-lag-r1.test.ts`. It requires the frozen four-source 252-cell grid,
strict ReceiveStamp baseline and fixed-horizon as-of queries, explicit external and Polymarket
connection identities, reconnect censoring, a separate next-update metric, quality gates,
replay/runtime equivalence, and versioned 500ms episodes. The reviewed baseline has no common
`LeadLagEngine` or `EpisodeTracker`; it only compares adjacent spot values in the display loop.

Observed failure:

```text
tests/unit/lead-lag-r1.test.ts(12,8): error TS2307: Cannot find module '../../execution/src/runtime/lead-lag.js' or its corresponding type declarations.
tests/unit/lead-lag-r1.test.ts(128,36): error TS7006: Parameter 'item' implicitly has an 'any' type.
tests/unit/lead-lag-r1.test.ts(243,45): error TS7006: Parameter 'item' implicitly has an 'any' type.
```

## Group 6 — Active ReceiveClock and raw-event-v2 wiring

Fail-first input: `tests/unit/runtime-wiring-r1.test.ts`. It requires HTTP and WebSocket receive
boundaries to expose stamps from one shared `ReceiveClock`, and requires the active
`RawSegmentWriter` to accept only v2 drafts while v1 remains read-only. The baseline public runtime
has no `receiveClock`/`receiveStamp`, and the writer is typed exclusively for v1.

Observed failures include:

```text
tests/unit/runtime-wiring-r1.test.ts(45,5): error TS2353: 'receiveClock' does not exist in type 'PublicSocketRuntime'.
tests/unit/runtime-wiring-r1.test.ts(75,25): error TS2339: Property 'receiveStamp' does not exist on type 'PublicHttpResponse'.
tests/unit/runtime-wiring-r1.test.ts(95,25): error TS2345: Argument of type 'RawEventEnvelopeDraftV2' is not assignable to parameter of type 'RawEventEnvelopeDraftV1'.
```

## Group 7 — Runtime contract integration and explicit error disposition

Fail-first input: `tests/unit/runtime-integration-r1.test.ts`. It statically guards the active
runtime boundary against regressions to the adjacent-spot 5bp observer, duplicate arithmetic,
provider-time "receive latency" labels, and empty catch blocks. It also requires the actual runtime
to reference the frozen lead-lag, exact fee, immutable observation and fail-closed incident
contracts. The baseline runtime does not reference any of these R1 contracts.

Observed test failures:

```text
not ok - live runtime is wired to the frozen R1 contracts (missing LeadLagEngine)
not ok - legacy observers delegate exact money and fee calculations (missing FeeEdgeCalculator)
not ok - active capture and runtime paths contain no empty catch disposition (scripts/live-runtime.ts)
```

### Group 4 follow-up — explicit provenance and eligibility fields

The final frozen-contract audit found that the first Group 4 test proved generic provenance but did
not require explicit `git_commit`, `session_id`, fee evidence, continuity, eligibility and rejection
fields. The strengthened test is committed before the schema hardening; against the prior
`OpportunityObservationV1` interface it fails TypeScript excess/missing-field checks and has no
`observation_id` member. The implementation commit must make those fields schema-required rather
than hiding them in the generic facts object.

### Group 4 follow-up — legacy single-record route label

The final unique-path audit also found that the compatibility `observeCompleteSet` export still
returned `RESEARCH_CANDIDATE` from one quote. Although the R1 live runtime no longer imports that
module, an exported single-record route conclusion violates the frozen contract. The strengthened
legacy test requires `OBSERVED_NOT_EXECUTABLE`; it fails against the prior implementation until the
route-level label is removed.

## Second Sol Critical follow-up A — causal runtime evidence

The read-only re-review found that the first implementation did not yet make the horizon record a
self-contained causal artifact, did not invalidate a previous good Polymarket state after a later
rejected frame, could revive an A episode after an A -> B -> A market transition, and did not bind
opportunity output to a versioned runtime configuration. The strengthened tests also require causal
input-lineage watermarks, canonical-string-only Gamma fee rates, explicit gross edge, real
lead-lag observations, and trigger output.

Observed fail-first TypeScript errors include:

```text
tests/unit/lead-lag-r1.test.ts: 'input_hash' does not exist in type 'ExternalPriceState'
tests/unit/lead-lag-r1.test.ts: Property 'external_event_id' does not exist on type 'HorizonObservation'
tests/unit/lead-lag-r1.test.ts: Property 'notePolymarketQualityFailure' does not exist on type 'LeadLagEngine'
tests/unit/opportunity-config-r1.test.ts: Cannot find module '../../execution/src/runtime/opportunity-config.js'
tests/unit/runtime-paper.test.ts: Property 'grossEdge' does not exist on type 'PaperAudit'
```

## Second Sol Critical follow-up B — offline raw-v2 and fee parity

The offline Python truth chain still imported only `RawEventEnvelopeV1`, so a collector-produced
raw-event-v2 segment could not pass manifest verification, replay, or normalization. A new
cross-language fixture boundary also freezes missing-fee and price-above-one behavior.

Observed fail-first Python collection failure:

```text
ImportError: cannot import name 'RawEventEnvelopeV2' from 'research.polymarket_money.raw_events'
```

Once collection reaches the fee test, the prior Python behavior also conflicts with the fixture:
it returns `Decimal("0")` / `UNKNOWN_FEE` for missing evidence and accepts a price above one,
whereas the frozen shared result is `None` / `MISSING_FEE_EVIDENCE` and fail-closed price bounds.

The reviewer then strengthened the horizon fail-first contract one step further: trigger-time
Polymarket lineage and horizon-state lineage are distinct named fields. A successful 50ms markout
must name the 640ms state input rather than only the 590ms trigger snapshot; a censor caused by a
rejected frame must name that rejected raw input. This prevents one ambiguous `polymarket_parent`
field from conflating two causal instants.

The live-artifact test also freezes serialization of fractional millisecond durations: safe integer
counts remain JSON numbers, while non-integer durations become canonical non-exponent decimal
strings before entering `facts`. Without this boundary a real sub-millisecond horizon age would
throw during observation hashing.

Offline raw-v2 verification is also required to reject cross-domain or non-increasing segment
ReceiveStamp order. The accepted same-nanosecond case is ordinal 1 then 2; reversing those lines
must fail before `RawReplay` can expose them.

The CLOB integration test finally freezes that only a successfully applied `book` or
`price_change` mutation can refresh the lead-lag book ReceiveStamp. Informational frames such as
`last_trade_price` must be raw-preserved but ignored for book freshness; a failed attempted book
mutation invalidates the previous state. The fail-first module did not exist before this guard.

## Second Sol Critical follow-up C — segment ordinal shadowing

The post-implementation read-only review found that the v2 ReceiveStamp loop reused the local name
`ordinal`, overwriting the manifest segment ordinal before `VerifiedSegment` construction. The
multi-segment fail-first test requires stored segment ordinals `[0, 1]` and replay order
`segment-0`, `segment-1`; the buggy implementation instead stores receive ordinals `[1, 2]`.

The same review found the offline data-quality report still labeled provider-clock minus local-wall
deltas as `receive_latency`. The v2 fail-first test requires explicit
`provider_source_to_local_wall_delta_ms` / `provider_server_to_local_wall_delta_ms` fields and
forbids the two legacy latency names; provider clocks cannot prove transport latency.

## Second Sol Critical follow-up D — single complete-set calculator path

The reviewer found that unknown-fee branches in `paper.ts` and `opportunities.ts` bypassed
`FeeEdgeCalculator` and hand-wrote gross edge. The fail-first guards forbid the helper/fallback,
require `MISSING` evidence in both modules, and use visible size 2 to prove the legacy opportunity
gross amount is `0.08` rather than the unscaled per-unit `0.04`.
