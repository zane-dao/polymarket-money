# Batch 4B-R2 complete-set results

Classification: **NOT_OBSERVED** for positive fee-adjusted edge; route decision
`DATA_INSUFFICIENT` because the batch coverage gate failed.

- Audit samples: 2,340 across 22 observed market IDs.
- Positive fee-adjusted audits: 0; positive markets: 0.
- Theoretical two-leg audits/fills: 0 / 0; real fills/orders: 0 / 0.
- Gross edge amount: p50 `-2.1578`, p90 `-0.2373`, maximum `-0.0001`.
- Fee-adjusted amount (2,175 samples with a value): p50 `-7.04767`, p90 `-0.97782`, maximum
  `-0.00043`.
- Displayed common ask size: p50 `211`, p90 `699.47`, p99 `1424.7`; no positive edge made this
  executable size.

No audit met fee-adjusted edge >0, so duration, unique positive-market count, FOK/FAK applicability
and pre-split inventory evidence are absent. Non-atomic two-leg execution is not called risk-free;
legging risk remains a required disclosure, not an observed profit claim.
