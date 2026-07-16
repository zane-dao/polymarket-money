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

## Attempt 2 — stopped on current Gamma schema mismatch

- Session: `r2-20260716T122151Z`
- Git commit: `14237cf69c9937f2cb5a4bd51e3045db4c3d74a8`
- Runner: `nohup-setsid`
- PID: `152887`
- Start: `2026-07-16T12:21:51Z`
- Stop heartbeat: `2026-07-16T12:23:34Z`
- Exit: `143`, stop reason `MANUAL_GRACEFUL_STOP`

The fallback inherited the network environment: Gamma, both RTDS streams and both direct Binance
streams received data without reconnects. The health gate still stopped the run because every
Gamma market was quarantined with `feeSchedule.rate must be a canonical decimal string`, leaving
the current market unbound. A bounded current-response check proved that Gamma now emits
`feeSchedule.rate` as the JSON numeric token `0.07`.

The compatibility fix preserves the exact raw numeric token through the JSON boundary and passes
the resulting canonical string to the existing Money/FeeEdgeCalculator. It continues to reject
programmatic JavaScript numbers, exponent tokens and non-canonical numeric lexemes. Node 93/93 and
TypeScript passed, and three consecutive current markets then validated as collectible with fee
rate `0.07`. Attempt 2 is retained outside Git; no observation evidence from it is accepted.

## Attempt 3 — registered observation, incomplete

- Session: `r2-20260716T122558Z`
- Runtime run ID: `runtime-20260716122610-05489399`
- Collector commit: `f22746112e25515e8817708b05866f34a417dae2`
- Config SHA-256: `074324aaf10d867dfb3c40f5722dcf4354e77cf4f98802b55299ef2d8009127c`
- Runner: `nohup-setsid`
- Start: `2026-07-16T12:26:10.544Z`
- Runtime summary end: `2026-07-16T14:27:13.406Z`
- Elapsed: `7,262.862` seconds
- Terminal: `UNRECOVERABLE_RUNTIME_FAILURE`, incident persisted, exit code 1

The run was metrics-only and raw=false. It reached 24 market identities but only 15 passed the
frozen complete-market gate. The terminal incident was
`fee evidence is not effective at executableTime`; the outer session was then explicitly cleaned
up because old socket handles kept Node alive after the summary was written. No acceptance tag was
created.
