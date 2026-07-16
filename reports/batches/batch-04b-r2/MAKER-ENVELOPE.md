# Batch 4B-R2 maker envelope

Classification: **REQUIRES_PRIVATE_FILL_EVIDENCE**.

- Envelope audits: 2,340 across 22 market IDs.
- Spread: min `0.001`, p50 `0.01`, p90 `0.01`, p99 `0.03`, max `0.34`.
- Maker fills: 0; queue position known: 0.
- 100/250/500/1000/3000ms maker markout: not recorded by this run.
- Quote lifetime, churn and trade-arrival proxy: not reliably produced as durable aggregate evidence.
- Maker fee/rebate: scenario only; no rebate is counted as realized income.

The envelope cannot be described as profitability. Missing markout, queue and private fill evidence
is reported as missing, not zero.
