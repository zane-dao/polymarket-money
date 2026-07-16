# Batch 4B verdict

## Final conclusion

**LOCAL_SHORT_CAPTURE_ONLY** remains the correct route decision. The local system can perform
short, read-only multi-edge observation and bounded raw pilots, but the measured compressed
projection (21.29 GiB/day in the complete pilot) is incompatible with the D-backed WSL safe
capacity established in Batch 4A. The 30-minute monitor and 60-minute raw acceptance runs were
not completed: monitor was externally capped at 45 seconds and the long raw attempt was
externally capped at 45 seconds. This is an evidence gap, not a pass.

## Route decision

1. CROSS_VENUE_LEAD_LAG — first research route, after a clean multi-market sample.
2. COMPLETE_SET_ARBITRAGE — second, transparent but non-atomic and fee/inventory constrained.

No server is justified yet: no candidate was shown to require sub-second infrastructure,
24-hour observation, or private fill evidence. Maker and fair-value routes remain deferred.

## Highest risks

Unverified continuity, short sample duration, quarantine events on public streams, unknown
provider timestamp semantics, two-leg legging risk, and the absence of private fill evidence.
No real profit claim is made.
