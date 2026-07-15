# Repository instructions

These rules apply to the entire repository.

## Project context

- Long-lived project goals, scope, decisions, session summaries, and handoffs live in
  `/root/projects/polymarket-codex-sessions/`.
- Before broad project work, read its `INDEX.md`, then follow its progressive-disclosure routing.
- Keep session transcripts and general project memory out of this code repository. This repository
  contains code, tests, and code-related engineering documentation only.

## Instruction precedence and batch documentation

- A newer explicit user instruction supersedes older repository guidance unless it conflicts with
  a higher-level safety rule or verified fact. Update or clearly supersede stale documentation in
  the same task so future sessions do not load two active rules.
- From Batch 2 onward, design and result documents belong under
  `docs/batches/batch-XX-topic/`; tests, environment, Git diff, and verification evidence belong
  under `reports/batches/batch-XX/`.
- The canonical per-batch handoff is `HANDOFF-BATCH-XX.md`. External review packs belong at
  `~/review-packs/polymarket-money/batch-XX/`, outside this repository, and contain only the
  handoff by default. Never copy source, raw data, credentials, databases, or large artifacts into
  a review pack.

## Safety boundary

- Keep `LIVE_TRADING_ENABLED=false` unless a future, explicit, reviewed task
  changes the operating mode.
- Do not read or request real private keys, seed phrases, API keys, cookies, or
  production credentials.
- Do not submit, cancel, or simulate submitting a real exchange order.
- Do not add network calls to strategy modules.
- Treat `/mnt/d/polymarket-paper`, `/mnt/c/Users/seeta/Desktop/hello-world`, and
  `/root/projects/olymarket-trade-engine` as read-only references.
- Migrate code only in a separately approved task and only after inventory,
  provenance, license, and behavior review.

## Design rules

- Domain types must not depend on vendor SDKs.
- External I/O must be isolated behind adapters.
- Strategy functions must be deterministic and receive every input explicitly.
- Store all timestamps as UTC ISO 8601 strings and use the canonical timestamp
  field names from `execution/src/domain`.
- New execution behavior requires unit tests plus an appropriate replay,
  integration, golden, or shadow test.
