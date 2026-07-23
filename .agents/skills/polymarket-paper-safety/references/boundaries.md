# Boundary examples

Allowed:

- public Gamma or CLOB metadata;
- public WebSocket market data;
- deterministic fixtures and replay;
- paper fills, positions, settlement, and accounting;
- read-only adapters;
- tests that prove live trading remains disabled.

Not allowed:

- credential creation or loading;
- private keys, seed phrases, cookies, API secrets, or account exports;
- signing or authenticated order placement;
- cancellation, deposits, withdrawals, or real-wallet flows;
- enabling `LIVE_TRADING_ENABLED`;
- hiding a live engine behind a paper interface.
