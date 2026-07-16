# D 盘数据盘点

盘点对象：`/mnt/d/polymarket-data`  
方式：只读 metadata、受限 schema 样本和非敏感文件局部指纹；未移动、删除、清洗或复制。  
完整 SHA-256：0 个（本批未选择任何文件进入导入）。

## 总览

- 文件数：674
- 总大小：7,836,391,246 bytes（约 7.30 GiB）
- 修改时间范围：2022-08-23T05:32:48Z 至 2026-07-14T16:01:04.286211Z
- capture 文件名可确认的数据日期至少覆盖 2026-07-06 至 2026-07-13；未对全部内容做深扫，
  因而不把它冒充全库 event-time 上下界。
- 分类：需转换 164、仅参考 15、可复用参考 60、未知 152、敏感路径只记元数据 283
- 非敏感样本解析错误：0
- 局部指纹疑似重复组：13；只代表候选重复，不代表内容已做完整 SHA-256 证明

主要格式：216 个无扩展名、72 JSONL、51 Markdown、49 JSON、46 CSV、38 log、35 PNG、
34 Python、27 SVG、18 old、18 DB、13 PowerShell、13 HTML、4 `jsonl.gz`，其余为缓存、
数据库辅助文件和少量二进制格式。

## 最大 20 个文件

| bytes | 路径 | 处理建议 |
|---:|---|---|
| 1,715,861,473 | `capture/book-20260706.jsonl.gz` | 需转换 |
| 1,227,704,942 | `capture/book-20260707.jsonl.gz` | 需转换 |
| 587,311,832 | `capture/binance_book-20260707.jsonl` | 需转换 |
| 444,344,164 | `capture/binance_book-20260708.jsonl` | 需转换 |
| 287,827,952 | `capture/binance_book-20260713.jsonl` | 需转换 |
| 286,921,082 | `capture/binance_usd_book-20260713.jsonl` | 需转换 |
| 228,817,992 | `capture/bybit-20260707.jsonl` | 需转换 |
| 227,616,634 | `capture/binance_trade-20260707.jsonl` | 需转换 |
| 201,678,489 | `capture/bybit-20260708.jsonl` | 需转换 |
| 178,381,868 | `capture/binance_trade-20260708.jsonl` | 需转换 |
| 171,718,215 | `capture/book-20260707.jsonl` | 需转换；与同日 gzip 的关系待验证 |
| 133,042,429 | `capture/bybit-20260713.jsonl` | 需转换 |
| 126,394,223 | `capture/okx-20260707.jsonl` | 需转换 |
| 125,051,421 | `capture/binance_trade-20260713.jsonl` | 需转换 |
| 117,545,931 | `capture/coinbase-20260708.jsonl` | 需转换 |
| 114,017,051 | `capture/coinbase-20260707.jsonl` | 需转换 |
| 102,680,061 | `capture/okx-20260708.jsonl` | 需转换 |
| 96,782,405 | `capture/binance_book-20260712.jsonl` | 需转换 |
| 96,782,089 | `capture/binance_usd_book-20260712.jsonl` | 需转换 |
| 91,524,054 | `exports/signal-sources_20260706-0334_to_20260707-0950/binance.csv` | 需转换 |

## Schema 与来源推断

- CLOB capture：`{"t": ..., "d": ...}` 外层 JSONL，`d` 是嵌套的原始 WebSocket 帧。
- Binance agg trade CSV：`trade_ts_epoch, trade_ts_iso, price, qty, agg_trade_id`。
- Coinbase CSV：`src_ts, recv_ts, price, size, recv_ts_iso`。
- Chainlink CSV：`src_ts, recv_ts, price, recv_ts_iso`。
- settlement CSV：`market_id, slug, open_ts_ms, close_ts_ms, outcome, resolution_source`。
- 旧 replay rows：含盘口、策略概率、stake、fee、outcome、PnL；只可用于对照旧假设。
- sweep/meta/report：研究产物，不是原始真相源。
- DB/backup/browser profile：只作参考或未知，不进入 normalized dataset。

## 重复、损坏和敏感内容

局部指纹发现同名实验结果、重复脚本、DB 辅助文件和浏览器缓存候选重复。未对任何候选做
完整 SHA-256，因此不能据此删除或合并。受限 schema 抽样未发现解析损坏；gzip 完整性结果
以最终测试报告为准。

`tmp/edge-prof`、Cookies、Login Data、wallet/credential 等 283 个路径只统计路径、大小和
mtime，不读取内容、不生成指纹、不输出样本。

## 复用分类与空间

- 可复用：明确列名的 Chainlink/交易所 CSV、市场/settlement 元数据，但仍须经过来源与时间合同。
- 需转换：CLOB/交易所 JSONL、gzip capture；必须转换为 raw-event-v1，再发布 manifest。
- 仅参考：旧 DB、replay、PnL、实验报告和配置备份。
- 未知：无扩展名缓存、二进制或来源不明文件；默认不导入。

若保留原文件、转换中间文件和 normalized 输出，额外空间不能按 7.30 GiB 简单估算；两个
大型 gzip CLOB 文件可能显著膨胀。未选定文件前给出保守工作区间 **15–35 GiB**，而当前
D 盘保留 10 GiB 后仅约 7.2 GiB 可安全使用，因此不应在本机开始全量转换。
