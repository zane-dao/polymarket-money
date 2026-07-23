---
name: dataset-integrity
description: Audit or implement Polymarket and Binance research datasets in polymarket-money for point-in-time correctness, timestamp semantics, continuity, schema integrity, and future-data leakage. Use for ingestion, normalization, replay datasets, manifests, validation, and data-quality reports. Do not use for UI-only work.
metadata:
  version: "1.1.0"
---

# Dataset integrity

Incorrect or unverifiable data is a failed result, not a cosmetic warning.

## Checks

1. Separate provider event time, provider server time, local wall-clock receive time, and local monotonic receive order.
2. Store timestamps in UTC ISO 8601 where human-readable timestamps are required; preserve raw source values when needed for audit.
3. Preserve source, schema version, connection ID, receive ordinal, reconnect boundary, and raw-event reference.
4. Detect gaps, duplicates, out-of-order events, clock regressions, impossible spreads, crossed books, and reconnect discontinuities.
5. Reject future-data leakage and transformations using information unavailable at the strategy decision timestamp.
6. Mark empty, one-sided, stale, or identity-ambiguous order books as untradeable.
7. Verify market identity, token mapping, condition ID, resolution window, market rotation, and BTC-only scope where required.
8. Make parsing, normalization, hashes, manifests, and replay ordering deterministic.
9. Keep I/O in adapters and keep validation logic independently testable.
10. Add focused regression tests for every discovered failure mode.

## Verdicts

- `PASS`
- `FAIL`
- `DATA_INSUFFICIENT`

## Output

- Verdict
- Evidence and affected records
- Severity and blast radius
- Minimal remediation
- Tests added or run
- Remaining uncertainty
