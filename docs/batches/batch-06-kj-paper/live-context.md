# Public runtime K/J paper boundary

## StrategyContext

`execution/src/strategy/kj-context.ts` is the single paper-only boundary from
the public TypeScript runtime into K/J consumers.  Every runtime snapshot emits
`kjStrategyContextReady`, `kjStrategyContextReason`, and
`kjStrategyContext`.  A context is produced only when:

- Gamma identifies an active, open, accepting five-minute market with an
  explicit public fee rate and distinct Up/Down token IDs;
- both books are active, uncrossed, non-empty, continuity-unverified, and at
  most five seconds old;
- the Binance signal is positive, at most ten seconds old, not future-dated,
  and carries source/receive/connection/hash evidence;
- book and signal ReceiveStamps use the same process clock domain; and
- decision time is inside the market interval.

The immutable output binds market and token identity, top-of-book, full receive
stamps, signal evidence, fee evidence, and structural paper-only flags.  Any
missing or invalid evidence yields a reason and no context.

## Real-time paper consumer

Only runtime `paper` mode with an explicit `--kj-paper-journal` passes ready
contexts to `execution/src/runtime/kj-paper-engine.ts`.  Runtime `monitor` mode,
and paper mode without the journal option, emit the context but never mutate K/J
wallets.  The versioned engine currently models:

- global J single-EWMA and K fast/slow-EWMA signal state;
- independent 10,000-unit J/K in-memory wallets and market ledgers;
- an opening anchor only when observed within five seconds of interval start;
- 15-second decision cadence, fee/spread-aware edge, critical band, Kelly and
  cash/market/depth caps;
- frozen intent quantity, worst-case reservation through the allowed one-cent
  slippage, one-second execution latency, partial fill, slippage no-fill, and
  reservation release;
- real Up/Down token positions and market lifecycle
  `INIT -> RUNNING -> STOPPING -> DONE`;
- deduplication with rejection of conflicting context, signal input,
  settlement ID, and second settlement-per-market content.

Before engine mutation, accepted contexts are fsynced to
`kj-paper-input-journal-v1`.  The journal validates exact reconstructed context,
engine version/config, identity conflicts and per-clock order; each record is
SHA-256 chained.  An atomic side checkpoint detects valid-line tail truncation
while allowing a crash after journal fsync but before checkpoint publication to
self-heal.  Restart strictly replays the journal into the same engine state.
Symlink paths, Git-local storage, DrvFS, modified records, incomplete lines,
missing anchors, reversed watermarks and conflicting identities fail closed.

Snapshots expose `kjPaperEngineVersion`, incremental `kjPaperEvents`, a full
`kjPaperState` (wallets, reservations, positions, market ledgers and pending
intents), journal count/hash, and the current market state.  Events bind deterministic
IDs to decision or execution context hashes, receive ordinals, intent data,
fees, position-after-fill, and official settlement evidence.

## Fail-closed limitations

This is not yet an unattended continuous paper service:

1. `scripts/live-runtime.ts` does not currently obtain or pass a trusted
   official resolution.  At interval end the engine cancels pending risk and
   remains `STOPPING`; only an explicit `OFFICIAL_RESOLUTION` can settle wallets
   and enter `DONE`.
2. Journal replay restores accepted inputs and deterministic paper state, but it
   is not an exchange reconciliation mechanism and has no private account or
   order evidence by design.
3. TypeScript uses the deterministic Abramowitz-Stegun 7.1.26 normal-CDF
   approximation.  `data/golden/batch-06/kj-probability-v1.json` bounds it to
   `0.0000002` absolute error against Python `erf` for representative and
   clamped-tail z-scores, but full EWMA-to-intent cross-language golden decision
   parity has not been established.
4. Book continuity remains explicitly `UNVERIFIED`, so fills are theoretical
   paper fills, never evidence that a live order would have executed.

No credential, private channel, signature, order, cancellation, or live-wallet
path is present.  `LIVE_TRADING_ENABLED=false` remains unchanged.
