# Semantic write-back targets

| Durable change | Existing target |
|---|---|
| Current phase, next step, blocker, authorization | `docs/plan/CURRENT.md` |
| Cross-session accepted choice | `docs/decisions/DECISIONS.md` or existing decision file |
| Stable must/must-not, interface, invariant | Existing specification |
| Active Batch scope or handoff | Matching `docs/batches/.../HANDOFF-BATCH-XX.md` |
| Verified completion or test evidence | Matching `reports/batches/...` report |
| Superseded long living detail | Dated archive plus shortened source and repaired index |

Quality gate:

1. The statement is durable.
2. The target is the unique existing authority.
3. The edit removes or replaces stale text rather than duplicating it.
4. Evidence is linked or reproducible.
5. No secret, raw transcript, or bulky machine output is added.
