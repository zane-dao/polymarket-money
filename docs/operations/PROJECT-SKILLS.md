# 项目 Skill 状态

当前已安装 Polymarket 官方 `web3-polymarket` Skill，位置为
`.agents/skills/web3-polymarket/`，来源为 `Polymarket/agent-skills`，安装时对应官方
`main` 提交 `91ee44ae113e958affd20cd505c6e9d9d6100e0b`。

该 Skill 只在本仓范围内提供 Polymarket API、市场数据、WebSocket、认证和订单协议参考。
它不能覆盖本项目安全边界：默认只允许公开数据、离线研究和有界 paper；不得读取凭据、
签名、连接私有用户频道或下单，`LIVE_TRADING_ENABLED=false` 持续有效。任何联网采集或
真实账户操作仍须按用户层与仓库规则另行批准。

新增或更新项目 Skill 时，必须审计来源和安全范围，并登记触发条件、输入、输出、禁止事项
和版本；不得包含凭据或默认 live 操作。
