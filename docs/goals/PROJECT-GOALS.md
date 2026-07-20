# 项目目标

建立一套可信、可复现、可迭代的 Polymarket BTC 五分钟研究与 paper 系统：先证明市场身份、数据时间、结算、模拟成交与 PnL 可信，再评估策略是否在独立样本扣除费用、滑点、延迟和未成交后仍有稳定增量。只有在全部证据门通过且用户另行明确批准后，才讨论 shadow 或极小资金实盘。

当前阶段只允许公开数据、离线研究和有界 paper；`LIVE_TRADING_ENABLED=false` 持续有效。详细目标树见 [SUBGOALS.md](SUBGOALS.md)，稳定边界见 [项目规范](../spec/PROJECT-SPEC.md)。
