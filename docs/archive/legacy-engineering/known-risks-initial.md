# Known risks

| Risk | Initial control | Remaining work |
| --- | --- | --- |
| Accidental live trading | `LIVE_TRADING_ENABLED=false`; no live adapter | Enforce a multi-gate live-mode design in a separate review |
| Oversized order | `maxOrderAmount` | Define units and property tests |
| Market concentration | `maxPositionPerMarket` | Aggregate outcome and correlated-market exposure |
| Daily loss | `maxDailyLoss` | Define timezone, realized/unrealized policy, and durable reset |
| Slippage | `maxSlippageBps` | Specify reference price and thin-book behavior |
| Too many open orders | `maxOpenOrders` | Reconcile exchange and local state |
| Stale data | `maxDataAgeMs` | Reject on clock anomalies and measure source latency |
| WebSocket disconnect | connection state and maximum disconnect age | Define cancel/exit behavior and recovery state machine |
| Duplicate orders | required idempotency key and observed-key set | Add durable uniqueness and retry tests |
| Clock skew / event reordering | four canonical timestamps | Add clock-health monitoring and sequence-gap handling |
| Secret leakage | ignored env/credential files; no credential reads | Add secret scanning in CI |
| Third-party engine defects | adapter boundary and planned evaluation | Complete license, security, and failure-mode review |
| Settlement ambiguity | immutable Market + boundary OraclePrice; winner/token/price derived | Model official disputes, invalid markets, finality, and precision rules |

Numeric defaults are placeholders for tests and design discussion, not approved
trading limits. Monetary units, token precision, rounding, and currency semantics
must be formalized before execution implementation.
