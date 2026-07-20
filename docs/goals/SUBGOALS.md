# 子目标树

总目标的一段式版本在 `docs/goals/PROJECT-GOALS.md`，每次标准加载时读取。本文件只在拆任务、判断优先级
或研究模型时按需读取。

## G1 可信输入

- 唯一识别 BTC 五分钟市场、Up/Down token 和 Chainlink 结算规则。
- 保存不可变 raw events、明确时间语义、gap/stale/clock health 和 provenance。
- 任何当时不可见的数据不能进入特征或决定。

## G2 可信成交与会计

- BUY/SELL 分别使用 ask/bid，并模拟延迟、深度、排队、拒绝、未成交和部分成交。
- 逐 fill 保存实际价格、费用、身份和 finality。
- 现金、仓位、结算与 PnL 可从事件确定性重算并与 exchange truth 对账。

## G3 样本外有效策略

- 先比较市场价格、0.5、GBM/EWMA 和正则化逻辑回归等简单基线。
- GARCH/GJR/EGARCH/CGARCH/APARCH、Student-t/skew-t、HMM/regime 和漂移模型只作
  离线候选；条件方差改善不等于方向 alpha。
- 采用 purged walk-forward、embargo 和 untouched holdout；报告 Brier、log loss、校准、
  成交后净 PnL、稳定性和失效条件。
- VaR/CVaR 用于组合 sizing 与尾部风险，不生成方向信号，也不替代硬风控。

## G4 可恢复的安全执行

- 统一 RiskDecision、OrderIntent 幂等协议、用户订单状态、append-only ledger 和恢复对账。
- unknown outcome、断线、stale、磁盘异常和账本差异一律 fail closed。
- shadow 中长期保持本地状态与外部真相一致。

## G5 受控实盘

- 只有 G1-G4 全部有证据且用户另行明确批准，才讨论极小资金 live。
- live 必须有账户/市场/金额硬绑定、短时 arming、kill switch、审计和回滚方案。
