# Batch 4B-R2 session launch

## Attempt 1 — stopped during immediate health gate

- Session: `r2-20260716T121943Z`
- Git commit: `dfd998f336591ddddda1a7e583c3c0a232bc1e40`
- Config SHA-256: `074324aaf10d867dfb3c40f5722dcf4354e77cf4f98802b55299ef2d8009127c`
- Runner: `systemd-user`
- PID: `152215`
- Start: `2026-07-16T12:19:43Z`
- Stop heartbeat: `2026-07-16T12:20:30Z`
- Exit: `143` after operator health-gate stop

The run was stopped before it could count as the registered observation. Gamma remained at zero
events and could not bind a market; Chainlink and the Polymarket Binance relay repeatedly recorded
the exact runtime error `public WebSocket error`. Binance spot and perpetual did receive events.
The shell had HTTP/HTTPS proxy variable names, while the systemd user manager had none. This made
the preferred runner unusable in this environment. No raw payloads, credentials, User Channel,
signing, orders, OrderIntent or Fill were used.

The failed attempt is retained outside Git under the experiment data root. Before retry, the thin
launcher is changed to choose the documented `nohup + setsid + PID file` fallback whenever systemd
lacks a proxy variable that is present in the launching shell. The frozen experiment YAML and its
SHA-256 are unchanged.
