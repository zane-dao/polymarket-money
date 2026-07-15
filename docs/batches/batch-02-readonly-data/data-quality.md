# Batch 02：数据质量与订单簿健康

## 不能证明的事项

CLOB Market Channel、RTDS 和公开 REST book 都没有官方定义的 sequence、offset、previous
hash 或重放 cursor。`book.hash` 是状态 hash，`price_change.hash` 也没有公开链式语义。

因此本批只能证明：manifest 中列出的、采集器实际收到的事件全部被保存和校验；不能证明
上游没有丢包。任何报告、状态或字段都不得写成 `VERIFIED_CONTINUITY`。

## 订单簿状态机

```text
DISCONNECTED
  -> WAITING_FOR_SNAPSHOT
  -> ACTIVE_UNVERIFIED
  -> STALE / RESET_REQUIRED / DISCONNECTED
```

- 新连接或重连清空旧 book；预期 condition 和全部订阅 token 都建立新 snapshot 前，市场级
  状态不能进入 ACTIVE。
- condition/token 不匹配 fail closed；不同 token 的 provider clock 分开观察，不能用跨
  asset 交错误报倒退。
- 断线和 stale 立即清空可读 best bid/ask。
- 旧 connection 的事件不能写入新状态。
- `size="0"` 删除指定 side/price level；非零才 upsert。
- provider timestamp 倒退保留原始消息并记 quality event，不倒序删除 raw。
- bids/asks 数组顺序不可信；best bid 取 Decimal 最大值，best ask 取最小值。

## 报告指标

Python quality report覆盖：

- 总事件和各 event/parser status 数量、解析成功率；
- unknown、duplicate raw hash、duplicate event ID；
- source/server 到 receive 延迟分布、缺 source time、source time 倒退；
- quarantine/市场身份失败、未知 token、delta 前缺 snapshot；
- reconnect、stale、crossed book、非法 price/quantity、空 book；
- segment checksum、manifest 聚合一致性；这两个布尔值只有输入是 `ManifestVerifier`
  产生的验证证明时才可为 true，普通事件 iterable 固定为 false；
- 固定 `continuity=UNVERIFIED` 和“不能证明无丢包”的明文限制。

异常不能通过删除事件来改善成功率。raw hash 重复只报告；不同 event ID 的两次接收都留在
原始层。

## 官方协议依据

- [CLOB Market Channel](https://docs.polymarket.com/market-data/websocket/market-channel)
- [WebSocket heartbeat and subscription](https://docs.polymarket.com/market-data/websocket/overview)
- [Public REST orderbook](https://docs.polymarket.com/api-reference/market-data/get-order-book)
- [RTDS](https://docs.polymarket.com/market-data/websocket/rtds)

CLOB heartbeat 是每 10 秒发送纯文本 `PING`；RTDS 是每 5 秒。heartbeat 只证明连接有响应，
不证明行情新鲜或连续。
