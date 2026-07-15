# Causal Replay Contract

回放输入只能是发布后的 point-in-time normalized dataset。每个决策点仅能看到
`visible_at <= decision_time` 且 `source_time <= decision_time` 的记录；未来新增盘口会改变
dataset/replay hash，但不能改变更早的 Decision 或 Fill。

回放时钟只能前进。策略输出必须使用 Batch 1 的 `Decision` 与 `OrderIntent`，token 必须属于
当时的 Up/Down 映射，模拟意图不得声称真实 `order_send_time`。`decision_id`、`intent_id` 和
`idempotency_key` 在单次回放内受注册表约束：同 ID 不同内容失败关闭，重复意图不得再次
进入执行或账本。Fill、Settlement、PnL 复用 Batch 1 的领域模型和 `FillLedger`。

结算只能发生在市场结束后，开收价必须来自同一市场的 Chainlink BTC/USD 精确边界记录，
且在结算时已因果可见、无 active quarantine 或业务键冲突。平价仍按 `close >= open` 结算
Up。结算时点属于 replay 配置并参与配置 hash。

结果绑定 dataset hash、加载 receipt、代码 SHA、策略 fixture、准入版本、执行配置、费率表
和结算时点。运行前会重新读取关键源码并核对 import 时的代码 SHA，检测到进程内源码漂移
即停止。本批是按预设 fixture decision points 查询 PIT 视图，不宣称实现了通用 ordinal
逐事件策略调度器。

