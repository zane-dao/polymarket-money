# Opportunity observation contract

Batch 4B records observations only. `OpportunityRecord` is immutable and has four closed
families: `COMPLETE_SET_ARBITRAGE`, `CROSS_VENUE_LEAD_LAG`, `MAKER_SPREAD_REBATE`, and
`FAIR_VALUE_MISPRICING`. It carries market identity, interval timestamps, quote/depth,
fee/rebate evidence, gross and scenario net edge, visible size, latency assumptions,
quality/continuity, rejection reason, and an evidence level.

No family creates an `OrderIntent`. A two-leg complete-set observation uses the minimum
common visible ask size and is marked non-atomic/conditional. Unknown fees, stale data,
disconnects, empty sides, and invalid quotes fail closed. Maker records never claim queue
position or fills; rebates are scenario evidence only.

Evidence levels are exactly `NOT_OBSERVED`, `OBSERVED_NOT_EXECUTABLE`,
`RESEARCH_CANDIDATE`, and `REQUIRES_PRIVATE_FILL_EVIDENCE`.
