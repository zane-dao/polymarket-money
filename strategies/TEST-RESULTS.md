# 策略测试与研究证据

本文件只汇总可复查结果，不复制仓外大型 artifact。权威历史研究结论仍位于
[`reports/batches/batch-06-kj-paper/RESULT.md`](../reports/batches/batch-06-kj-paper/RESULT.md)。

## L 版本边界

| 策略 | 冻结版本 | 当前状态 | 可用范围 |
|---|---|---|---|
| L V1 | `l-adaptive-execution-v1-preregistered` | `RESEARCH_GATE_FAILED` | TRAIN/VALIDATION 历史审计 |
| L V2 | `l-adaptive-execution-v2-candidate` | `RESEARCH_ONLY_CANDIDATE` | 冻结 train-selected VALIDATION 研究 |

专项测试覆盖：

- 注册表同时暴露 L V1 与 L V2，且版本、状态不混淆；
- L V2 train-selected 参数保持冻结；
- L 的 `FINAL_TEST` 入口 fail closed；
- L 不能与 J/K 混跑；
- 执行时刻盘口不能反向污染决策时刻的 quote-risk 输入；
- 波动率上升会增加 volatility drag 和剩余风险；
- 缺少连续 quote velocity 与 point-in-time Chainlink boundary 时不得声称 realtime 准入。

## 已冻结历史结果

| 版本/分割 | Decisions | Fills | Net PnL | 结论 |
|---|---:|---:|---:|---|
| L V1 TRAIN / BASE_1S | 2,880 | 807 | -20.6611192571958996264383882 | 未证明可晋级 |
| L V1 VALIDATION / BASE_1S | 1,440 | 338 | -1,287.046169895371064543169651 | 历史 gate 失败 |

这些数字是历史 artifact 的摘要，不代表盈利能力，也不是实时、shadow 或真实成交证据。L V2
仍是离线候选；其后续结论必须引用新的、预注册且完整的证据，不能覆盖本表。

## 当前验证

本节在策略或测试发生变化时更新，记录最近一次本地验证命令及结果。2026-07-22 的 Web 整合验证：

```text
python3 -m unittest discover -s strategies/tests -p 'test_*.py': 9 passed
npm test: 251 passed
frontend Vitest: 22 passed
frontend Playwright: 4 passed
TypeScript typecheck / backend build / Vite production build: passed
```

本轮按用户决定只验收本机 Web 操作入口，未重新验证 Tauri/Rust。公开行情采集没有获得当次启动
批准，因此测试结果只证明离线工程链和本机 Web API，不证明实时连续性、shadow 或盈利能力。
