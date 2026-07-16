# Batch 4B-R2 verdict

## Unique verdict

**INCOMPLETE_EVIDENCE**

The frozen config hash was preserved and all 252 lead-lag cells were output, but only 15 of 24
observed markets passed the complete-market gate, below the required 24. The session terminated
non-gracefully after 7,262.862 seconds with `fee evidence is not effective at executableTime`.
Complete-set had no positive fee-adjusted edge; lead-lag missed both the 200-trigger and 20-complete-
market gates; maker lacked markout and private fill evidence.

Post-run code remediation adds bounded working history, market-window rejection and shared socket
abort. It does not alter or upgrade the captured evidence. No acceptance tag is created. Batch 4A,
Batch 4B, shadow, live, model training, credentials, User Channel, signing and orders remain
unauthorized.
