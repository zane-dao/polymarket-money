# Batch 4B-R2 final test results

Result: all code and remediation tests passed. This does not override the observation verdict
`INCOMPLETE_EVIDENCE`.

| check | result |
|---|---|
| Python full suite | 190/190 passed |
| Ruff | passed |
| clean venv editable install with `.[dev]` | passed |
| clean venv pytest | 190/190 passed |
| clean venv Ruff | passed |
| clean venv `pip check` | no broken requirements |
| `npm ci` | 5 packages audited, 0 vulnerabilities |
| Node full suite | 95/95 passed |
| TypeScript `--noEmit` | passed |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `git diff --check` | passed |

The first clean venv attempt installed only runtime dependencies with `pip install -e .`; invoking
pytest then failed with the exact environment error `.../bin/pytest: No such file or directory`.
The authoritative clean run used the declared `dev` extra at
`/tmp/polymarket-money-r2-clean-venv-dev-20260716` and passed all checks.

R2 remediation coverage includes:

- current Gamma numeric fee lexeme preservation without binary float;
- public socket AbortSignal shutdown;
- market-window exclusion before fee/opportunity evaluation;
- settled-market working-history retirement while preserving immutable grid evidence;
- single-session proxy-aware runner fallback and process-group stop;
- frozen config/hash, 252-cell grid, metrics-only/raw=false and safety gates.
