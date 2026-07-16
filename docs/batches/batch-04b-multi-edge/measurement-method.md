# Measurement method

All observations use local monotonic receive order plus wall-clock receive timestamps.
Provider source timestamps are retained but are not re-labelled as network latency unless
their semantics are verified. Events arriving after a decision boundary are excluded from
that historical decision. A stale, disconnected, empty-sided, or quarantined book produces
no opportunity.

For complete sets, buy edge is `1 - ask_up - ask_down - fee_up - fee_down`; sell edge is
conditional on existing inventory and uses bids. The executable visible quantity is the
minimum common displayed size. Two legs are never called risk-free or atomic.

Lead-lag windows are 50, 100, 250, 500, 1000, 2000, and 3000 ms. Maker reporting measures
spread, visible depth, quote lifetime, churn, trade arrival and markout envelopes only;
queue position and fill rate remain unknown. Results are summarized per market and hour
with duration p50/p90/p99, visible size p50/p90, edge, latency sensitivity and data quality.
