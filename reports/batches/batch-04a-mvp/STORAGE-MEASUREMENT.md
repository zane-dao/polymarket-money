# Batch 4A-MVP 存储测量

## 文件系统与物理位置

- WSL root：`/dev/sdd`，ext4，虚拟可用约 951 GiB。
- `POLY_DATA_ROOT`：环境变量未设置；验收显式使用 `/root/polymarket-money-data`，位于 ext4。
- D 盘挂载：`/mnt/d`，9p/DrvFS，不允许作为可信 raw 输出。
- Ubuntu BasePath：`D:\WSL\Ubuntu`。
- VHDX：`D:\WSL\Ubuntu\ext4.vhdx`；测量时文件大小 6,845,104,128 bytes。
- D 盘物理可用：18,465,873,920 bytes（约 17.20 GiB）。
- 保留 10 GiB 后本地安全容量：7,728,586,752 bytes（约 7.20 GiB）。
- 结论：写入 `/root` 会扩张 D 盘上的 ext4.vhdx；D 盘物理空间是约束，不是 ext4 的
  951 GiB 虚拟上限。

## Raw 预检实测

10 秒配置、实际含关闭/压缩测量 12.694 秒；输出为 WSL ext4；共享 hard limit 128 MiB。

- 事件段：7 个，3,896,736 bytes，3,523 events。
- 未压缩 bytes/hour：1,105,108,681。
- 未压缩 projected：24.70 GiB/day、172.91 GiB/7 days、345.82 GiB/14 days。
- 流式 gzip 估算：388,525 bytes，压缩率 0.099705（约 9.97%）。
- 按同一压缩率估算：约 2.46 GiB/day、17.24 GiB/7 days、34.48 GiB/14 days。
- stoppedByByteLimit=false，stoppedByDuration=true。

短样本受盘口活跃度影响，只作为量级预检；最终规定时长结果以本报告后续“有限验证”数据
为准。即使采用该样本的压缩后估算，14 天约 34.48 GiB 仍显著高于 7.20 GiB 安全容量。

## 各流短样本

| stream | events/hour | payload bytes/hour | receive latency p50 / p95 |
|---|---:|---:|---:|
| Gamma | 567 | 2,469,293 | 无 provider latency |
| CLOB | 300,047 | 208,098,661 | provider timestamp 语义未验证，不伪装 latency |
| Chainlink RTDS | 2,836 | 1,504,490 | 1,321 / 1,358 ms |
| Polymarket RTDS Binance | 284 | 0 | btc-only transport 未产出可用价格 |
| Binance spot | 360,737 | 38,598,897 | bookTicker 不提供可信 event time |
| Binance perpetual | 334,930 | 54,813,361 | 1,367 / 1,676 ms |

## 有限验证结果

最终 30 分钟 monitor 和有界 raw capture 的摘要将在运行结束后补入；磁盘结论不会因这两项
从“容量不足”反转，除非实测流量低两个数量级。

