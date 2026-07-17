# Batch 06: Chainlink provisional settlement design

## Status and scope

This is a design contract only.  No preliminary Chainlink or relay observation
currently changes a K/J paper wallet, releases a reservation, calculates final
PnL, or moves a market to `DONE`.

The current final-settlement contract remains unchanged: a durable raw Gamma
response must pass market/token/time identity checks, show a closed market with
`umaResolutionStatus=resolved`, and contain one exact `1`/`0` winner before the
engine accepts `OFFICIAL_RESOLUTION`.

The runtime receives a Polymarket RTDS stream named `chainlink`, while the
market declaration currently identifies a Chainlink BTC/USD stream as its
resolution source.  This repository has **not** proven that a received relay
frame is the canonical value used for an individual market's exact opening or
closing boundary.  Until that protocol question is independently verified,
the only safe name for a derived observation is
`PRELIMINARY_RELAY_OBSERVED`, not "official Chainlink settlement".

## Proposed observation state

```text
UNAVAILABLE
  -> OPEN_ANCHOR_OBSERVED
  -> CLOSE_BOUNDARY_OBSERVED
  -> PRELIMINARY_UP | PRELIMINARY_DOWN
  -> MATCHED_FINAL | MISMATCHED_FINAL | FINAL_UNAVAILABLE
```

`PRELIMINARY_*` is informational.  It is not a settlement transition.  Gamma
final evidence is always required to produce `MATCHED_FINAL` or
`MISMATCHED_FINAL`, and only the existing Gamma path may settle the paper
engine.

## Evidence required per boundary candidate

Any future implementation must retain, with the candidate rather than merely
logging it:

- market ID, condition ID, slug, token IDs, exact interval start/end, and the
  market's declared resolution source;
- boundary role (`OPEN` or `CLOSE`), the original frame bytes/hash, exact price
  lexeme, source/server/receive times, `ReceiveStamp`, and connection ID;
- the deterministic selection rule, visibility rule, and the reason a frame was
  accepted, rejected, duplicated, or conflicted.

Repeated identical frames may be idempotent.  Conflicting values, a missing
boundary, an identity mismatch, an impossible or future timestamp, or an
ambiguous selection rule must become `UNAVAILABLE`/`CONFLICT`; no code may
substitute a nearby last price.  The `end >= start => Up` tie rule may be used
only after the individual market's official rule text has been preserved and
verified.

## Durability and safety requirements

If this design is implemented, it needs a new append-only journal payload such
as `CHAINLINK_BOUNDARY`, a deterministic replay-only preliminary state, and
tests for duplicate, conflict, missing-boundary, final mismatch, and recovery.
That payload must never call `engine.settle()`.

The final report may record preliminary/final agreement and Gamma-resolution
delay as observability metrics.  It must not turn agreement into a presumed
100% accuracy rate or a profitability claim.

## Preconditions for implementation

Before a real adapter is added, recheck the current official market rules and
the exact public data contract for the declared Chainlink stream.  Then bind
the chosen boundary semantics to a versioned configuration and add a separate
runtime/report contract.  This work is deliberately separate from
`L_ADAPTIVE_EXECUTION`: the current historical receipt does not contain a
verified historical Chainlink boundary series or its receive-time evidence.
