# Batch 4B-R2 lead-lag results

Classification: **DATA_INSUFFICIENT**.

The complete 252-cell artifact, including 203 all-zero cells, is
`LEAD-LAG-GRID-252.json` (SHA-256
`36a62b1286749a41083ac26604e5df063cbfc68b02980a48c61e69fd6cf700ab`).

| source | raw triggers | episodes | markets | valid horizons | censored |
|---|---:|---:|---:|---:|---:|
| Chainlink RTDS | 71 | 51 | 11 | 495 | 2 |
| Polymarket Binance relay | 0 | 0 | 0 | 0 | 0 |
| Binance spot | 0 | 0 | 0 | 0 | 0 |
| Binance perpetual | 0 | 0 | 0 | 0 | 0 |

The two censored horizons were `POLYMARKET_CONNECTION_CHANGED`. Trigger rejections were dominated
by `BASELINE_TOO_OLD` (50,405), followed by snapshot quality (3,265), snapshot missing (1,681),
connection reset (1,042), baseline missing (178) and baseline connection mismatch (12).

Across 50/100/250/500/1000/2000/3000ms, valid horizon counts were
71/71/71/71/71/71/69. Median absolute markout was 0/0/0/0/0/0.02/0.02; maxima were
0/0/0.015/0.055/0.055/0.07/0.15. These are price changes, not fee-adjusted executable edges.
Visible size and fee-adjusted edge were not established for lead-lag; every route-bound Opportunity
remained ineligible because continuity was `UNVERIFIED`.

The preregistered candidate gate required at least 200 valid triggers and 20 complete markets, plus
directional consistency not concentrated in one source. The run had 71 triggers, 15 complete
markets, and one source only. No best-cell selection or independence claim is made.
