# 2026-07-15 第二批只读数据合同、不可变存储与回放

## 目标

在无凭据、无订单、无策略/回测边界内建立可信公开数据入口，并按新批次目录规范交付。

## 事实与证据

- 代码仓 Batch 1 基线/tag 已固定，Batch 2 分支与 tag 已建立且未 push。
- 跨语言 raw contract、市场身份、CLOB/RTDS、不可变 segment/manifest、quality/replay 完成。
- 63 项 Python、40 项 Node、typecheck 和干净安装通过。
- 一次有限公开 smoke 产生 4 final manifests、0 partial，并由 Python 9/9 验证；连续性仍为
  `UNVERIFIED`。
- 成功 smoke 后的 off-topic 分类补丁由离线测试证明；再次联机因公共网络错误未完成，已
  记录为 evidence limit。

## 修改

- AI 项目层：更新当前阶段、路线、长期决定和会话索引。
- 代码层：结果见代码仓 `docs/batches/batch-02-readonly-data/batch-2-result.md`。
- 外部状态：`/root/review-packs/polymarket-money/batch-02/` 只生成 handoff；Windows D 盘
  已导出完整文档审阅包和仅 handoff 的外部精简包；未 push。

## 验证

- 命令：Python unittest、全新 venv wheel/install/pip check、npm ci/test/typecheck/ls/audit、
  bounded smoke、Python manifest verifier、Git/security/large-file scan。
- 结果：全部离线与安装测试通过；smoke 核心链通过，公开网络后续重验限制已保留。

## 决定

- 批次设计/结果、证据和外部 handoff 使用三层路径，不再散放根目录。
- raw truth 为已验证 bytes；无官方 cursor 时不宣称 gap-free。

## 未决问题

- Binance 精确 filter 行为、长期 supervisor、跨进程 lease、DrvFS durability 和
  point-in-time normalized dataset 未解决。

## 下一步

等待用户授权第三批；唯一建议先审阅/冻结 verified raw 到 point-in-time dataset 的因果
可见性和 lineage，不提前回测或迁移策略。
