# 项目规范

本文件只保存跨阶段稳定、可检验的项目规范。实现细节以代码仓文档和测试为准；阶段顺序
以 `docs/plan/` 为准；历史原因以 `docs/background/` 为准。

## 0. 最新会话与旧文档冲突

- 在不违反系统级指令、安全红线和已验证事实的前提下，用户最新会话中的明确要求优先于
  本项目旧文档。
- AI 必须在同一实质任务内同步修正文档，不能一边执行新要求、一边让旧约束继续误导后续
  会话。
- 具体处置由 AI 根据追溯价值和误用风险选择：直接删除旧约束、移入 `archive/` 备份，或
  原位标注“已废弃/被何项决定取代”并链接新规范。
- 当前状态和操作指令通常直接替换；具有事故、审计或决策追溯价值的历史通常保留并标注；
  凭据、真实账户数据和不应保存的敏感内容不得因“备份”而留存。

## 1. 产品范围

- 目标市场：Polymarket BTC Up/Down 五分钟预测市场。
- 目标能力：可信数据、确定性研究、可执行回测、风险控制、影子核对，以及在未来单独
  审批后的极小资金实盘。
- 当前不承诺盈利，不把能运行、旧测试通过或样本内收益当作实盘证据。

## 2. 安全规范

- `LIVE_TRADING_ENABLED=false` 必须是代码、示例、测试和未来部署模板的默认值。
- 未经单独明确授权，不构造真实交易客户端，不签名，不连接私有用户频道，不下单或撤单。
- 不读取、输出或保存真实私钥、助记词、API Key、cookie、钱包凭据或账户数据。
- 测试和研究必须能在无凭据、离线环境运行；任何未知执行结果 fail closed。
- `PROD`、`FORCE_PROD` 等第二套生产开关不得与唯一 live gate 并存。
- 参考项目始终只读，不整体复制；采用任何代码前必须验证行为、许可证和来源。

## 3. 业务规范

- 市场身份必须证明 slug/condition、五分钟起止边界和唯一 Up/Down token 映射。
- 结算依据是 Chainlink BTC/USD；结束价大于或等于开始价时 Up，否则 Down。
- BUY 的可执行参考价是 ask，SELL 是 bid；mid、last 或信号价不能冒充 fill。
- 未成交不产生仓位；部分成交逐 fill 记账；fee、payout、gross PnL、net PnL 分开。
- fill、settlement、OrderIntent 都必须有稳定身份；重复事件不得重复记账或重复执行。
- unknown order outcome 只能进入查询/对账，不得自动盲重试。

## 4. 数据与时间规范

- `source_time`、`server_time`、`receive_time`、`decision_time`、`order_send_time`、
  `fill_time`、`settlement_time` 含义必须分开；禁止一个模糊 `timestamp` 兼任多种时间。
- 实时 ingest 需要额外记录 process/persist time；源未提供的时间必须为空，不能伪造。
- 晚于 decision time 才可见的数据不得用于该决定；回放必须按 point-in-time 可见性推进。
- 价格、数量、金额和费用必须有明确单位、精度与舍入；账本真相不得使用无单位浮点数。
- 数据集、配置和模型产物必须可追溯到版本/hash、时间范围、适用条件和失效条件。

## 5. 架构规范

- `/root/projects/polymarket-money` 是新代码与工程文档的唯一写入仓。
- Python 负责研究、离线数据、特征、模型评估和回测；不得拥有真实执行凭据。
- TypeScript 负责未来实时适配、中央风控、订单状态、账本、恢复和监控。
- domain 不依赖 vendor SDK；外部 I/O 只在 adapter；策略为显式输入到显式输出的纯函数。
- exchange truth、append-only events 和 reconciliation 高于进程内缓存或单次 API 响应。

## 6. 证据门

只有前一门有可重复证据时才进入下一门：

```text
数据/身份/时间/结算可信
→ ask/bid、fill、fee、PnL 与回测可信
→ 简单基线在独立样本扣成本后有效
→ 复杂模型确有增量
→ shadow 状态长期一致
→ 单独审批的极小实盘
```
