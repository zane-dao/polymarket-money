# Batch 02 有限 smoke 数据质量

## 成功运行

- run ID：`smoke-20260715125957-6347222a`
- collector：`acaf1934a6a84f3b0d49f547a7a88a903bd3fc90`
- 临时根：`/tmp/polymarket-money-batch-02-smoke-accepted-H540nS`
- 上限：每 socket 60 秒、500 帧、1 MiB/帧、8 MiB 累计；HTTP 1 MiB
- 身份：`btc-updown-5m-1784120100`，2026-07-15 12:55–13:00 UTC
- 结果：4 final manifests、0 partial、Python 9/9 checks、continuity `UNVERIFIED`

原始目录只保留在仓库外本机临时位置，不进入 Git、handoff 或 review pack。

## 实际数据

| 来源 | events | parse errors | quarantined | 关键观察 |
|---|---:|---:|---:|---|
| Gamma | 1 | 0 | 0 | 身份和 lifecycle accepted |
| CLOB Market | 4 | 0 | 0 | 两个预期 token snapshot；batch outer shape 标记 unverified |
| RTDS Chainlink | 6 | 2 | 0 | 观察到目标 BTC 更新与三时钟；旧 collector 将空帧和 off-topic subscribe 记 error |
| RTDS Binance | 7 | 1 | 2 | 观察到 3 个价格帧；2 个非 BTC quarantine；1 个空帧 error |

最终 parser 已把“合法 JSON 的 off-topic subscribe”改为 quarantine，并有 Python/Node
对称测试；成功数据仍按采集时实际版本报告，不回写历史。

## 订单簿质量

- 两个订阅 asset 都得到完整 book snapshot，`missing_initial_snapshot_count=0`。
- 一个 token 为 0 bids/88 asks，另一个为 88 bids/0 asks，所以 `empty_book_count=2`。
- `crossed_book_count=0`，`invalid_price_or_quantity_count=0`，未知 token=0。
- 单边空簿可能与窗口临近结束/流动性状态有关；后续执行语义必须把它视为不可双边成交，
  不能用 mid 或另一 token 推造价格。

## 延迟（本次样本，不可推广）

- Binance server→receive：1142–1152 ms；source→receive：1265–1272 ms。
- Chainlink server→receive：1085 ms；source→receive：2375 ms。
- 样本太小，只证明时钟映射和指标可计算，不证明生产延迟分布。

## 失败尝试与恢复证据

- Node 默认 fetch 最初未使用 WSL proxy；改为 `--use-env-proxy` 后 Gamma/CLOB/Chainlink 成功。
- 精确 `btcusdt` 订阅 60 秒无目标更新，留下可识别 Binance `.partial`；没有发布假 manifest。
- 显式 all-symbols 诊断在 4.5 秒内观察到 BTC，因此新增受限、可审计的
  `all-symbols-quarantine` smoke 模式。
- 最终分类补丁后的两次重采集分别在 Gamma TLS `ECONNRESET` 和 public WebSocket error
  处安全失败；未无界重试，也未把 partial 当完整数据。

## 不能证明

没有官方 sequence/cursor，无法证明无丢包；只证明 manifest 列出的、实际收到的事件完整
保存。有限窗口没有要求自然观察 price_change、resolved 或断线重连；这些由 fixture/负测
覆盖，不得伪造为线上事件。
