# Batch 06：K/J 历史 Paper 闭环结果

## 结论

首个可用离线闭环已通过 `poly-lab paper-kj` 在 `polymarket-money` 运行：它验证冻结 data receipt，将 J/K 重建为纯确定性 signal，模拟延迟 taker fill、独立 cash/position 会计，按官方 label 结算，并导出 summary、NDJSON event 与 CSV。

最初 realized-volatility proxy 已被基于 receipt 固定的官方 Binance 一秒归档构建的 content-addressed、point-in-time EWMA artifact 取代。当前 signal fidelity 只能标为 `CANONICAL_5S_EWMA_OFFICIAL_BINANCE_1S_CLOSE`，不等于 strict legacy：缺旧 live trade stream、K USD conversion 和恢复后的 legacy phase。

## Final Test 证据

配置：官方 dataset hash `a27d9d...e4425cafc`、`FINAL_TEST`、30 秒 horizon、每策略独立初始 10,000 USDC。

| Scenario | Strategy | Decisions | Fills | Net PnL | Final cash | Max drawdown |
|---|---:|---:|---:|---:|---:|---:|
| BASE_1S | J | 1,279 | 135 | +4.89566986 | 10,004.89566986 | 337.37332448 |
| BASE_1S | K | 1,279 | 137 | -298.45735874 | 9,701.54264126 | 572.16855299 |
| STRESS_1S_PLUS_TICK | J | 1,279 | 135 | -85.90779747 | 9,914.09220253 | 354.44458335 |
| STRESS_1S_PLUS_TICK | K | 1,279 | 137 | -387.15306309 | 9,612.84693691 | 591.23789223 |

J 的 BASE 仅 +4.90，加入一个不利 tick 即为 -85.91，去掉最佳三天后为 -240.91；K 两种 scenario 均为负，去掉最佳三天后为 -468.15。因此不晋升为 research candidate，也不支持 shadow 或 live。

## L_ADAPTIVE_EXECUTION 预注册 TRAIN/VALIDATION 结果

Python-only 的 `L_ADAPTIVE_EXECUTION` 使用冻结 `l-adaptive-execution-v1-preregistered`：动态 execution-risk edge、平滑 30/60/120 秒 volatility blend、显式 volatility drag、dynamic opening-anchor ambiguity band 和 depth/latency/price-speed budget。它是独立策略，未修改 J/K 或 TypeScript paper runtime。

| Split | Scenario | Decisions | Fills | Net PnL | Final cash | Max drawdown |
|---|---:|---:|---:|---:|---:|---:|
| TRAIN | BASE_1S | 2,880 | 807 | -20.6611192571958996264383882 | 9,979.33888074280410037356162 | 854.542569651265234441173650 |
| VALIDATION | BASE_1S | 1,440 | 338 | -1,287.046169895371064543169651 | 8,712.953830104628935456830346 | 1,379.390141899152981130344094 |

配置在 TRAIN 后未调整；VALIDATION 明显为负，L 未通过历史 research gate，不能进入 realtime paper、shadow 或 live。未打开 untouched `FINAL_TEST`：`paper-l-adaptive` CLI/API 只接受 `TRAIN`/`VALIDATION`，读取数据前即拒绝 `FINAL_TEST`。不得在同一短 TRAIN slice 上回扫 drag/depth/speed coefficient；当前 receipt 缺连续 CLOB quote sequence 和 point-in-time Chainlink price，无法验证真实 quote velocity 或 Binance--Chainlink basis。

仓外 artifact：

- `/root/polymarket-money-data/experiments/l-adaptive-execution-v1-train-20260717-r3`，result hash `7dde1a4fff3cb16414e71a6f90c3ea9d1693cf50dc5e66afa7459b2e03d05931`。
- `/root/polymarket-money-data/experiments/l-adaptive-execution-v1-validation-20260717-r3`，result hash `9c5caea5b41707e6735983713cec1c2d6cd24234633787d0fe6592ceb08674d5`。
- `/root/polymarket-money-data/paper-runs/kj-ewma-v4-final-test-30s-base`，result hash `3df7f5ba75ed596328251d984e8d6b6b5d7ef99edf8b81610d696f5f05283a29`。
- `/root/polymarket-money-data/paper-runs/kj-ewma-v4-final-test-30s-stress`，result hash `f990a72b44dd8fc8e060cf4177be83f05715b48ab71d3d893e3b26207751d0c8`。

每次 K/J run 有 2,558 条 event record。独立验证重算了 result hash、CSV/NDJSON count、逐策略 net PnL、cash-after-fill identity、gross-minus-fee identity 和 settlement 后零 position。

## 验证

```text
Python: 205 passed
Node/TypeScript: 123 passed
Ruff: All checks passed
git diff --check: passed
```

## 边界

本批完成的是可重放 paper 产品闭环，不是策略盈利、真实成交、shadow 或 live 准入。持续的 public-paper 证据必须先预注册窗口、commit、目标数量与验收规则，完整 campaign 才可由 cohort 汇总；任一漏窗、失败、未结算、身份冲突或 runtime safety 违规都必须标为 `INCOMPLETE_EVIDENCE` 或拒绝。
