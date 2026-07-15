# Migration policy

No legacy code is migrated during repository initialization.

## `polymarket-paper` assessment sequence

1. Inventory entry points, dependencies, configuration, data formats, and tests
   without writing to the old repository.
2. Identify observable behavior worth preserving with fixtures and golden tests.
3. Classify each module as reuse, rewrite, replace, or retire.
4. Map vendor-neutral concepts to the new domain contracts.
5. Move one bounded capability at a time only after an approved migration task.
6. Compare replay outputs before and after each move.

Do not bulk-copy the repository. Do not import secrets, local databases,
generated data, or environment files.

## `polymarket-trade-engine` assessment sequence

1. Review license, version, maintenance activity, release process, and supported
   exchange operations.
2. Inspect its public interfaces, signing boundary, retries, idempotency,
   WebSocket recovery, error model, and test coverage.
3. Run it only in an isolated test configuration with fixtures or mocked
   transports.
4. Compare its types with this repository's vendor-neutral adapter contract.
5. Decide whether to wrap, fork, selectively reuse, or reject it; record the
   decision and provenance before implementation.

## Acceptance gate

A migrated capability needs deterministic unit tests, replay or golden evidence,
documented failure behavior, and confirmation that live trading remains disabled.

