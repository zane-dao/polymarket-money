---
name: strategy-plugin
description: Add or refactor a strategy in polymarket-money through the existing strategy contract with minimal new entities and low coupling. Use for creating, registering, configuring, versioning, testing, replaying, or displaying a strategy. Do not create a parallel framework unless the current contract is proven insufficient.
metadata:
  version: "1.1.0"
---

# Strategy plugin

Extend the existing contract. Do not grow a second architecture beside it.

## Workflow

1. Use `$polymarket-doc-router` first for substantive strategy work.
2. Inspect the existing strategy interface, registry, configuration schema, persistence model, replay path, and frontend presentation before designing changes.
3. Reuse existing entities and extension points. Add the smallest compatible abstraction only when evidence shows it is required.
4. Keep strategy logic deterministic and free of UI, database transport, exchange clients, filesystem, network, clocks, and execution side effects.
5. Put I/O and third-party integration in adapters.
6. Make parameters typed, validated, serializable, versioned, and describable for the frontend.
7. Return structured decisions with reason codes, inputs, probability/edge, eligibility, quantity intent, and explicit no-trade explanations.
8. Preserve compatibility with historical strategy versions and stored runs.
9. Add unit tests, contract tests, registry tests, config validation tests, and one representative point-in-time replay test.
10. Run `$dataset-integrity` and `$backtest-integrity` when the strategy consumes new data or changes execution/accounting assumptions.

## Output

- Existing extension point used
- Files changed
- Contract/schema changes, if any
- Tests and example configuration
- Compatibility impact
- Remaining limitations
