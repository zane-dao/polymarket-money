# Batch 3B 数据源审计

## 结论

本批只使用无凭据、只读的公开数据。原始数据和派生数据均位于 Linux 文件系统
`/root/polymarket-money-data`，未进入 Git，也未写入 DrvFS。Polymarket 行情来自第三方 1 Hz
缓存采样，因此连续性始终是 `UNVERIFIED`；它不是完整 L2，也没有可观察的 receive time。

## Polymarket 第三方历史数据

- 数据集：`kachoio/polymarket-5-minute-crypto-up-down-markets`
- 固定 revision：`42d917dc8e3205dde8ac909792af0cce2d715c9f`
- `btc_markets.parquet`：3,921,352 bytes，SHA-256
  `8e0ed78021bd98d3dba18829266103ebd9b46a77f6ba872a1c7f98be77b506bd`
- `btc_ticks.parquet`：182,475,803 bytes，SHA-256
  `173760b951ac0a2c795e1c3873a506e2fd4372db356dd3515f06582820ff975e`
- 精确 URL 使用 `/resolve/<revision>/btc_markets.parquet` 与
  `/resolve/<revision>/btc_ticks.parquet`；适配器拒绝非 BTC 文件名。
- 只下载 BTC；未下载 ETH、SOL、XRP。
- 原始数值类型为 float64，manifest 明确记为 `BINARY_FLOAT_SOURCE`。价格、数量、手续费与 PnL
  在内部转换为 Decimal 字符串语义。

源限制：`sampling_interval=1s`、`depth_scope=TOP_OF_BOOK_ONLY`、
`visibility_evidence=THIRD_PARTY_SAMPLE_TIME`、`receive_time=UNOBSERVED`、
`full_l2_available=false`、`continuity=UNVERIFIED`。不能模拟 250ms，也不能从 bid 深度推造 ask 深度。

首次不可变研究 manifest 仍保存采集时的数据集首页 URL，但 revision、文件名、大小和 hash 均已
固定；代码在其后修正为精确文件 URL，未重跑或覆盖 Final Test。

## Binance 官方特征数据

- `BTCUSDT` spot 1s klines，UTC 2026-04-28 至 2026-05-18，共 21 个日档。
- 每个 zip 都与 `data.binance.vision` 同目录官方 `.CHECKSUM` 核对。
- 每个日档 86,400 行，从 00:00:00 到 23:59:59，无秒级缺口。
- 数据门所需 16,797 个决策点全部可用，覆盖率 100%。
- Binance 只用于模型特征和 `GBM_BINANCE_PROXY`，不作为官方结算标签。

## 官方证据缓存

- Gamma events 响应按 UTC 日和分页保存，原始响应清单 hash：
  `65bc130ce5889610662127c635c7eea9330d2ebe9bd95893de1e0eef3602bca7`。
- 官方 changelog、fees、market 和 fee-rate 文档于 2026-07-16 缓存；每个文件有 SHA-256。
- 所有读取有有限分页/超时边界；未连接 User Channel，未调用交易端点。

## 制度与数据量

| 制度 | 市场数 | 用途 |
|---|---:|---|
| PRE_V2（2026-03-24 至 2026-04-27） | 9,795 | 仅盘点，不进入 headline 或本批模型 |
| CUTOVER_EXCLUDED（2026-04-28） | 288 | 完全排除 |
| PRIMARY_V2（2026-04-29 起） | 5,599 | 唯一 headline 研究集合 |

PRIMARY_V2 固定切分为 Train 2,880、Validation 1,440、Final Test 1,279 个市场；每个市场
生成 60/30/15 秒三个样本，共 16,797 行。normalized dataset hash 为
`a27d9d1bf4dc5276c7ae5b11abd64250b6e6dc17f01fd432ab0dc10e4425cafc`。

