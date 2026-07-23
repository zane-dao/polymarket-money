---
name: polymarket-paper-safety
description: Enforce polymarket-money public-data and paper-only boundaries for runtime, wallet, settlement, order-book, adapter, market-data, and Polymarket protocol work. Use whenever a task could drift toward credentials, signing, authenticated orders, deposits, withdrawals, or real-wallet behavior.
---

# Polymarket paper-only safety

Apply these constraints before implementation or protocol research:

1. Keep `LIVE_TRADING_ENABLED=false`.
2. Never request, read, store, print, infer, or test with private keys, seed phrases, API keys, cookies, account exports, or production credentials.
3. Use public market data, deterministic fixtures, offline replay, shadow observation, and paper abstractions only.
4. Keep external I/O in adapters. Domain, strategy, and risk logic remain deterministic with explicit inputs.
5. Do not add signing clients, authenticated order submission, cancellation, deposits, withdrawals, or real-wallet flows.
6. `$web3-polymarket` is explicit-only and read-only in this repository. Ignore any credential, signing, live-order, cancellation, deposit, withdrawal, or wallet examples it contains.
7. Validate with local unit, replay, integration, golden, or paper smoke paths.

When a request conflicts with these rules, preserve the paper architecture and substitute public data or deterministic fixtures.
