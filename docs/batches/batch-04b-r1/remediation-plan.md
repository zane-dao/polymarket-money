# Batch 4B-R1 remediation plan

状态：**FROZEN**  
基线：`ef3c045`（包含不可覆盖的 `SOL-REVIEW.md`）  
分支：`batch/4b-critical-remediation`

本批只修复 Sol 复核确认的时间、静默异常、费用/edge、Opportunity 证据和 lead-lag 合同。
不运行长期观测，不接触交易能力，不修改参考项目。

## Critical 映射

| 组 | 当前位置/行为 | fail-first | 唯一权威实现 | 最小修改 | 验收 |
|---|---|---|---|---|---|
| 时间语义 | `public-sources.ts` 只采墙钟；`live-runtime.ts` 把 provider delta 叫 receive latency；raw v1 无 monotonic | 同 ns ordinal、跨 domain、两类连接、v1 禁亚秒、replay/runtime 同序 | 进程级 `ReceiveClock` + `ReceiveStamp` | 网络边界采样；raw v2；v1 只读 | wall 不参与亚秒；完整 stamp 进入 lineage/hash |
| 静默异常 | `captureUntil` 空 catch；writer/observer 终止不完整 | incident、quarantine、writer 失败、emergency sink、无后续 observation | `RuntimeIncident` + 单一 incident writer | 所有 catch 明确处置；writer failure 一次性终止 | 无空 catch/吞 rejection；非零退出可证 |
| 费用/edge | `paper.ts`、`opportunities.ts` 重复公式；4B 使用 `Number`；Python FeeModel 是旧 notional 公式 | 官方表、五位小数、tie、小额、分数数量、双腿、跨语言、全局 Decimal 隔离 | TS `FeeEdgeCalculator` + Python `FeeModel` 同一合同/fixture | 锁定 `decimal.js@10.6.0`；旧 observer 只委托 | 一条活跃公式；无业务 binary float；fixture 完全一致 |
| Opportunity | 单次记录携带路线结论；无深冻结/provenance/schema/hash | 深冻结、缺字段拒绝、确定性 hash、输入变化、质量拒绝、往返 | `OpportunityObservationV1` / `RouteEvaluationV1` | 单次事实与聚合路线分离 | 当前路线只可 `DATA_INSUFFICIENT` |
| lead-lag | 只比较相邻 spot，固定 5bp；无 as-of/horizon/grid/episode | baseline/horizon as-of、censor、四来源、252格、连接重置、episode | 一个纯 `LeadLagEngine`，runtime/replay 共用 | 完整预注册合同，不运行长样本 | 无未来数据；所有格输出；不把重叠 trigger 当独立样本 |

## 冻结接口

### ReceiveStamp

`(clock_domain, local_monotonic_receive_ns, local_receive_ordinal)` 是唯一亚秒顺序键。同 domain
后才能比较；同 ns 用 ordinal 定序。wall time 只审计。HTTP 和所有 WebSocket 使用同一
进程 clock domain 与 ordinal allocator。

Cross-venue 对象必须同时保存 `external_connection_id`、`polymarket_connection_id` 和
`clock_domain`。baseline 与外部事件同连接；trigger snapshot 与固定 horizon 同 Polymarket
连接。任一重连 censor 未完成 horizon 并结束 episode。

### raw v2

新 writer 只写 `raw-event-v2`：明确 local wall/monotonic/ordinal、clock domain、transport
connection、provider source/server time。v1 仅离线读取，因无 monotonic 证据不得进入亚秒
lead-lag。normalized v1 `receive_time` 继续是墙钟可见性，不是亚秒时钟。

### Decimal Reuse Gate

现有 TS 精确算术分散且功能不足；Python Decimal 只能做离线裁判；官方 SDK 的金额表示不能
作为本项目独立、安全、无交易面的 TS 运行时合同。采用精确锁定 `decimal.js@10.6.0`，通过
`Decimal.clone` 建立模块私有 `money-decimal-v1`：precision 80、ROUND_HALF_EVEN、
toExpNeg -100、toExpPos 100。wrapper 只接受 canonical 普通十进制字符串，拒绝 number、
指数、NaN/Infinity/负零。官方未证明五位小数精确 tie 的规则，tie 固定返回
`ROUNDING_TIE_UNVERIFIED` 并拒绝 verified net edge。

### Baseline 与 horizon

`baseline_target = event_stamp - window`；取同来源/domain/external connection、stamp 不晚于
target 的最新合格状态。必须记录 target/observation、age、effective window；无状态、过旧、
跨连接时拒绝，不插值/backfill。

`horizon_target = trigger_stamp + horizon`；主要 markout 只取不晚于 target watermark 的同
domain/Polymarket connection/market 合格 as-of 盘口。记录 state age；过旧或质量故障时
censored。target 后首更新单独写 `next_update_after_horizon`，绝不冒充固定 horizon。
runtime timer 与 replay 调用同一纯 as-of 实现。

Horizon artifact 必须分别保存 trigger-time 与 horizon-state Polymarket lineage；坏帧使旧好状态
失效，信息类 CLOB 帧不得刷新盘口 age。Route-bound fixed-horizon facts 不得混入 target 后的
next update；分数毫秒以 canonical decimal string 落盘。

### Episode

配置/hash 固定 `episode_rule_version=lead-lag-episode-v1`、`episode_gap_ms=500`、grouping
dimensions 为 source/direction/market/domain/external connection/Polymarket connection，
连接重置行为为 `END_EPISODE_AND_CENSOR_PENDING`。同 external event 的多阈值/窗口共享
overlap group；同向相邻合格事件可延伸 episode。episode summary 记录 start/end/duration/
trigger count。它只是聚类键，不证明统计独立；后续统计仍须 market/time block。

### 离线一致性补充验收

Python 必须读取并 normalize raw-event-v2；manifest 在 dataset 内强制同 clock domain、schema
一致、ReceiveStamp 与 ordinal 严格递增。manifest segment ordinal 与 receive ordinal 不得混用。
离线质量报告只能把 provider/local wall 差值称为 clock delta，禁止称为 receive latency。

## 提交与验证纪律

每组先提交可复现失败测试及 `FAIL-FIRST-EVIDENCE.md`，再提交最小实现并跑定向测试；最后
执行全量 Python、R1 专项、Ruff、clean venv、pip check、npm ci、Node、TypeScript、diff、
dependency audit。第二次 Sol 只读复核只能给出规定的三个结论。本批无论结论如何都不启动
24市场/150分钟会话，也不创建 Batch 4A/4B tag。
