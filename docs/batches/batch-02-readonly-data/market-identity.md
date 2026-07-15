# Batch 02：BTC 五分钟市场身份

## 唯一接受规则

公开 Gamma 响应必须同时满足：

1. slug 完整匹配 `btc-updown-5m-{epoch_seconds}`；
2. epoch 可被 300 整除，并等于 `eventStartTime`；
3. `endDate = eventStartTime + 300 seconds`；
4. `conditionId` 是非空 32-byte hex ID；
5. `outcomes` 和 `clobTokenIds` 可严格解码为两个等长数组；
6. label 集合严格为 Up/Down，token 按 label 配对，不依赖位置；
7. 两个 token 是正十进制 CLOB token ID，且不同；
8. `enableOrderBook=true`；
9. `resolutionSource` 是 `https://data.chain.link/streams/btc-usd`；
10. 规则文本明确 `close >= open` 为 Up，否则 Down。

任何不一致都返回 quarantine result，同时保留完整 Gamma raw response；不得通过标题关键词、
数组默认顺序或“看起来像当前盘”猜测修复。

## `startDate` 不是窗口开始

公开样本 `btc-updown-5m-1775181000` 的 `startDate` 是
`2026-04-02T01:58:12.365266Z`，但窗口是：

```text
eventStartTime = 2026-04-03T01:50:00Z
endDate        = 2026-04-03T01:55:00Z
```

因此实现明确忽略 `startDate` 作为五分钟边界；它只能作为原始市场元数据保留。

## 生命周期与结算边界

- identity accepted 与 current collectible 是两个结论。validator 保留 `active`、`closed`、
  `acceptingOrders`；只有 `true/false/true` 才可作为本次当前盘采集目标，历史正确市场仍可
  通过身份校验但不可冒充当前盘。
- `new_market` 是公开生命周期通知，不自动加入有效 BTC 五分钟 catalog；仍需上述身份验证。
- `market_resolved` 只保存为待对账事实。它没有 Chainlink 开盘/收盘边界价格，不能构造
  第一批的黄金 `Settlement`。
- `Binance BTC/USDT` 是外部对照行情，不是结算 oracle。
- 本批不计算 winner、payout 或 PnL。

## 公共来源

- [Gamma market by slug](https://docs.polymarket.com/api-reference/markets/get-market-by-slug)
- [Public market data model](https://docs.polymarket.com/market-data/overview)
- [BTC 五分钟公开规则样本](https://polymarket.com/event/btc-updown-5m-1781175900)

slug 命名是当前公开接口的已验证行为，不被文档承诺为永久协议。后续协议变化必须通过新
fixture/schema 版本显式处理，不能放宽当前 validator。
