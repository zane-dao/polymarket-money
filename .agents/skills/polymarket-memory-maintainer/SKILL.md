---
name: polymarket-memory-maintainer
description: Review a completed polymarket-money change for rare durable semantic write-back, reversible archival, and duplicate-state prevention. Use only when explicitly invoked by the Stop hook or the user for CURRENT, handoff, decisions, specs, Batch evidence, archival, or compression.
---

# Polymarket semantic memory maintainer

This Skill is explicit-only. A private checkpoint has already captured ordinary implementation detail. Perform one focused semantic review and then stop.

## 1. Decide whether durable truth changed

A semantic write is justified only when at least one item changed:

- active project state, next step, blocker, ownership, or authorization;
- accepted architecture, public interface, invariant, safety boundary, or cross-session decision;
- active Batch scope, acceptance criteria, completion state, or canonical handoff;
- validated evidence that changes completion confidence;
- a superseding decision that makes a living document materially stale.

Do not write semantic memory for ordinary code edits, transient debugging, failed experiments, repeated status, raw chat, or tool logs.

## 2. Read only the existing target

Use the changed paths and route from the continuation prompt. Read the exact existing canonical document that owns the fact. Do not scan the entire docs tree.

## 3. Choose one write pattern

- **Overwrite:** replace a stale section in `CURRENT.md`, a handoff, or a living spec. Do not append duplicate status.
- **Update:** revise the matching accepted decision, invariant, architecture section, or contract.
- **Append evidence:** add a concise, verifiable entry to the existing Batch report.
- **Add:** create a new decision or spec only when no correct existing home exists.
- **Archive then shorten:** copy the complete original to a dated archive, shorten the active document, and repair index links in the same change.
- **No semantic write:** leave the private checkpoint as the only memory.

## 4. Preserve evidence and cacheability

Never compress accepted decisions or evidence reports merely to save tokens. Never append a full session summary to `AGENTS.md` or `CURRENT.md`. Keep active documents answer-first and stable so their prefixes change only when durable truth changes.

See [references/writeback.md](references/writeback.md) for target rules.
