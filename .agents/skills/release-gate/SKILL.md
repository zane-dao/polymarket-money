---
name: release-gate
description: Decide whether a polymarket-money build can be promoted to candidate or stable release using branch, commit, artifact, test, data, backtest, documentation, and rollback evidence. Use after substantive implementation, migration, refactoring, or bug fixing. Do not deploy, merge, push, or promote when evidence is missing.
metadata:
  version: "1.1.0"
---

# Release gate

A release is an evidence-backed immutable build, not merely the newest branch state.

## Checks

1. Read repository release and branch rules before assessing readiness.
2. Identify the source branch, exact Git commit, working-tree status, build command, artifact, configuration, and target environment.
3. Reject promotion when relevant changes are uncommitted, the artifact provenance is unknown, required checks fail, or generated files are stale.
4. Run repository-defined unit, integration, contract, type, lint, build, migration, and representative replay/smoke checks in the prescribed order.
5. Require `$dataset-integrity` and `$backtest-integrity` evidence when changes affect ingestion, normalization, strategy, simulation, accounting, settlement, or scoring.
6. Require `$live-simulation-review` evidence when changes affect real-time ingestion, paper execution, recovery, incidents, or cockpit state.
7. Keep development, candidate, stable, simulation, and production configuration separate. Never infer credentials or enable real trading.
8. Confirm schema compatibility, startup/shutdown behavior, health checks, observability, known limitations, and rollback instructions.
9. Record commit, artifact hash when available, checks, verdict, blockers, and rollback point.
10. Do not commit, push, open a PR, merge, deploy, or promote unless the user explicitly requests that separate action.

## Verdicts

- `READY_FOR_CANDIDATE`
- `READY_FOR_STABLE`
- `BLOCKED`
- `DATA_INSUFFICIENT`

## Output

- Verdict and target stage
- Source commit and artifact provenance
- Checks run and results
- Blocking issues
- Rollback point and release record
