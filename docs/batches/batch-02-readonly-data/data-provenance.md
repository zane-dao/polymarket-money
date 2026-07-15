# Batch 02：数据 provenance

## 来源边界

本批只允许以下公开、无凭据来源：

| 来源 | endpoint | 权限 |
|---|---|---|
| Gamma market by slug | `https://gamma-api.polymarket.com/markets/slug/{slug}` | public GET |
| CLOB REST book | `https://clob.polymarket.com/book?token_id=...` | public GET |
| CLOB Market Channel | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | public WS |
| RTDS | `wss://ws-live-data.polymarket.com` | public WS；有效流只接受 Chainlink BTC/USD 和 Binance BTC/USDT |

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

WSL 网络环境若要求标准 `HTTP_PROXY`/`HTTPS_PROXY`，smoke 由 Node 24 的
`--use-env-proxy` 运输开关处理；采集器不读取、复制或写入代理配置，manifest 也不记录其
值。该代理只提供公共 endpoint 连通性，不改变无 Polymarket 凭据边界。

DatasetManifest 的 `collector_git_commit` 必须指向实际运行的已提交采集器版本；工作树如果
含影响采集行为的未提交更改，smoke 结果不能作为最终验收证据。

## Binance 传输范围

默认模式 `btc-only` 发送官方的 `filters="btcusdt"`，这是正常采集的最小权限合同。本次
WSL/代理环境中该订阅在 60 秒内未返回更新；同一公开 endpoint 的官方 all-symbols 订阅
随后立即观察到 BTC。为完成一次有限协议验证，采集器提供显式
`all-symbols-quarantine` smoke 后备模式：wire subscription 不带 `filters`，但 parser 仍只
允许 `btcusdt` 成为 `parsed`，其他 symbol 保留完整 raw 并进入 quarantine。

两种模式都是闭合 allowlist，实际模式同时写入 manifest 的 `subscription`、
`symbolFilter=btcusdt` 和 `transportScope`。后备模式不是默认长期采集配置；它会增加流量，
必须继续受 frame/byte/time 上限约束。不能把官方文档中的三币种示例值固化为项目合同。
