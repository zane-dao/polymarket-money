# 项目背景

本文件是标准必读背景摘要，只说明“为什么存在这些约束”。详细证据按根索引进入
`docs/archive/sessions/` 或代码仓审计文档。

## 起点

用户希望最终研究并实盘运行 Polymarket BTC 五分钟预测市场策略，目标是可持续盈利，而
不是单纯做一个下单机器人。旧系统 `polymarket-paper` 已积累 BTC 五分钟、Chainlink、
多源行情、模拟交易和回测经验，但结构、数据因果、成交假设与实盘安全不足，因此决定在
新仓 `polymarket-money` clean-room 重构。

## 三个参考来源

- 旧 AI/知识工作区：`/mnt/d/polymarket-paper`，只读。
- 旧代码仓：`/mnt/c/Users/seeta/Desktop/hello-world`，只读；Python 包在
  `polymarket_paper/`。
- 开源引擎：`/root/projects/olymarket-trade-engine`，只读；实际目录名缺开头 `p`。
- 学习材料：`/mnt/d/polymarket-learn`，只读；用于 GARCH、HMM、VaR/CVaR 等模型背景。

用户明确认为固定 GBM 不足以处理波动聚集、肥尾和漂移，应评估 GARCH 及其演化模型，
并考虑 VaR/CVaR。项目接受这一研究方向，但审计结论是：复杂波动模型不会自动产生
BTC 五分钟方向 alpha，必须在可信数据与成交模型之后做独立样本验证。

## 综合审计结论

- 旧项目不能直接迁移：数据录制/WS、单一时间、理想化全成、fee、回放选择偏差、实盘
  API 与幂等边界都有阻断问题；旧 108 项测试通过不证明旧假设正确。
- 开源引擎不能直接接入：生产开关分叉、部分成交、实际 fill/fee、账本、恢复和对账不可信。
- 两者只提供业务知识、事故反例、脱敏 fixture、测试场景和经验证后可放入 adapter 的协议
  能力。新主项目必须拥有 domain、安全、风险、账本和恢复真相。

## 工作区分层

- 用户层：跨项目通用规则。
- 本仓 `docs/` 与 `reports/`：项目目标、规范、状态、决定、Batch 设计和执行证据。
- 本仓其余目录：代码、测试、配置与小型确定性 fixture。

原始数据、数据库、凭据、模型大文件和完整会话转储不放进本仓。
