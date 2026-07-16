# Strategy route ranking

This is a research ranking, not a profitability claim. It is conditional on obtaining a
clean multi-market metrics sample.

1. `CROSS_VENUE_LEAD_LAG` — preferred first observation route because it can be evaluated
   without private fills and directly tests whether external price changes precede a
   Polymarket repricing. It must remain point-in-time and latency-qualified.
2. `COMPLETE_SET_ARBITRAGE` — second route because its formula is transparent, but two-leg
   atomicity, legging risk, fees and inventory make public observations non-executable.

`MAKER_SPREAD_REBATE` and `FAIR_VALUE_MISPRICING` remain observation-only until a later
   batch establishes fill evidence or a validated fair-value model. No server is justified
   merely by the possibility of future opportunities.
