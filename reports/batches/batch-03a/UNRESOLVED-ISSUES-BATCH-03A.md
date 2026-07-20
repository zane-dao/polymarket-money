# Batch 3A Unresolved Issues

## High

- 连续性仍为 `UNVERIFIED`，本批不尝试修复或推断缺失数据。
- 尚无带来源 hash 的真实历史费率证据；人工费率只能验证计算，不能验证真实净收益。
- 尚未在真实历史 normalized 数据集上运行，不能得出任何策略盈利或市场代表性结论。

## Medium

- 执行模型不含队列位置、隐藏流动性、maker 成交概率、真实撮合优先级或 rebate。
- 当前回放按显式 decision points 查询 PIT 视图，不是通用 ordinal 逐事件调度器。
- 身份缺失市场没有可信窗口，不进入时间覆盖率分母，只单独计入 excluded 数量。
- normalized Chainlink 边界现在可同时作为前一窗口 close 与后一窗口 open；已有回归测试，
  但真实历史数据应用前仍应审阅来源语义。
- Batch 2B 的长期重连监督仍暂缓；跨进程写入仍限定单写者，DrvFS 仍不验收。

## Low

- JSONL/内存加载的长期性能尚未评估。
- 尚未生成可视化或策略层统计，因为 3A 明确禁止模型和盈利分析。

