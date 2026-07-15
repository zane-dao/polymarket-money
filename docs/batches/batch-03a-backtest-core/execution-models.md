# Execution Models

四种模型都是显式假设，不是交易所成交重建：

1. `DEBUG_TOUCH`：在决策时点以买 ask、卖 bid 触碰成交，不计费；强制标记
   `NON_REALISTIC_DEBUG_TOUCH`，只用于调试。
2. `TAKER_TOUCH_WITH_FEES`：在决策时点以买 ask、卖 bid 成交，并按可执行时点匹配 taker
   费率。
3. `LATENCY`：从 `decision_time + latency` 开始等待目标 token 的第一条新盘口；没有新盘口、
   已过市场结束或新盘口重新准入失败时不成交，绝不复用旧盘口。
4. `DEPTH_AND_PARTIAL_FILL`：逐档消耗当时可见深度，逐 Fill 计费与舍入；深度不足时只登记
   已成交数量，并标记 `INSUFFICIENT_DEPTH`。

空侧不计算成交或 midpoint；陈旧、断线、重连未获新快照、reset、交叉盘口与隔离状态均为
零成交。可选 adverse ticks 只把买价上调或卖价下调，且仍必须满足限价及 `[0,1]` 价格域。
模型没有队列位置、隐藏流动性、maker 挂单成交概率或真实撮合优先级，因此不得作为实盘
成交保证。

