# Batch 4A-MVP 存储策略

## 本地 raw 硬边界

- 输出只能位于 WSL Linux 原生文件系统；`9p`、DrvFS、NTFS、`/mnt/d` 直接拒绝。
- duration 必须显式给出，且本地最多 60 分钟。
- max-bytes 必须显式给出，且本地最多 2 GiB。
- 写入前必须确保“当前可用空间 - max-bytes >= 10 GiB”。
- 所有 stream 共用同一个原子字节预算；达到任一限制后停止接收并关闭非空段。
- 当前保持单写者；跨进程并发写入不在本批范围。

`max-bytes` 约束实际持久化的未压缩 raw envelope。段关闭后以流式 gzip 计算压缩后大小和
SHA-256，但不写第二份 `.gz`，因此不会因测量再次消耗同等磁盘空间。

## WSL 与物理盘

当前 `POLY_DATA_ROOT` 建议为 `/root/polymarket-money-data`，文件系统为 ext4。该 ext4 的
虚拟可用空间不能当作物理容量：Ubuntu 的 BasePath 为 `D:\WSL\Ubuntu`，其
`ext4.vhdx` 位于 D 盘，因此 `/root` 的新增 raw 最终仍扩张 D 盘 VHDX。

容量决策必须使用：

```text
local safe capacity = min(ext4 virtual free, D physical free - 10 GiB)
```

详细实测见 `reports/batches/batch-04a-mvp/STORAGE-MEASUREMENT.md`。

## D 盘历史资产

`/mnt/d/polymarket-data` 只盘点，不移动、不修改、不清洗。默认仅做 stat、受限 schema
样本和局部指纹；浏览器 profile、Cookies、Login Data、wallet、credential 等路径只记
元数据，禁止读取内容、采样或指纹。只有后续明确选中导入的文件才计算完整 SHA-256。

推荐导入顺序：

1. Chainlink settlement CSV 与明确市场元数据，用于身份/标签对照。
2. CLOB `book-*.jsonl(.gz)`，先转换到 raw-event-v1，再过 manifest 和连续性检查。
3. Binance spot/perpetual book/trade 数据，补齐 source/receive clock 语义后进入 normalized gate。
4. 旧 replay rows 与数据库仅作结果对照，不作为新的真相源。

