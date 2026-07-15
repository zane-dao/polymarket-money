# Batch 02.5：Point-in-time rules

## 唯一查询边界

公开 API 是：

```python
dataset.as_of(decision_time, market_id)
```

查询只读取 `market_id` 完全相同且 `visible_at <= decision_time` 的记录；若一条记录声明了
`source_time`，还必须满足 `source_time <= decision_time`，防止 provider future-clock 数据进入
当前 view。`source_time` 只是附加拒绝条件，绝不能代替 `visible_at` 降低可见门槛。查询不会跨
相邻五分钟市场，也不会访问网络、环境变量、数据库、当前系统时间或最终结算结果。

## 因果规则

1. raw 必须先经 manifest/segment 校验；验证后磁盘字节若变化，normalization 拒绝开始。
2. normalized fact 的可见时间不早于 receive、process、persist 以及用于归类它的 metadata。
3. 晚到事件在它的 `visible_at` 前完全不可见；较早的 `as_of` 结果不会因稍后查询而改变。
4. metadata 同时满足 `observed_at <= decision_time`、`valid_from <= decision_time` 才可采用。
5. 不做 backward fill、双向插值、centered rolling 或基于最终结果的历史修正。
6. Price 查询只选当前 market partition 中、在决策前可见且 `source_time` 最新的观察；晚到旧价
   不得覆盖已可见的新价。
7. 五分钟窗口是半开区间 `[interval_start, interval_end)`；边界价格只进入下一 market。
8. 同一 manifest 内的同毫秒 raw 事件按 segment、line、outer-array message ordinal 保留真实
   append 顺序，不能按随机 event ID 重排；跨 manifest 的 exact tie 若内容矛盾则失败关闭。
9. 本批没有特征、标签、收益、Fill、PnL 或回测逻辑。

`as_of` 对同一已发布版本是纯函数：相同输入得到相同 view。

## Revision、duplicate 与 conflict

- 同业务键且语义 ID 完全相同：合成一个 canonical record；
- canonical record 保留所有 lineage，`as_of` 只显示当时已经可见的 lineage count；
- 同业务键但语义不同：第一次冲突出现时产生 quarantine；
- 冲突发生前，原 record 仍可用于历史 view；冲突发生后，该业务键失败关闭；
- 不把稍后冲突或稍后 duplicate 的 ID/lineage 暴露给更早的 view；
- metadata revision 使用新的 observed/valid version，不覆盖旧 row；身份硬字段冲突则 quarantine。

因此，新增一个晚到输入可能扩展新时点的 view，但不能改变它尚未可见时的历史 view。

## 盘口状态机

| 状态 | 进入条件 | 可执行 |
|---|---|---|
| `WAITING_FOR_SNAPSHOT` | 新连接已建立，但当前 connection 的 Up/Down 任一 token 尚无完整 snapshot | 否 |
| `ACTIVE_UNVERIFIED` | 当前 connection 的两个 token 都有合法 snapshot、未过期、双侧非空、未 crossed | 条件满足时是 |
| `STALE` | 显式 stale，或 `decision_time - last_receive_time >= stale_after` | 否 |
| `DISCONNECTED` | 没有连接，或观察到断线/错误/timeout | 否 |
| `RESET_REQUIRED` | 当前 market/token 有 quarantine、crossed 或非法 delta/snapshot | 否，必须新连接基线 |
| `UNTRADEABLE` | 已有完整 snapshot，但 Up/Down 任一 token 的 bid 或 ask 为空 | 否 |

每次 `connection_open` 都使同 ID 的旧 book 失效，因此即使 provider 意外复用 connection ID 也
不能复活旧盘口；新 ID 同样不会继承旧 book。delta 到达前必须有该连接、该 market、该 asset 的
snapshot。非法或 crossed delta 不会部分应用。连接相关的 transient quarantine 只有在更新的
连接基线后才失效；身份/业务键冲突等 permanent quarantine 不会被重连清除。

状态是 market-wide gate，而不是两个 token 各自独立放行：任一 sibling token stale、空侧、
crossed、因果歧义或已有 active quarantine，Up/Down 两侧都继承同一失败状态并禁止执行。

## Execution eligibility

`execution_eligible=true` 必须同时满足：

- 当前连接为 CONNECTED；
- 当前连接已有 `snapshot_received=true` 的完整 book；
- state 为 `ACTIVE_UNVERIFIED`；
- metadata 身份合法且 Up/Down token mapping 在当时可见；
- 当前连接的 Up 与 Down token 都已有 snapshot；
- metadata 明确 `active=true`、`closed=false`、`accepting_orders=true`；
- `decision_time` 位于 `[interval_start, interval_end)`；
- market/token 没有已可见的 quarantine；
- bid 与 ask 均非空，且 `best_bid <= best_ask`。

任一 token 任一侧为空时，该 token 的 `best_*` 对应侧为 null、`midpoint=null`，整个 market
均为 `UNTRADEABLE` 且 `execution_eligible=false`。本批没有也不得添加 midpoint 填补、成交模拟
或队列假设。

## Continuity

公开源缺少可证明 gap-free 的 sequence/cursor，因此 raw、normalized record、manifest、view 和
book state 全部只允许 `UNVERIFIED`。代码和 schema 都拒绝 `VERIFIED`/`GAP_FREE`，本批也不
用 outer WebSocket batch 证明连续性。
