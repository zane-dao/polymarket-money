# Batch 02：数据 provenance

## 来源边界

本批只允许以下公开、无凭据来源：

| 来源 | endpoint | 权限 |
|---|---|---|
| Gamma market by slug | `https://gamma-api.polymarket.com/markets/slug/{slug}` | public GET |
| CLOB REST book | `https://clob.polymarket.com/book?token_id=...` | public GET |
| CLOB Market Channel | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | public WS |
| RTDS | `wss://ws-live-data.polymarket.com` | public WS；只订阅 Chainlink BTC/USD 和 Binance BTC/USDT |

不存在 User Channel、`gamma_auth`、wallet address、API header、签名、下单或撤单 endpoint。
连接函数不接收任意 URL、订阅 payload 或 heartbeat；调用方只能选择闭合的 public source
union，endpoint、订阅结构和 5/10 秒 heartbeat 由内部绑定。认证样式 key 会在发送前递归
拒绝。

## Fixture 登记

fixture 路径和逐项来源见 `data/fixtures/batch-2/PROVENANCE.md`。Gamma fixture 是公开响应的
最小字段投影；WS/RTDS fixture 取当前官方 schema 示例并加入明确标注的负向场景；共享
RawEvent fixture 完全由本项目合成。所有 fixture 无账户数据和凭据。

fixture 不冒充线上分布证据。price_change、market_resolved、重连等在有限 smoke 中未必自然
发生，其 parser 正确性由离线 fixture 测试证明；smoke 报告只能写实际观察到的事件。

## 有限 smoke 规则

- 全部离线测试通过且采集器代码已提交后才执行；
- raw root 位于仓库外 WSL 原生临时目录；
- 每个 socket 有 timeout、frame count、单帧 bytes 和累计 bytes 上限；HTTP 同时检查
  Content-Length 与实际流式读取 bytes；
- 不创建后台守护进程；完成或失败即关闭；
- 每个 source/stream 单独 segment 和 manifest；
- external review pack 不包含 raw、manifest 或 fixture，只交付 HANDOFF。

DatasetManifest 的 `collector_git_commit` 必须指向实际运行的已提交采集器版本；工作树如果
含影响采集行为的未提交更改，smoke 结果不能作为最终验收证据。
