# Route map

| Route | Start locally | Canonical documents only when needed | Typical durable target |
|---|---|---|---|
| context-memory | Target document or policy file | `docs/INDEX.md`, `CURRENT.md`, operations guide | Existing living section, decision, handoff, or report |
| paper-runtime | Affected backend/strategy/script and tests | Current scope and active Batch design | Existing spec, handoff, or Batch evidence |
| domain-contracts | Domain, adapter, risk, or contract file and tests | Architecture, project spec, accepted decisions | Matching spec or decision |
| frontend-desktop | Component, screen, Tauri command, bridge, and tests | Architecture for cross-language boundaries | Existing architecture or Batch handoff |
| research-data | Named strategy, dataset, experiment, or notebook | Current Batch and matching report | Validated report, not CURRENT by default |
| validation | Affected tests and acceptance criteria | Reports index and matching Batch report | Concise evidence append |
| public-polymarket-protocol | Public fact needed by local code | Project spec and paper boundary | Usually no semantic write |

Rules:

- One primary route and at most one supporting route.
- Route change or source-document change permits reinjection. An unchanged route emits nothing.
- Public protocol work may explicitly invoke `$web3-polymarket`, but the repository remains read-only and paper-only.
