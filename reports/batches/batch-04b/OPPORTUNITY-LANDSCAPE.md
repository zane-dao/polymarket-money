# Opportunity landscape

The complete metrics pilot produced observer records but no executable fills. Counts below
are therefore observations, not trades or profitability.

| family | observation | opportunity | evidence |
|---|---:|---:|---|
| COMPLETE_SET_ARBITRAGE | present each active snapshot | 0 positive fee-adjusted edges | OBSERVED_NOT_EXECUTABLE |
| CROSS_VENUE_LEAD_LAG | present as observer | 0 detected threshold events | NOT_OBSERVED |
| MAKER_SPREAD_REBATE | present each active snapshot | envelopes only; no fills | OBSERVED_NOT_EXECUTABLE |
| FAIR_VALUE_MISPRICING | no fair-value model enabled | 0 | NOT_OBSERVED |

Observed complete-set examples had negative fee-adjusted edge (about -0.0253 in the raw
pilot). Displayed common depth varied (for example 71.84–154.93 tokens). No duration
distribution, p50/p90/p99 or markout distribution is claimed because the run was 10 seconds
and continuity was `UNVERIFIED`. Maker rebate and queue position remain scenario-only.

The route ranking is therefore provisional: first cross-venue lead-lag measurement, second
complete-set arithmetic; maker and fair-value remain deferred pending a longer clean sample.
