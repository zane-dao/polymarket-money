# Batch 3B Unresolved Issues

## High

- 第三方 Polymarket ticks 连续性不可证明，保持 `UNVERIFIED`；没有 receive time，也不是完整 L2。
- Final Test 只有 5 天/1,279 个市场，按日 bootstrap 只有五个独立 block，统计功效有限。
- 1 Hz 数据无法模拟 250ms；BASE_1S 仍是离散采样近似，不是实盘延迟测量。

## Medium

- 没有逐市场 Chainlink 开收盘价证据，只能使用官方最终 resolution；Binance 是 proxy。
- 手续费为 `MARKET_STATIC_OFFICIAL`，不是交易时点保存的 token fee-rate 响应。
- B3/30 的小幅正值集中于 UTC 06-11 和低波动组，并对 +1 tick 压力不稳。
- ask-side 只有最佳档；无法估算 1 share 之外的冲击和隐藏流动性。

## Low / engineering

- 首次通过门禁的 manifest 保存的是固定 revision/hash 加数据集首页 URL；代码已修为精确
  pinned file URL，但按不可变原则没有覆盖第一次 Final Test 数据版本。
- 当前 frozen diagnostics 是主结果后的只读描述性汇总，不是 primary result 的一部分；两者
  通过 dataset/config hash 绑定。

这些问题禁止把本批解释为盈利证明、shadow 授权或实盘授权。

