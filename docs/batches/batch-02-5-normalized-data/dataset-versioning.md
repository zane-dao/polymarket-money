# Batch 02.5：Dataset versioning

## 目录

`POLY_DATA_ROOT` 必须指向 WSL/server Linux-native filesystem。发布路径固定为：

```text
POLY_DATA_ROOT/
└── normalized/
    └── dataset_id=<dataset_id>/
        └── version=<dataset_hash>/
            ├── records.jsonl
            ├── quarantine.jsonl
            └── manifest.json
```

目录只存已完成版本；临时目录名以 `.partial-` 开头，不能作为数据集输入。

## Dataset hash

`dataset_hash` 是 canonical manifest core 的 SHA-256。Core 包含：

- normalized schema/manifest version；
- dataset ID 与永久 `UNVERIFIED` continuity；
- 实际 Git HEAD、normalizer source SHA-256、`CLEAN`/`DIRTY` worktree state；
- 脱敏 NormalizerConfig；
- 每个 raw manifest ID/hash、collector commit、source/stream、subscription、sanitized config；
- 每个 input segment path/hash；
- row、quarantine、quality counts；
- min/max source time 与 visible_at；
- `records.jsonl`、`quarantine.jsonl` 的 SHA-256、bytes 和 rows。

`dataset_hash` 自身不参与 core，避免循环。Final manifest 是 core 加上 `dataset_hash`。同一组
exact raw bytes、代码 bytes/commit/worktree state、配置和 dataset ID 必须生成相同 hash/JSONL
bytes；其中任一项变化都生成新版本。调用方传入的 commit 必须等于实际 HEAD；构建进程 import
后任一 normalizer package/schema byte 变化都会失败并要求重启，避免“运行旧代码、哈希新磁盘
文件”。Dirty build 可以被如实记录，但不能伪装为 clean commit build。

每个 raw input `dataset_id` 必须唯一；manifest SHA-256 既进入 dataset hash，也进入每条 lineage
的 causal identity。Raw persist time 和 segment/line/message ordinal 会原样保留在 row 中，使同一
manifest 内的 append 顺序可以离线重建。

## Atomic single-writer publish

1. 在对应 `dataset_id` 目录用 `O_EXCL` 创建 `.single-writer.lock`；
2. 在同一文件系统创建 `.partial-*` 临时目录；
3. 以 create-exclusive 写三个文件并逐一 `fsync`；
4. `fsync` 临时目录；
5. 发布前重新计算 rows、canonical manifest、dataset/output hash 与 inventory；
6. 用 Linux `renameat2(RENAME_NOREPLACE)` 同文件系统原子发布；
7. `fsync` dataset parent；
8. 释放 lock。

本实现明确依赖 single-writer 合同。`RENAME_NOREPLACE` 还会在竞态下拒绝替换已存在目录，但本批
仍不把 lock 文件宣传为分布式锁，也不在 NFS、DrvFS、对象存储或多个容器 writer 上验收；进程
被不可恢复地杀死后遗留 lock 的 lease/自动回收也不属于本批。

## No overwrite

Final version 路径一旦存在，重复 publish 即使 bytes 相同也失败。重跑可先构建并比较 hash，
但不能把重复 publish 当作成功覆盖。不同版本并存；本批不实现删除、GC 或“latest”可变指针。

## Offline load

`PointInTimeDataset.load(version_directory)` 不联网、不读取凭据，也不需要原始 provider。它会：

- 校验 final directory 名等于 manifest dataset hash；
- 重新计算 manifest core hash；
- 校验 output hashes/bytes/rows；
- 逐行重建并校验 fact/quarantine ID、时间、Decimal 语义和 lineage；
- 校验 normalizer commit/code hash/worktree state 字段，并要求所有 lineage 回指 raw input inventory；
- 从 manifest 恢复 stale threshold；
- 提供相同的 `as_of(decision_time, market_id)`。

Offline load 验证已发布内容和所声明 provenance 的自洽性；它没有重新读取 raw segment，因此
不能单独证明 raw→normalized 转换正确。它也不会声称 content hash 是第三方签名，或把
`UNVERIFIED` 上游连续性升级。
