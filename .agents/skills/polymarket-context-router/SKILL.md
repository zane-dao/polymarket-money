---
name: polymarket-context-router
description: Route polymarket-money planning, documentation, handoff, batch, architecture, context-recovery, and multi-document tasks to the smallest sufficient sources. Use when work crosses files or requires CURRENT, decisions, specs, reports, or durable project state. Do not use for narrow file-local edits.
---

# Polymarket context router

Use this Skill only after a task becomes cross-cutting. The Hook already supplies a deterministic primary route, so do not repeat repository discovery.

## 1. Start with the smallest evidence surface

For a narrow implementation task, use the named files and nearby tests. Do not read `docs/INDEX.md`, `docs/plan/CURRENT.md`, or this Skill merely because they exist.

For cross-cutting work:

1. Reuse the route injected by `.codex/hooks/context_orchestrator.py`.
2. Read at most the route's listed documents initially.
3. Follow one direct link at a time. Never scan sibling directories wholesale.
4. Load `docs/plan/CURRENT.md` only when current scope, authorization, next step, blocker, or active Batch matters.
5. Load a decision, specification, architecture document, handoff, or report only when the task changes or verifies that exact subject.

See [references/routing.md](references/routing.md) for the route map.

## 2. Apply source authority

Use this precedence:

1. Current user instruction and repository safety rules.
2. Current code, schemas, and verification results.
3. Canonical repository documents.
4. Accepted decisions and active Batch artifacts.
5. Private generated checkpoints.

A checkpoint can recover interrupted intent, but it never overrides code or canonical docs.

## 3. Keep context cache-friendly

- Reuse already-read documents while the route and file fingerprint are unchanged.
- Do not generate a fresh summary every turn.
- Do not paste long document excerpts into chat when a path and focused read are sufficient.
- Use `#ctx:refresh` only when the user intentionally wants a route refresh.
- Use `#ctx:none` to suppress prompt-route injection for one turn.

## 4. Separate implementation memory from semantic truth

Ordinary edits, failed experiments, commands, and temporary debugging belong only in the private checkpoint. Durable state belongs in the existing canonical home and is reviewed through `$polymarket-memory-maintainer` only when the Stop gate requests it or the user explicitly asks for persistence.
