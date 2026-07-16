# Batch 4B-R1 second Sol read-only review

审查代码点：`e4d638e948c42024871d13c21755ed2dbdd40733`

审查分支：`batch/4b-critical-remediation`

## 唯一结论

**PASS_WITH_NONBLOCKING_EVIDENCE_DEBT**

整改后的单一 ReceiveStamp/raw-v2、RuntimeIncident、FeeEdgeCalculator、OpportunityObservation、
RouteEvaluation 与 LeadLagEngine 路径满足冻结合同。四来源 × 三阈值 × 三窗口 × 七 horizon 的
252-cell 网格完整；baseline 与 fixed horizon 使用严格 PIT as-of；双连接 identity、质量失效、
episode reset、input lineage 和 config provenance 均失败关闭。

复核确认：Node 89/89、Python 190/190、TypeScript typecheck、Ruff 与 `git diff --check` 通过。
没有发现 live client、User Channel、凭据读取、签名器、订单调用、长期采集、shadow/live 或
训练任务。

## 非阻断 evidence debt

1. 官方尚未证明精确半单位手续费的 tie-breaking；实现返回
   `ROUNDING_TIE_UNVERIFIED` 并拒绝 verified net edge。
2. 公共 CLOB 没有可证明 gap-free 的 cursor；continuity 保持 `UNVERIFIED`，相关 observation
   保持 ineligible，RouteEvaluation 固定为 `DATA_INSUFFICIENT`。

本结论只允许后续批次重新创建预注册的 24 市场实验配置。本批没有授权、也没有启动 150 分钟
观测；不构成 Batch 4A/4B 验收标签、模型训练、shadow/live 或真实交易许可。
