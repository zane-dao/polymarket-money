# Batch 4B-R1 Critical 合同整改

## 目标

保留原 Batch 4B 的 `REJECT_AND_STOP`，按冻结计划修复时间、异常、费用、Opportunity 与
lead-lag Critical；不启动 150 分钟观测，不进入任何交易面。

## 事实与证据

- 分支 `batch/4b-critical-remediation`；代码复验点 `e4d638e`，最终报告提交 `6f46b79`。
- 每组先提交失败测试，再提交最小实现；第二次 Sol 新发现的 Critical 也遵循同一纪律。
- raw-event-v2、ReceiveStamp、双连接身份、strict as-of、252-cell grid、episode v1、incident
  fallback、Decimal clone、单一 FeeEdgeCalculator、Opportunity/Route 分层均已落盘。
- Python 190/190、Node 89/89、Ruff、TypeScript、clean venv、pip check、npm ci/audit 通过。
- 第二次 Sol 唯一结论为 `PASS_WITH_NONBLOCKING_EVIDENCE_DEBT`。

## 修改

- AI 项目层：更新 CURRENT、决策、会话摘要与 INDEX 路由。
- 代码层：结果与证据位于代码仓 `docs/batches/batch-04b-r1/`、
  `reports/batches/batch-04b-r1/`。
- 外部状态：只生成 `D:\polypolycache\HANDOFF-BATCH-04B-R1.md`；无长期进程、标签或交易操作。

## 验证

- 命令：Python/Node 全量、Ruff、typecheck、clean venv、pip check、npm ci/audit、diff check。
- 结果：全部通过；第二次 Sol 复核通过，保留两项非阻断 evidence debt。

## 决定

- R1 合同通过不等于观测通过；同步为 D-019。

## 未决问题

- 官方 fee 精确 tie-breaking 未验证；公共 CLOB 无 gap-free cursor。
- RouteEvaluation 仍为 `DATA_INSUFFICIENT`；24 市场/150 分钟观测尚未执行。

## 下一步

停止在 R1 handoff。若用户另行授权，后续独立批次重新创建并复核 24 市场预注册配置；本批
不得自动启动观测或进入 shadow/live。
