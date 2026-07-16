# Batch 4B D 盘候选数据（只读盘点）

盘点对象：`/mnt/d/polymarket-data`（Windows D 盘，DrvFS）。本报告只记录候选文件的
元数据和完整 SHA-256；没有移动、删除、清洗、改写或复制源文件。完整哈希仅对下表
20 个候选计算，未对其他文件做完整哈希。

## 选择结论

- 候选数：20（上限 20）。
- 候选合计：6,562,004,307 bytes（约 6.11 GiB，按 2^30 计算）。
- 选择依据：优先覆盖 Polymarket CLOB book、Binance spot/book/trade、Binance USD
  perpetual、Bybit、OKX、Coinbase，并覆盖 2026-07-06 至 2026-07-13 的相邻日期，
  以便进行多 Edge lead-lag、盘口质量和市场切换观测。
- 这些文件仍在 D 盘原位置；本批没有导入 normalized dataset，也没有复制大文件。
- `book-20260706/07` 与交易所流按日期配对；同日 spot/USD book 保留为独立候选，避免
  在未验证 symbol/channel 前错误合并。

## 候选清单与完整 SHA-256

| # | 相对路径 | bytes | SHA-256 | 初步用途 | 状态 |
|---:|---|---:|---|---|---|
| 1 | `capture/book-20260706.jsonl.gz` | 1,715,861,473 | `7977ff012aa557c35a15f97f1af029d4a106cef0774cd52bd91d1d7a2ccfaaa2` | CLOB book | 候选导入 |
| 2 | `capture/book-20260707.jsonl.gz` | 1,227,704,942 | `f01d5566f270daf67c5a69c6908f70cb07f2680d3c750ea38e62ea226ec421c5` | CLOB book | 候选导入 |
| 3 | `capture/binance_book-20260707.jsonl` | 587,311,832 | `b5b85aa8701254e052115a08d36137823febd617cfb27e05a9e59b32bf5bc0f5` | Binance spot book | 候选导入 |
| 4 | `capture/binance_book-20260708.jsonl` | 444,344,164 | `24c356cd948d31f2c8547761e35d67eadfb0e56671a83189e0f4cff4eff0b4bd` | Binance spot book | 候选导入 |
| 5 | `capture/binance_book-20260713.jsonl` | 287,827,952 | `f8581b718639aa786c059b64fd55c5da3c0c37340d4c97ce50024ec0652d1102` | Binance spot book | 候选导入 |
| 6 | `capture/binance_usd_book-20260713.jsonl` | 286,921,082 | `e577da6c8a2fb2ce097598d44a9699b6ccbd5ea3923e30a17d69045f62067f83` | Binance USD perpetual book | 候选导入 |
| 7 | `capture/bybit-20260707.jsonl` | 228,817,992 | `09d1c7daefbe97475b725f4911beaded47a92fec08d044e2d9534ed0959fa3c2` | Bybit market stream | 候选导入 |
| 8 | `capture/binance_trade-20260707.jsonl` | 227,616,634 | `b4f935be9d1a0a2f5a4f64d5242d468152a5e6b0438fa460bc8403e55a22a049` | Binance trades | 候选导入 |
| 9 | `capture/bybit-20260708.jsonl` | 201,678,489 | `de4a39520000c500baa29b10f661908185bcfa6afcf3761574866974dd1c850c` | Bybit market stream | 候选导入 |
| 10 | `capture/binance_trade-20260708.jsonl` | 178,381,868 | `66a3fa41aeae6d5af41c27b6bb9b9a24249f91d83a618c425de11af61f82a56e` | Binance trades | 候选导入 |
| 11 | `capture/book-20260707.jsonl` | 171,718,215 | `ae1c5d9fcc586a0eb2fc64928cf4af7a02afe7e8a897e4b66d89d499f095a6cb` | CLOB book (uncompressed peer) | 候选导入 |
| 12 | `capture/bybit-20260713.jsonl` | 133,042,429 | `cb64403b70e9eaf5715874c79cf1ab07b4bbdc2d3550035ac3d474fedf91e8b1` | Bybit market stream | 候选导入 |
| 13 | `capture/okx-20260707.jsonl` | 126,394,223 | `57b5dee770cb479edf1a86d72e4c76505a5f589640968ee6d6b8738137a10ffb` | OKX market stream | 候选导入 |
| 14 | `capture/binance_trade-20260713.jsonl` | 125,051,421 | `d5e848bbf7a1190c4ccd6dc24cd436eb505ea0904c660e7914f1f911eab5e793` | Binance trades | 候选导入 |
| 15 | `capture/coinbase-20260708.jsonl` | 117,545,931 | `1465bd0a809c1665d99c812ba854e3e7aec9402d6885165156b1c7f61ef848be` | Coinbase market stream | 候选导入 |
| 16 | `capture/coinbase-20260707.jsonl` | 114,017,051 | `128efc6e333cab1b6e19f0c1a2f5ecb6ff13846b7c8bbb5e4c49512a7e845c1d` | Coinbase market stream | 候选导入 |
| 17 | `capture/okx-20260708.jsonl` | 102,680,061 | `52d625c68f8c4c1f5c912c36a8a346aa2d92baaf15150728461e77ea15eab6c3` | OKX market stream | 候选导入 |
| 18 | `capture/binance_book-20260712.jsonl` | 96,782,405 | `959e6051b64ab3778654b6cf1ca0a3d21ea4ab5601a04e3e9265226049b8a922` | Binance spot book | 候选导入 |
| 19 | `capture/binance_usd_book-20260712.jsonl` | 96,782,089 | `4d770d634366e0e2ef124752beb5ecef1cd21ff77ae7d85df7645dfad7e41a32` | Binance USD perpetual book | 候选导入 |
| 20 | `exports/signal-sources_20260706-0334_to_20260707-0950/binance.csv` | 91,524,054 | `f48a306bc47de628cf216ae49e72b3075864c1b57e88420d91bbfba698e27022` | 既有信号源对照 CSV | 仅参考/候选转换 |

## 读取与验证方法

1. `stat` 读取大小和修改时间；路径均在 `/mnt/d/polymarket-data` 下。
2. 使用 `sha256sum` 顺序读取候选文件；输出仅写入本项目报告，不向 D 盘写回任何内容。
3. 未执行解压、重排、清洗或 schema 转换。下一步若导入，必须先验证文件内部 symbol、
   channel、事件时间和 source/server/receive 三时钟，并重新生成受 Batch 2.5 合同约束的
   manifest。

## 风险与下一步门槛

- D 盘为 DrvFS；不能作为可信 raw 输出或高频写入目标。候选仅用于只读评估和受控转换。
- 文件名不能证明 symbol、连续性或市场窗口；尤其 `bybit-*`、`okx-*` 需先做 schema
  和 symbol 识别，不能按文件名直接并入 BTC-only 数据集。
- gzip 与未压缩的 `book-20260707` 可能有重叠，但哈希不同；不得删除或合并，需事件级
  去重和 manifest 证据后再决定。
- 候选总量约 6.11 GiB，转换产生的中间/normalized 空间尚未测量；继续操作前应设置
  输出目录、剩余空间下限和可回滚的 manifest。
- 只有通过 schema、时间合同、重复事件、损坏检测及 point-in-time gate 的文件，才可进入
  Batch 4B 的 edge 观测输入；其余保留为参考或 quarantine。

