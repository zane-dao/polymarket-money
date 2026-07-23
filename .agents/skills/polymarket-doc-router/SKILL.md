---
name: polymarket-doc-router
description: Route substantive work in zane-dao/polymarket-money to the minimum required repository documents before coding. Use for implementation, refactoring, debugging, architecture, batch work, release work, or documentation updates. Do not use for trivial repository-independent questions.
metadata:
  version: "1.1.0"
---

# Polymarket document router

Load the smallest authoritative context set. Do not scan the whole documentation tree.

## Required sequence

1. Read the repository-root `AGENTS.md` and obey it.
2. For every substantive task, read these three documents completely:
   - `docs/INDEX.md`
   - `docs/goals/PROJECT-GOALS.md`
   - `docs/plan/CURRENT.md`
3. Read `docs/background/` only for first-entry work, historical reconstruction, unclear domain context, or when an index explicitly routes there.
4. If the task belongs to a Batch, read `docs/batches/BATCHES-INDEX.md` and the relevant Batch document.
5. Read `docs/decisions/DECISIONS.md` when the task depends on, changes, or creates a cross-session architectural or product decision.
6. Follow links from indexes. Do not bulk-load archives or unrelated documents.
7. State which documents were loaded and extract only binding constraints relevant to the task.
8. Flag missing, contradictory, or stale guidance. Do not invent a rule to fill the gap.

## Documentation updates

- Keep current state in `docs/plan/CURRENT.md` as a concise present-tense snapshot.
- Append durable cross-session decisions to `docs/decisions/DECISIONS.md`; do not silently rewrite decision history.
- Update the relevant Batch document when Batch scope or evidence changes.
- Do not create files or folders at repository root without explicit user approval.
- Prefer links over duplicated facts and archive old session detail instead of endlessly appending it.

## Output

- Documents read
- Binding constraints
- Conflicts or missing guidance
- Work/documents that should change
