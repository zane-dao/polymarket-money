# 第一批统一领域模型

## 范围

本批在 `research/polymarket_money/` 建立 Python 研究层的唯一业务语义。模型只依赖
Python 标准库，不导入旧项目、开源引擎、Polymarket SDK、网络客户端或环境变量。
金额、价格、数量和费用统一使用 `Decimal`；时间统一使用带 UTC 时区的 `datetime`。

这套模型是离线研究、黄金测试和以后适配层的裁判，不是实盘账本或交易客户端。

## 领域对象

| 对象 | 核心含义 | 关键约束 |
|---|---|---|
| `Market` | 一个确定的 BTC Up/Down 五分钟市场 | condition、slug、起止边界、oracle、token 映射均显式 |
| `OutcomeToken` | outcome 与 token ID 的映射 | 按 `Up`/`Down` 标签映射，禁止依赖数组位置 |
| `OraclePrice` | 某市场的一次 oracle 价格观察 | provider、pair、价格、source/server/receive time 分开 |
| `OrderBookSnapshot` | 单个 token 的可见盘口 | bid/ask 为 `Decimal` 价量；source time 缺失时显式为 `None` |
| `Decision` | 纯策略的确定性决定 | 有 decision time 和输入 receive watermark |
| `OrderIntent` | 尚未等同于交易所订单的下单意图 | 必须有非空幂等键；未发送时 send time 为 `None` |
| `Fill` | 已发生的一笔成交事实 | 每笔有实际价、数量、费用和 fill time |
| `Settlement` | 由规定 oracle 边界价推导的结算事实 | 只保存不可变 Market 与 opening/closing OraclePrice；winner、token、价格均为推导属性 |
| `Position` | fill 汇总出的 token 仓位 | 未发生 fill 就不存在 position |
| `PnL` | 市场级确定性损益结果 | payout、cash outlay、gross、fees、net 分开 |

辅助值对象包括 `OracleDefinition`、`PriceLevel`、`Outcome`、`Side` 和
`DecisionAction`。所有 dataclass 冻结；只有 `FillLedger` 在内部维护可变聚合状态。

## 时间词典

禁止使用无语义的单一 `timestamp`。Python 字段使用 snake_case；跨语言 schema 可映射为
同义 camelCase，但不得改变含义。

| Python 字段 | 含义 | 何时允许为空 |
|---|---|---|
| `source_time` | 原始数据源声明的观察/事件时间 | 数据源未提供时可以为 `None`，不得伪造 |
| `server_time` | provider/relay 服务器声明的发送时间 | provider 未提供时可以为 `None` |
| `receive_time` | 本地边界收到完整事件的时间 | 外部事件不可为空 |
| `decision_time` | 策略做出决定的显式时间 | 决定不可为空，不得读取系统当前时间代替 |
| `order_send_time` | 请求实际离开执行边界的时间 | 未发送的 `OrderIntent` 必须为 `None` |
| `fill_time` | 成交源声明的成交时间 | `Fill` 不可为空 |
| `settlement_time` | 结算被确认并应用到账本的时间 | `Settlement` 不可为空 |

`interval_start`/`interval_end` 是市场身份边界，不替代以上事件时间。
旧 TypeScript scaffold 中的 `exchangeTimestamp` 对应 source time，
`receiveTimestamp` 对应 receive time；`processTimestamp`/`persistTimestamp` 属于以后实时
ingest envelope 的处理与耐久化时刻。本批不在离线对象中伪造尚未发生的处理或持久化时刻。

## 已编码的业务规则

1. 市场 slug 必须是 `btc-updown-5m-<interval_start_epoch>`，周期严格为五分钟。
2. 结算定义必须是 Chainlink `BTC/USD`。
3. Up/Down token 通过 outcome 标签查找，顺序颠倒不影响结果。
4. `end_price >= start_price` 为 Up，否则为 Down。
5. `settlement_from_oracle` 只接受本市场同一五分钟窗口边界的 Chainlink 开盘/收盘价。
   `Settlement` 不接收 winner、token ID、start/end price 这些相互独立的构造参数；它从
   Market 和两个不可变 OraclePrice 推导，无法生成价格、方向和 token 自相矛盾的对象。
6. BUY 的可执行价为 best ask；SELL 的可执行价为 best bid；不使用 mid 伪造成交。
7. 仓位只由 `Fill` 创建；部分成交逐 fill 记账。
8. fill ID 和 settlement ID 幂等；同 ID 不同内容以及同市场第二个结算均 fail closed。
9. `data_time > decision_time` 的数据禁止进入特征。

`Market`、`OutcomeToken`、`OraclePrice` 和 `Settlement` 均为 frozen dataclass。结算完成后
修改 market、开收价、winner、token 或 settlement time 会被拒绝。

## 会计恒等式

`FillLedger` 采用以下离线黄金口径：

```text
net_cash_outlay = Σ(buy price × quantity) - Σ(sell price × quantity)
payout = winning token remaining quantity × payout_per_token
gross_pnl = payout - net_cash_outlay
net_pnl = gross_pnl - Σ(fill fee)
```

本批不实现 maker rebate、实际 Polymarket 舍入、short、exchange reconciliation、持久化或
未实现 PnL；这些必须在后续批次以新测试扩展，不能偷偷改变现有黄金结果。
