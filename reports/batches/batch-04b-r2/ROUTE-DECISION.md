# Batch 4B-R2 route decision

| route | classification | reason |
|---|---|---|
| Complete-set | `NOT_OBSERVED` | zero positive fee-adjusted audits |
| Lead-lag | `DATA_INSUFFICIENT` | 71 triggers, 15 complete markets, one active source only |
| Maker | `REQUIRES_PRIVATE_FILL_EVIDENCE` | no markout, queue or fill evidence |
| Fair value | `NOT_OBSERVED` | explicitly disabled |

No route is a `RESEARCH_CANDIDATE`; no profitability claim is allowed. The local/server judgment is
`LOCAL_SHORT_CAPTURE_ONLY`: local reconnects and runtime degradation impaired the sample, but no
candidate route exists that would justify renting a server. User directed that this observation not
be rerun.
