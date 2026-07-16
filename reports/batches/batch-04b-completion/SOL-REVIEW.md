# Batch 4B Completion Sol review

审查基线：`batch/4b-local-multi-edge-pilot`，reviewed HEAD
`4ad13c30a8b5672eedb07b972d6303916504b7fa`。

## 结论

**REJECT_AND_STOP**

不得进入原 Batch 4B Completion 阶段 B–H，不得启动 24 市场或 150 分钟观测。当前测试通过
只能证明既有断言成立，不能覆盖下述时间、费用和观测证据 Critical。

## 逐项复核

| # | 检查 | 结论 | 证据 |
|---:|---|---|---|
| 1 | Git 分支、状态、提交 | PASS | 工作树干净；HEAD 为 `4ad13c3`，已有 `73c0b8d`、`4ad13c3`。 |
| 2 | 复用 Batch 2/2.5/3A/4A | REJECT | replay、book、raw writer 被复用，但 `paper.ts` 与 `opportunities.ts` 各自实现费用和 edge。 |
| 3 | 重复活跃运行路径 | REJECT | monitor 入口仍唯一，但存在两套 opportunity/fee 计算路径。 |
| 4 | OpportunityRecord 不可变、可追溯、PIT | REJECT | 只有 TypeScript `readonly`，没有深冻结、版本化 schema、config/Git/session/input lineage 或 receive watermark。 |
| 5 | lead-lag 本地 receive/monotonic 顺序 | REJECT | 运行时只保留墙钟 receive time；没有进程 clock domain、monotonic receive time 或全局 ordinal。 |
| 6 | provider timestamp 与网络延迟 | **CRITICAL** | `receive_time - provider server/source time` 被写入 `receiveLatencyP50/P95`。provider clock 语义未验证。 |
| 7 | 50–3000ms horizon 因果性 | REJECT | horizon 网格未实现，无法证明 point-in-time as-of 或排除未来数据。 |
| 8 | 四个来源独立统计 | REJECT | stream count 分开，但 lead-lag 只使用相邻 Binance spot 值，且 relay 可与 spot 展示值合并。 |
| 9 | complete-set 双腿、费用、共同数量 | **CRITICAL** | common visible size 正确；费用公式重复、4B 路径使用 IEEE-754 `Number`，且没有五位小数舍入证据。 |
| 10 | maker fill/queue/rebate | PASS | maker observer 不生成 fill，不声明 queue position，rebate 仍为 scenario。 |
| 11 | stale/disconnect/空侧/crossed/reconnect | PASS_WITH_FIXES | `PublicOrderBook` 大部分失败关闭，但 quarantine/connection provenance 未完整传播到 opportunity。 |
| 12 | metrics 不静默保存 raw | PASS | metrics recording policy 明确 `writesRaw=false`，专项测试通过。 |
| 13 | live/User Channel/签名/订单可达路径 | PASS | 实时入口没有 live client factory、User Channel、签名器或订单调用；安全计数固定为零。 |
| 14 | detached session 复用现有 CLI | NOT_REACHED | 尚无 wrapper；因 Critical 阻断不得进入该阶段。 |
| 15 | 文档证据是否提前下结论 | REJECT | Reuse Gate 写为通过，Opportunity 合同称不可变且四类完整，但实现与证据不足。项目 CURRENT 仍停在 Batch 3B。 |

## Critical 阻断

1. **时间语义错误**：provider clock delta 被命名为 receive latency；亚秒跨来源排序没有
   可比较的本地 monotonic clock domain。
2. **静默异常**：`captureUntil` 使用空 `catch`，连接失败没有 incident、状态转换或可审计
   stop reason，不能证明没有静默丢事件。
3. **费用与金额口径分叉**：实时 paper 与 4B opportunity 重复公式，后者通过 JavaScript
   `Number` 计算业务金额；五位小数舍入和 evidence binding 不完整。
4. **观测证据不足**：单条 quote 可直接标为 `RESEARCH_CANDIDATE`，记录与路线结论未分离；
   runtime immutability、provenance、schema 和 deterministic hash 均不足。
5. **lead-lag 合同缺失**：四来源、触发窗口、固定 horizon as-of、censoring、重叠 trigger
   episode 与完整网格均未实现。

## 已验证但不足以放行的基线

- Node：53/53 passed。
- Python：182/182 passed。
- TypeScript typecheck、Ruff、`git diff --check` passed。
- 没有凭据、User Channel、live client、签名、订单或长期会话。

## 唯一允许的下一步

执行独立 **Batch 4B-R1: Critical Time, Fee and Opportunity Contract Remediation**。必须先写
失败测试，收敛为单一 receive-time、incident、fee/edge、observation 与 lead-lag 合同；本批
自身不运行长期观测。只有第二次 Sol 只读复核给出
`PASS_FOR_OBSERVATION_RERUN` 或 `PASS_WITH_NONBLOCKING_EVIDENCE_DEBT`，后续批次才可重新
预注册 24 市场实验。
