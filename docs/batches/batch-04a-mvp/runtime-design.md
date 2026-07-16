# Batch 4A-MVP 运行时设计

## 唯一入口

安装项目后使用 `poly-lab`：

```bash
poly-lab replay --dataset <version-dir> --dataset-hash <sha256> --speed max
poly-lab monitor --duration 1800 --record metrics
poly-lab paper --duration 60 --record metrics
poly-lab inventory --path /mnt/d/polymarket-data
poly-lab storage-report --data-root /root/polymarket-money-data
```

CLI 采用 Python 标准库 `argparse`。终端是 TTY 时，monitor/paper 由 Rich 渲染同一份
JSON snapshot；非 TTY 或 `--json` 时逐行输出机器可读 JSON。展示差异不产生第二条数据
或交易路径。

## Replay

`ReplayPacer` 只控制展示速度，`ReplayEngine` 仍是唯一回放器。数据必须是已经发布并按
hash 固定的 point-in-time normalized dataset。`1x`、`10x`、`max`、`step` 均不改变
决策、成交、结算或 replay hash。Unix 下可用 `SIGUSR1` 暂停、`SIGUSR2` 恢复。

默认策略为 `NoTradeStrategy`。显式的 `module:function` 插件必须返回现有 `Strategy`
协议对象；决策只读取 `PointInTimeView`。成交、费用、部分成交、结算和 PnL 始终委托给
Batch 3A 的 `ExecutionModel`、`FeeModel`、`ReplayEngine` 和 Batch 1 的领域/账本规则。

## Monitor

数据流只有一条：

```text
credential-free public source
  -> capturePublicSocket / bounded HTTP
  -> existing parser
  -> PublicOrderBook / price state
  -> one runtime snapshot
  -> Rich or JSON display
  -> optional metrics/raw recorder
```

公开源为 Gamma、CLOB Market Channel、Polymarket RTDS Chainlink、RTDS Binance、Binance
BTCUSDT spot bookTicker 与 perpetual bookTicker。所有 WebSocket 都复用
`capturePublicSocket`；端点、订阅、heartbeat、单帧/累计字节和最长时间有封闭配置。
断线后以 1 秒有限退避重建 bounded capture，不存在另一套 socket manager。

盘口沿用 `PublicOrderBook`：断线后必须重新 snapshot；空侧不可交易；连续性始终
`UNVERIFIED`。面板显示当前/下一市场、双 token top-of-book/depth、三类 BTC 价格、
延迟、连接/陈旧/隔离状态、机会和存储增长率。

## Recording

- `none`：不写任何数据。
- `metrics`：只写 runtime snapshot、机会、延迟和 paper audit，不含 raw payload。
- `raw`：写公共原始事件；必须显式提供 duration、max-bytes、Linux-native output。

raw 复用 `RawSegmentWriter` 和 `DatasetManifestWriter`。Gamma 按精确 slug 分段；其他源
按 source/stream 分段。每个非空段都有事件数、未压缩字节、SHA-256、manifest 和
`UNVERIFIED` 连续性声明。压缩率通过流式 gzip 计算，不额外保留第二份压缩文件，避免
突破磁盘安全余量。

## 安全边界

运行时没有 live client factory、User Channel、签名器、私钥或下单 API。paper 输出中
`orderSubmitted` 固定为 `false`；summary 必须记录 `liveClientConstructed=false`、
`credentialsRead=false`、`ordersSent=0`。官方交易 SDK 本批未安装、未实例化。

