# Architecture

## Goal

The system separates reproducible research, deterministic decisions, risk
approval, and side-effecting execution. Batch 1 adds an offline Python reference
for domain rules, fail-closed client creation, and fill-level golden accounting;
the repository still has no exchange transport.

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

The earlier TypeScript scaffold uses UTC ISO 8601 strings and four ingest
envelope fields inside `timestamps`:

- `exchangeTimestamp`: time assigned by the exchange or source.
- `receiveTimestamp`: time the local ingress boundary received the event.
- `processTimestamp`: explicit time used by deterministic business logic.
- `persistTimestamp`: optional time at which durable storage committed it.

`exchangeTimestamp` maps to source time and `receiveTimestamp` maps to receive
time. `processTimestamp` and `persistTimestamp` describe future real-time ingest
and durability, not substitutes for decision/send/fill/settlement time. The
TypeScript schema must be aligned before a real-time control plane is added.

## Execution modes

Future adapters may implement replay, paper, shadow, and live modes behind the
same `ExecutionEngine` interface. Live mode must remain unavailable while
`LIVE_TRADING_ENABLED=false`. Adding a live adapter requires a separate design
and security review.

## Data flow

1. An adapter normalizes source data into domain records.
2. A pure strategy creates a `SignalDecision`.
3. The risk engine evaluates limits, freshness, connectivity, and idempotency.
4. An execution adapter accepts only a signal paired with its `RiskDecision`.
5. Storage and monitoring record decisions and outcomes using canonical times.
