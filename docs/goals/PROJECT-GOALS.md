# 项目目标

建立一套可信、可复现、可迭代的 Polymarket BTC 五分钟研究与 paper 桌面系统：以
React + TypeScript 提供前端，以 Tauri 提供轻量桌面外壳和命令桥接，模块化业务后端与独立
策略模块通过明确接口协作，并保留已经验证的 TypeScript/Python 实现。先证明市场
身份、数据时间、结算、模拟成交与 PnL 可信，再评估策略是否在独立样本扣除费用、滑点、
延迟和未成交后仍有稳定增量。只有在全部证据门通过且用户另行明确批准后，才讨论 shadow
或极小资金实盘。

当前阶段只允许公开数据、离线研究和有界 paper；`LIVE_TRADING_ENABLED=false` 持续有效。详细目标树见 [SUBGOALS.md](SUBGOALS.md)，稳定边界见 [项目规范](../spec/PROJECT-SPEC.md)。
