# Batch 4B tests

- `npm test`: 53/53 Node tests passed, including opportunity contract tests.
- TypeScript compilation: passed.
- Batch 1–4A Python suite: 182/182 passed (`.venv/bin/python -m pytest -q`, 3.27s).
- Reuse Gate: no second replay, order book, FillLedger, raw writer or safety configuration
  introduced.
- Raw policy: complete short capture stopped by duration; `/mnt/d` was not used.
- Metrics policy: no raw segments in metrics mode.
- Opportunity policy: stale/disconnected books fail closed; unknown fee gives zero executable
  size; maker gives zero fills and unknown queue position; no live client or order call exists.
