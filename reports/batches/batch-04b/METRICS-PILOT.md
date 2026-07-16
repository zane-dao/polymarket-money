# Batch 4B metrics pilot

Run ID `runtime-20260716070428-993f89d4`, 10.310 s, `record=metrics`, stopped by duration.
No raw segments were written. The summary reported zero real orders, zero theoretical fills,
zero stale events and zero reconnects.

| stream | events | events/hour | quarantines | latency p50/p95 |
|---|---:|---:|---:|---:|
| Gamma | 2 | 698 | 0 | n/a |
| CLOB | 5,208 | 1,818,506 | 12 | n/a |
| Chainlink | 9 | 3,143 | 2 | 1,024/1,391 ms |
| Polymarket Binance relay | 1 | 349 | 1 | n/a |
| Binance spot | 727 | 253,851 | 0 | n/a |
| Binance perpetual | 2,213 | 772,726 | 0 | 937/2,432 ms |

The live book reached `ACTIVE_UNVERIFIED`; opportunities remained observational. The run
covered one current and one next market identity, not the 24-market target, so no 24-market
continuity claim is made.

The requested 30-minute monitor was attempted with a 45-second external wall-time cap and
ended with exit 124. Its snapshots showed real public data but no completed 30-minute summary;
this is recorded as incomplete rather than passed.
