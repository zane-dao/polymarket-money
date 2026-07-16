# Public runtime to K/J StrategyContext

`execution/src/strategy/kj-context.ts` is the single paper-only boundary between
the TypeScript public runtime and future K/J strategy/portfolio consumers.
`scripts/live-runtime.ts` emits three fields on every runtime snapshot:

- `kjStrategyContextReady`;
- `kjStrategyContextReason`;
- `kjStrategyContext`.

The context is produced only when all of the following are true:

- the Gamma market is active, open, accepting orders, exactly five minutes,
  and has an explicit fee rate;
- Up and Down token IDs are distinct and bound by their labels;
- both books are active, uncrossed, non-empty, continuity-unverified, and no
  more than five seconds old;
- the Binance signal is positive, no more than ten seconds old, not from the
  future, and carries source/receive/connection/hash evidence;
- book and signal receive stamps belong to the same process clock domain;
- decision time lies inside the market interval.

The immutable output contains market identity, verified outcome token IDs,
top-of-book, full receive stamps, signal evidence, static public fee evidence,
and structural paper-only safety flags.  Missing or invalid evidence returns a
reason and no context.

This is not yet a real-time portfolio loop.  No K/J decision, wallet mutation,
fill, settlement, credential, private channel, or order path was added.  A
future consumer must use this exact context rather than reading the runtime's
looser dashboard fields directly.
