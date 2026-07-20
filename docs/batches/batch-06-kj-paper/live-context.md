# 公共运行时 K/J Paper 边界

## StrategyContext

`execution/src/strategy/kj-context.ts` 是 public TypeScript runtime 到 K/J consumer 的唯一 paper-only 边界。每个 runtime snapshot 输出 `kjStrategyContextReady`、`kjStrategyContextReason` 和 `kjStrategyContext`。只有 Gamma 确认开放的五分钟 market、存在 fee rate 与不同 Up/Down token ID，两个 book 均 active/uncrossed/非空且不超过五秒，Binance signal 为正且不超过十秒并携带 source/receive/connection/hash evidence，所有 ReceiveStamp 属于同一 process clock domain，且 decision time 位于 market interval 内，才产生不可变 context。任一证据缺失或无效时只输出 reason。

## Realtime paper consumer

只有 runtime `paper` mode 且显式提供 `--kj-paper-journal` 才把 ready context 交给 `execution/src/runtime/kj-paper-engine.ts`。`monitor` mode 和未提供 journal 的 paper mode 均只输出 context，绝不改变 J/K wallet。

engine 包含独立 J/K in-memory wallet、single/fast/slow EWMA、opening anchor、15 秒 decision cadence、fee/spread-aware edge、critical band、Kelly/cash/market/depth cap、冻结 intent quantity、worst-case reservation、一秒 execution latency、partial fill、slippage no-fill、real Up/Down token position 与 `INIT -> RUNNING -> STOPPING -> DONE` lifecycle。冲突 context、signal input、settlement ID 和同一 market 的第二份 settlement 都 fail closed。

接受的 context 会先 fsync 到 `kj-paper-input-journal-v2`。MVP run 在任何 context 前写入 `RUN_PLAN`，以 hash-bind run ID、target count/window 与 committed code ID。interval end 后 runtime 轮询 public Gamma endpoint；仅当 market closed、`umaResolutionStatus=resolved` 且存在唯一 1-valued outcome 时，精确 raw response 才能成为 official evidence。replay 会重新验证 response，而不信任已存 winner。

journal 验证重建 context、engine version/config、identity conflict、per-clock order 与 SHA-256 chain；atomic checkpoint 检测 tail truncation，并允许 journal fsync 后、checkpoint 发布前崩溃自愈。symlink、Git 内存储、DrvFS、被修改 record、不完整行、缺 anchor、倒序 watermark 和身份冲突均 fail closed。

## Product 边界与限制

`npm run paper:mvp -- --markets 1` 是有界的无人值守 product entry：等待下一个完整 interval，记录 committed code ID，执行 half-open target cutoff，默认给十分钟 resolution grace，并仅在 replay inspection 后写入 `result.json`。每次最多 12 个 market；`paper:report` 重开 journal，验证 bound plan 与 result/runtime artifact，重建 settlement event，核对逐 market 与 aggregate wallet PnL identity，并输出 no-overwrite 的 hash JSON 与逐 market CSV。没有 `RUN_PLAN` 的 legacy journal 必须标为 `LEGACY_UNBOUND`。

journal replay 只能恢复接受输入和确定性 paper state，不是 exchange reconciliation，也没有 private account/order evidence。delayed、ambiguous、50/50 或 identity-conflicting Gamma result 不得猜测；`paper:settle` 仅恢复冻结 target window，`paper:finalize` 复用 acceptance builder 写入 `RECOVERED_FINAL`。

TypeScript 使用确定性 Abramowitz-Stegun 7.1.26 normal-CDF approximation；`kj-probability-v1.json` 将其相对 Python `erf` 的绝对误差限制在 `0.0000002`，`kj-ewma-intent-parity-v1.json` 验证共享 J 拒单与 K EWMA-to-intent-to-fill-to-settlement 路径。这是代表性而非穷举测试。book continuity 持续为 `UNVERIFIED`，fill 仅是理论 paper fill，不是真实订单成交证据。

不存在凭据、private channel、signature、order、cancellation 或 live-wallet 路径；`LIVE_TRADING_ENABLED=false` 不变。
