# 2026-07-15 综合审计摘要

## 目标

在不迁移代码、不读取凭据/真实 DB、不联网交易的前提下，审计旧项目数据、时间、标签、
回测、费用、成交和 PnL，并评估开源引擎与前三批迁移顺序。

## 事实与证据

1. 旧 Binance bookTicker parser 返回四元组，recorder 按二元组解包，可在首帧失败。
2. 旧 Polymarket parser 要求顶层 asset_id 并读取 `changes`，与当前官方
   `price_changes[]` 结构不兼容。
3. 旧 buy 决策使用 best ask，但决定后立即记为全成；没有延迟、队列、多档、部分成交、
   拒单和真实 sell/bid 路径。
4. simulated records 会进入主绩效；fee 配置/发现值冲突；回放有当前配置、未来校准常量、
   records 选 tick、事后质量筛选和同窗选参偏差。
5. 旧 live API/订单路径缺安全和幂等边界，真实提交后本地错误可诱发重复请求。
6. 开源引擎有生产门禁分叉、部分成交提前 settle、状态/恢复孤儿单、实际 fill/fee 丢失等
   阻断问题。

详细证据：`/root/projects/polymarket-money/docs/audit-findings.md`。

## 模型结论

- 旧 GBM 使用每 √秒 sigma 与剩余秒数，量纲一致，但固定正态/漂移口径不够。
- GBM 仅作基线；逻辑回归是简单基线；GARCH 系列用于条件方差，不自动产生方向 alpha。
- VaR/CVaR 用于组合尾部风险，不是方向信号。

## 决定

- 不迁移旧实盘、立即全成、旧订单/PnL 真相。
- 开源 SDK/结构只能在新 adapter 与契约测试之后使用。
- 前三批依次为：安全/模型/golden；只读数据/时间/存储；可信回测/fee/fill。
- 前三批不包含 private WS、签名、shadow、部署或 live。

## 验证

- 新项目 TypeScript typecheck：通过。
- 新项目 Python 配置测试：1 项通过。
- 旧项目定向纯 Python fallback：51 + 57 = 108 项通过。
- 两个参考仓库 tracked 状态未改变。

## 未决

- 下一阶段具体提示词和批次 1 的实现授权。
- 项目专用 Skill 是否在重复两次以上稳定工作流后提炼；当前不创建交易 Skill。

