# 2026-07-15 Batch 2.5 point-in-time normalized dataset gate

## 目标

只把 Batch 2 manifest-verified raw 转换为不可变、可追溯、严格 point-in-time normalized
dataset；不进入回测、特征、模型、策略或实盘。

## 事实与证据

- Branch `batch/2-5-point-in-time-data` 的验收 HEAD 为 `88bfe8c`，annotated tag
  `batch-2-5-accepted`；未 push。
- Schema、`as_of`、因果 lineage、Gamma/CLOB/RTDS normalization、market-wide book gate、
  immutable publish 与 offline load 已实现。
- Batch 2.5 专项 Python 56/56；全量 Python 119/119；Node 40/40；TypeScript、Ruff、clean
  venv install、`pip check`、`npm ci`、0 vulnerabilities 和 `git diff --check` 均通过。
- 有限 BTC-only probe 未观察到目标 update，按规则记录 evidence debt，没有启用 fallback
  或伪造成功。

## 修改

- AI 项目层：更新总索引、当前计划、路线、D-015 与本会话摘要。
- 代码层：新增/硬化 normalized schemas、Python normalizer/PIT view、replay/unit tests、
  Batch 2.5 docs 与 reports。
- 外部状态：`/root/review-packs/polymarket-money/batch-02-5/` 只生成
  `HANDOFF-BATCH-02-5.md`；另在 `D:\polypolycache` 生成 10 文件的完整文档审阅包和只含
  HANDOFF 的 1 文件精简包，逐文件 `cmp` 通过；参考项目未修改。

## 验证

- 命令：pytest、unittest、Ruff、clean venv editable install、pip check、npm ci、npm test、
  TypeScript typecheck、Git integrity/status checks。
- 结果：Python 119/119、Node 40/40，所有 gate 通过，最终代码工作树 clean。

## 决定

- Continuity 不修补，持续 `UNVERIFIED`；空侧 `UNTRADEABLE`、midpoint null、market-wide
  fail closed；Linux-native/single writer；Binance BTC-only 默认；reconnect supervisor 后移 2B。
- PIT dataset gate 独立于回测，完成本批不构成开始 Batch 3 的授权。
- 今后每批结果自动同步到 `D:\polypolycache` 的完整文档包与 HANDOFF-only 精简包，无需用户
  再次提醒；严禁夹带源码、raw、凭据或大文件。

## 未决问题

- 长期 reconnect、BTC-only 在线分布证据、single-writer crash lease、content signature、
  JSONL 规模性能与跨 manifest exact-tie 共同顺序仍未解决。

## 下一步

等待用户选择独立 dataset acceptance policy 或授权 Batch 2B；未经新授权不开始回测。
