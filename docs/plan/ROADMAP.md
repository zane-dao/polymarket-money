# 阶段路线

本文件只描述阶段顺序、进入条件和退出证据。当前停点见 `CURRENT.md`；具体批次计划位于
`docs/batches/`，已完成的早期迁移计划仅在 `docs/archive/legacy-engineering/` 中追溯。

| 阶段 | 目标 | 退出证据 | 状态 |
|---|---|---|---|
| 0 综合审计 | 判断两个参考项目的可复用性与阻断风险 | 模块盘点、Critical/High 清单、目标架构 | 已完成 |
| 1 安全/domain/golden | 固定 live 边界、时间、业务与会计裁判 | 离线负向测试、三个人工 PnL、无 live adapter | 已完成 |
| 2 只读数据链 | 市场发现、公共行情、Chainlink、不可变 raw 与 manifest-gated replay | 可重放 hash、gap/stale fail closed、provenance | 已完成 |
| 2.5 point-in-time normalized gate | 冻结可见性、lineage、质量传播和不可变 dataset version | 119 Python、40 Node、干净安装、offline reload、tag | 已完成 |
| 2B 长期采集监督（可选前置） | reconnect、退避、断线区间、长期质量与恢复证据 | 多小时 fault injection、无静默缺口声明、恢复报告 | 未授权 |
| 3A 回测内核 | 样本准入、因果 replay、ask/bid、延迟、PIT fee、部分/未成交和逐 fill PnL | 155 Python、40 Node、三人工市场、clean install、tag | 已完成 |
| 3B 真实历史回测 | 在合格 normalized 历史样本上验证费用、代表性与独立 holdout | 5,599 市场、官方标签/静态 fee、固定 holdout、172 Python、40 Node、弱信号结论 | 已完成 |
| 4 模型赛马 | 比较市场、0.5、GBM/EWMA、J/K、逻辑回归与条件波动候选 | 独立样本校准、净 PnL、稳定性和失效条件 | 进行中；规范化 K/J EWMA paper 已完成，无稳定正 edge |
| 5 执行与恢复 | 中央风控、订单状态、持久账本、对账与恢复 | crash-point、部分成交全排列、零未解释差异 | 未开始 |
| 6 Shadow | 无真实资金地核对实时决定和账户等价账本 | 预定观察期内状态长期一致 | 未开始 |
| 7 极小实盘 | 经单独授权验证端到端安全与执行 | 独立审批、硬上限、kill switch、复盘 | 未授权 |

阶段不能因为“代码能跑”而跳过。3B 的弱信号不等于策略盈利或 shadow/live 获批；复杂模型
研究必须重新预注册，不能用 Final Test 反向调参。
