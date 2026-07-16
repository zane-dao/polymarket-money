# Batch 4B-R1 opportunity observation contract

状态：**IMPLEMENTED / ROUTE DATA INSUFFICIENT**

## 两层对象

`OpportunityObservationV1` 只表示一次事实；`RouteEvaluationV1` 才表示聚合判断。单条
observation schema 不允许 route/candidate 字段。当前 RouteEvaluation 构造器的唯一决定是
`DATA_INSUFFICIENT`，因此本批不能凭一条报价恢复 `RESEARCH_CANDIDATE`。

Observation 必填：确定性 `observation_id`/hash、family、market、UTC wall audit time、完整
ReceiveStamp watermark、父输入 reference/hash/stamp、producer、git commit、session ID、
config hash、quality/rejection、fee evidence reference、continuity、gross/scenario net edge、
visible size、eligibility 和 facts。精确金额均是 canonical decimal string。

对象递归复制并深冻结；canonical JSON 对 object key 排序，hash 包含完整 ReceiveStamp 和
所有 lineage/provenance。解析器使用字段 allowlist 重建对象并重新计算 ID/hash。未知字段、
缺 provenance、篡改 hash、负 visible size、非 PASS eligible 或 ineligible 无拒绝理由均失败。
每个 parent stamp 必须与 observation 同 clock domain 且不晚于 observation watermark。

运行时的 `opportunity-runtime-config-v1` hash 明确绑定 mode、record mode、complete-set 1000ms
latency、fee evidence policy、CLOB continuity 和 lead-lag config hash。普通盘口 observation
使用原子 parent/hash/stamp 三元组；坏帧不能把旧 parent 与新 hash 拼接。每个完成或 censored
horizon 都生成独立 `CROSS_VENUE_LEAD_LAG` observation，RouteEvaluation 只引用这些 hash，
不再用同市场 NO_TRADE / maker 记录冒充 lead-lag 证据。

RouteEvaluation 单独保存 observation hashes，以及 raw trigger、unique episode、unique market
三种计数。episode 只是聚类键，不自动代表统计独立性；最终置信区间仍需 market/time block。

## 证据

专项测试覆盖深冻结、嵌套篡改、序列化往返、确定性 hash、ReceiveStamp ordinal 变化、输入
变化、显式 git/session/config 缺失、future lineage 拒绝、分数毫秒 canonical facts、真实
lead-lag route binding 和单条 route conclusion 拒绝。
