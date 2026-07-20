# 2026-07-16 Batch 3A 研究样本准入与可信回测内核

## 事实与证据

- 从 `batch-2-5-accepted` 建立 `batch/3a-causal-backtest-core`；fail-first `e66d3b2`，实现
  `e01864a`，最终 `d560427`，annotated tag `batch-3a-accepted`，未 push。
- 新增 published normalized-only acceptance/replay gate、四种执行模型、PIT fee、逐市场审计
  和 Batch 1 FillLedger/Settlement/PnL 复用。
- 并行终审发现并修复 receipt 伪造、准入策略分叉、重复幂等键、隔离结算价、未结算收益
  误标和 fixture fee 冒充历史证据等阻断。
- 三人工市场全链路数值净 PnL 4.40/5.03/2.19；因 fee 仅为 fixture，均明确不可称历史已
  验证净收益。
- clean venv 安装、Ruff、155 Python、40 Node、TypeScript 与 npm audit 全部通过。

## 决定

- 3A 结论为 PASS WITH DOCUMENTED LIMITATIONS；不自动进入 3B。
- Windows 从本批起默认只交单一 HANDOFF，位置为
  `D:\polypolycache\HANDOFF-BATCH-03A.md`，不复制整套 docs/reports。

## 未决与下一步

- continuity 保持 UNVERIFIED；真实历史 fee、真实历史 normalized 样本、队列/隐藏流动性与
  通用逐事件调度尚未解决。
- 等待用户审阅 HANDOFF 并明确是否授权 3B；授权前确认数据集、准入口径和 fee 证据。

