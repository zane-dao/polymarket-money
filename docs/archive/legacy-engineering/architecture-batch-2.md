# Architecture

## Goal

The system separates reproducible research, deterministic decisions, risk
approval, and side-effecting execution. Batch 1 adds an offline Python reference
for domain rules, fail-closed client creation, and fill-level golden accounting.
Batch 2 adds only credential-free public data ingress, immutable raw storage,
manifest verification, and offline replay; there is still no trading transport.

## Dependency direction

```text
research artifacts -> domain -> strategy -> risk -> execution adapter
                         ^                    ^             |
                         +---- storage -------+---- monitoring
```

The domain layer is vendor-independent. Strategy code consumes immutable domain
snapshots and returns a decision. Risk independently approves, rejects, or
resizes that decision. Only adapters may perform external I/O.

## Time model

The Batch 1 Python models use aware UTC `datetime` values and explicit causal
names: `source_time`, `server_time`, `receive_time`, `decision_time`,
`order_send_time`, `fill_time`, and `settlement_time`. They contain no generic
`timestamp` field. See `docs/domain-model.md` for the normative definitions.

The versioned Batch 2 wire contract uses required snake-case lifecycle fields:
`source_time`, `server_time`, `receive_time`, `process_time`, and `persist_time`.
Source/server time are required-but-nullable and are never fabricated. The
execution-domain scaffold has also been converged to source/server/receive/process/
persist names; its external prices, sizes, and fees are decimal strings rather
than unqualified IEEE-754 numbers.

For RTDS, outer provider milliseconds map to `server_time` and payload
milliseconds map to `source_time`. The CLOB public `timestamp` remains in the
raw payload because current official documentation does not define equivalent
source-clock semantics. See the Batch 2 data-contract document.

## Execution modes

Future adapters may implement replay, paper, shadow, and live modes behind the
same `ExecutionEngine` interface. Live mode must remain unavailable while
`LIVE_TRADING_ENABLED=false`. Adding a live adapter requires a separate design
and security review.

## Data flow

1. A public adapter captures raw bytes/text and `receive_time` before parsing.
2. Immutable JSONL plus a verified manifest becomes the only replay input.
3. Python validates, reports quality, and produces point-in-time inputs in later batches.
4. A pure strategy creates a `SignalDecision` only after a separately approved batch.
5. Risk and execution remain structurally disconnected from Batch 2 collectors.
