# Batch 4B-R2 session quality

## Result

`INCOMPLETE_EVIDENCE`: 24 market identities observed, 15 complete, 9 incomplete. Detailed per-market
records are in `MARKET-QUALITY-24.json` (SHA-256
`9085215d5834de6621d12cfa7946f9c2abafb14055a4152331c44b177e63b55b`).

| source | events | reconnects | quarantines |
|---|---:|---:|---:|
| Gamma | 49 | 14 | 1 |
| CLOB | 2,520,743 | 27 | 66 |
| Chainlink RTDS | 5,633 | 2 | 6 |
| Polymarket Binance relay | 3 | 2 | 3 |
| Binance spot | 16,122 | 1 | 0 |
| Binance perpetual | 16,111 | 0 | 0 |

There were 34 persisted runtime incidents and three stale transitions. Continuity remains
`UNVERIFIED`. Snapshot-ready sample coverage across markets had median 71.1%, p90 92.2%; sampling
was irregular under runtime load, so the report does not relabel sample counts as exact durations.

## Incomplete markets

| interval start UTC | start delay | coverage | reason |
|---|---:|---:|---|
| 12:25 | 71.686s | 228.314s | initial partial market |
| 12:50 | 16.061s | 283.939s | missed frozen start/coverage gate |
| 13:05 | 24.291s | 275.709s | delayed rotation/reconnect |
| 13:20 | 26.300s | 273.700s | delayed rotation/reconnect |
| 13:30 | 19.327s | 280.673s | delayed rotation/reconnect |
| 14:05 | 93.092s | 206.908s | severe runtime lag |
| 14:15 | 482.338s | 0s | bound after interval ended |
| 14:20 | 185.112s | 114.888s | severe runtime lag |
| 14:30 | before start | 0s | future market seen before terminal stop |

## Cause classification and graceful degradation

- Network evidence: repeated public WebSocket errors and reconnects materially affected coverage.
- Code/runtime evidence: CLOB as-of working history grew without retirement, and the per-second
  dashboard recomputed/serialized all 252 cells. The late-run multi-minute rotation lag cannot be
  explained by network alone.
- Contract bug: fee evidence outside its effective market interval threw a terminal exception
  instead of producing no eligible opportunity.
- Cleanup bug: terminal summary was written, but live sockets kept Node active until the process
  group was explicitly stopped.

R1 graceful degradation already covered reconnect, reset censor, quarantine, stale/empty/crossed
exclusion, `UNVERIFIED` continuity and incident persistence. Post-run remediation adds exact market
window rejection, settled-market working-history retirement, shared AbortSignal shutdown, and
removes the repeated per-snapshot grid computation. Node regression tests cover each addition.
