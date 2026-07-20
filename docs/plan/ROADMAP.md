# 阶段路线

本文件只描述阶段顺序、进入条件和退出证据。当前停点见 `CURRENT.md`；具体批次计划位于
`docs/batches/`，已完成的早期迁移计划仅在 `docs/archive/legacy-engineering/` 中追溯。

| 阶段 | 目标 | 退出证据类型 |
|---|---|---|
| 0 综合审计 | 判断两个参考项目的可复用性与阻断风险 | 模块盘点、Critical/High 清单、目标架构 |
| 1 安全/domain/golden | 固定 live 边界、时间、业务与会计裁判 | 离线负向测试、人工 PnL、无 live adapter |
| 2 只读数据链 | 市场发现、公共行情、Chainlink、不可变 raw 与 gated replay | 可重放 hash、gap/stale fail closed、provenance |
| 2.5 point-in-time normalized gate | 冻结可见性、lineage、质量传播和 dataset version | 干净安装、offline reload、验收报告 |
| 2B 长期采集监督（可选前置） | reconnect、退避、断线区间、长期质量与恢复证据 | 长时故障注入、无静默缺口声明、恢复报告 |
| 3A 回测内核 | 样本准入、因果 replay、ask/bid、延迟、PIT fee、部分/未成交和逐 fill PnL | 人工市场、因果测试、验收报告 |
| 3B 真实历史回测 | 在合格 normalized 历史样本上验证费用、代表性与独立 holdout | 官方标签、固定 holdout、研究结论 |
| 4 模型赛马 | 比较简单基线、J/K 与条件波动候选 | 独立样本校准、净 PnL、稳定性和失效条件 |
| 5 执行与恢复 | 中央风控、订单状态、持久账本、对账与恢复 | crash-point、部分成交全排列、零未解释差异 |
| 6 Shadow | 无真实资金地核对实时决定和账户等价账本 | 预定观察期内状态长期一致 |
| 7 极小实盘 | 经单独授权验证端到端安全与执行 | 独立审批、硬上限、kill switch、复盘 |

本文件不维护完成状态；当前停点只看 [CURRENT.md](CURRENT.md)，历史验收只看
[报告索引](../../reports/REPORTS-INDEX.md)。阶段不能因为“代码能跑”而跳过，复杂模型研究
必须重新预注册，不能用 Final Test 反向调参。
