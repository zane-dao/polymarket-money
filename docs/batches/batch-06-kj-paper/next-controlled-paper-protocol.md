# 下一轮受控 Public Paper 协议（未启动）

状态：**设计已冻结，尚未获得本轮联网启动授权**  
前提：本地研究与 paper MVP 已通过
[`mvp-console-acceptance.md`](mvp-console-acceptance.md) 的产品验收。

## 1. 研究问题

本轮不是为了证明收益，也不允许在运行中调整策略。唯一的运行期问题是：在相同、预先绑定的
五分钟市场窗口中，冻结的 K/J 策略使用 Binance Spot 或 Polymarket RTDS Chainlink relay 作为
信号源时，能否各自生成完整、可重放、正式结算的 paper 记录；并描述两条独立数据路径下的
决策、成交模拟、结算等待和 PnL 差异。

这不是“哪个信号源更好”的显著性检验。两路 receive clock 不可比较，Chainlink relay 也不是
正式结算依据；Gamma/UMA 官方结果仍是唯一结算来源。

## 2. 冻结对象

| 项目 | 冻结值 |
|---|---|
| 策略 | 当前 commit 中的 K/J；不改参数、不混入 L |
| 信号源 | `BINANCE_SPOT` 与 `POLYMARKET_RTDS_CHAINLINK`，每腿独立 EWMA、journal、钱包和 lifecycle |
| 预热 | 180 秒、独立 `WARMUP_SIGNAL`、在首目标市场前结束 |
| 每轮目标 | 3 个完整 BTC Up/Down 五分钟市场 |
| 轮次 | 4 个不重叠轮次；相邻轮次间隔 2 个市场 |
| 结算宽限 | 600 秒；只允许 `paper:settle -> paper:finalize -> paper:report` 恢复已冻结窗口 |
| 计划绑定 | 启动前生成单个 `kj-signal-compare-campaign-artifact-v1`，绑定 collector commit、每轮窗口和 source mapping |

实际的 campaign ID、commit、时间窗口和 canonical hash 必须在用户批准启动后，由
`paper:signal-compare-campaign-plan` 一次生成；不得在本文档中预填会过期的时间。

## 3. 不允许的行为

- 不因任何中途 PnL、成交率、来源差异或市场方向更改参数、轮次、窗口或信号源。
- 不错过窗口后平移、补跑或以其他单场代替原计划轮次。
- 不把 L V2 接到 realtime paper：其历史 receipt 仍缺连续 CLOB quote velocity 与 point-in-time
  Chainlink boundary，且 Validation 的集中度压力为负。
- 不把 paper fill、RTDS relay、静态 PnL 或本轮样本解释为真实成交、策略盈利、shadow 或 live 许可。

## 4. 单轮验收与失败分类

每条腿必须同时满足：

1. `accepted=true`，hash-chained v3 run plan 在任何 context/warmup 前持久化；
2. 恰好 3 个目标市场、无额外 engine market、无 pending intent/market；
3. 180 秒 warmup 的 durable count/span/source family 与计划一致；
4. 运行安全计数证明零 credentials、private channel、真实订单和 live client；
5. `paper:report` 重放通过市场身份、官方结算、journal tail、wallet 与 PnL 恒等式。

任意一条腿未通过时，该轮标为 `INCOMPLETE_EVIDENCE` 或相应技术失败；不重跑、不并入完整
campaign PnL 比较。完整 campaign 仅在四轮、每条腿、每个配对报告和两个同集合 cohort 报告
全部验证通过后，才能称为描述性样本。

## 5. 输出与解释

每轮输出两个 replay-verified paper report 和一个 paired report；完整后输出：

- Binance 与 Chainlink 各自的 campaign cohort PnL report；
- 同集合的 campaign cohort observability report；
- 一份只读 Dashboard 入口，显示结果但显式保留
  `profitabilityClaimEligible=false`。

报告应优先呈现样本数量、拒绝/未成交、结算等待、重连/隔离质量及风险分布；PnL 只是描述字段，
不得用四轮样本作参数选择。

## 6. 执行前核对清单

1. 用户对本次 public 网络采集给出明确批准；
2. 主仓干净，当前 commit 通过 Node、Python、Ruff、typecheck；
3. `LIVE_TRADING_ENABLED=false`，无凭据、无 private/user channel、无 order adapter；
4. 生成 artifact 后核对其 hash、轮次、market count、warmup、source mapping；
5. 仅启动 artifact 所规定的 launcher；启动后不改代码和计划。
