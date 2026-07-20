# Batch 06：Chainlink 预估结算设计

## 状态与范围

本文件只是设计契约。任何 preliminary Chainlink 或 relay observation 目前都不能改变 K/J paper wallet、释放 reservation、计算最终 PnL 或将 market 置为 `DONE`。

最终 settlement 契约不变：durable raw Gamma response 必须通过 market/token/time identity 检查，证明 market closed 且 `umaResolutionStatus=resolved`，并有唯一精确 `1`/`0` winner，engine 才接受 `OFFICIAL_RESOLUTION`。

runtime 接收名为 `chainlink` 的 Polymarket RTDS stream，而 market declaration 目前指定 Chainlink BTC/USD stream 为 resolution source。本仓尚未证明收到的 relay frame 是某场 market 精确 opening/closing boundary 使用的 canonical value，因此派生观察只能叫 `PRELIMINARY_RELAY_OBSERVED`，不能叫“官方 Chainlink settlement”。

## 官方来源复核（2026-07-18）

BTC 五分钟 market rule page 说明 outcome 比较 end price 与 start price（tie 为 Up），并指定 Chainlink BTC/USD stream 为 resolution source。Polymarket RTDS 文档也定义公开 `crypto_prices_chainlink` 订阅：`btc/usd` 带毫秒 source timestamp 与数值。这足以保留 RTDS Chainlink feed 作为低延迟 observability/signal 输入。

但这些事实并不能证明观察到的 RTDS frame 是单场 opening/closing boundary 的精确值。market page 提示 live data 可能延迟，resolution 文档也说明 final outcome 经过 resolution process。因此 relay 只能用于 preliminary direction、lead/lag/basis 研究和未来 agreement metric；wallet/PnL settlement 仍只能使用 Gamma 的 resolved market response。

已复核的官方链接：

- https://polymarket.com/event/btc-updown-5m-1778113200
- https://docs.polymarket.com/market-data/websocket/rtds
- https://docs.polymarket.com/concepts/resolution

## 建议状态与证据

```text
UNAVAILABLE
  -> OPEN_ANCHOR_OBSERVED
  -> CLOSE_BOUNDARY_OBSERVED
  -> PRELIMINARY_UP | PRELIMINARY_DOWN
  -> MATCHED_FINAL | MISMATCHED_FINAL | FINAL_UNAVAILABLE
```

`PRELIMINARY_*` 仅是信息状态，不是 settlement transition。只有 Gamma final evidence 才能生成 `MATCHED_FINAL` 或 `MISMATCHED_FINAL`，且只有既有 Gamma 路径可结算 paper engine。

未来实现对每个 boundary candidate 必须保存 market/condition/slug/token/interval/resolution source、boundary role、原始 frame bytes/hash、精确 price lexeme、source/server/receive time、ReceiveStamp、connection ID、deterministic selection/visibility rule 以及接受/拒绝/重复/冲突原因。重复相同 frame 可幂等；冲突值、缺 boundary、identity mismatch、impossible/future timestamp 或 ambiguous rule 必须成为 `UNAVAILABLE`/`CONFLICT`，不得用附近 last price 替代。`end >= start => Up` 只能在保存并验证单场官方 rule text 后使用。

若实现，需要新的 append-only journal payload（例如 `CHAINLINK_BOUNDARY`）、deterministic replay-only preliminary state，以及 duplicate/conflict/missing-boundary/final-mismatch/recovery 测试；该 payload 永远不得调用 `engine.settle()`。最终 report 可以记录 preliminary/final agreement 和 Gamma-resolution delay，但不得把 agreement 写成 100% accuracy 或 profitability claim。

新增 adapter 前，必须重新核对当时官方 market rule 和 declared Chainlink stream 的精确 public data contract，并将 boundary semantics 固定为 versioned configuration 与独立 runtime/report contract。本工作与 `L_ADAPTIVE_EXECUTION` 分离：当前 historical receipt 没有经验证的历史 Chainlink boundary series 或 receive-time evidence。
