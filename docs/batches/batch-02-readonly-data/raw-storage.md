# Batch 02：不可变原始存储

## 数据根与分区

`POLY_DATA_ROOT` 必须是仓库外绝对路径；测试使用临时目录，有限 smoke 使用 WSL 原生
`/tmp`。布局为：

```text
POLY_DATA_ROOT/
  {source}/{receive-utc-date}/{stream}/{segment-id}.jsonl
  manifests/{dataset-id}.manifest.json
```

分区日期只取 `receive_time` 的 UTC 日期，不取 source time、本机日期或市场日期。一个
segment 只能包含同 source、stream 和 receive-date 的事件。

## 写入与发布

1. 以 `O_EXCL`/`wx`、0600 创建 `.jsonl.partial`；
2. 追加一行完整 UTF-8 JSON + LF；
3. 每次 append 完成 `fsync` 后才返回 `durable:true`；
4. close 再次 fsync、关闭并对精确文件 bytes 计算 SHA-256；
5. 使用同目录 hard-link no-clobber publish，目标已存在时原子失败；
6. fsync 目录、移除 partial 名称、再次 fsync 目录；
7. 最后用同样机制发布 manifest，manifest 是数据集 commit record。

同一 writer 的 append/close/incomplete 操作由内部队列串行化；并发相同 event ID 返回同一
receipt，并发冲突内容失败关闭。append 在写入前执行完整 runtime contract validation，不能
先返回 durable 再等 close 才发现坏记录。

普通 POSIX `rename()` 会覆盖目标，所以没有使用 `exists()+rename()` 冒充 no-overwrite。
closed segment 和 manifest 均不可覆盖，发布后权限收紧为 0400；未被 manifest 引用的
closed 文件不自动回放。

`persist_time` 的物理语义需要特别说明：记录不能先知道“包含自身的 fsync 返回后墙钟”再
把这个时间写入自身。v1 因此使用 writer 在 durability barrier 前分配的逻辑 commit time，
且只有 barrier 成功后才承认/返回该记录；不能描述为 fsync 返回后采样时间。

## 崩溃状态

| 状态 | 处理 |
|---|---|
| `PARTIAL_INCOMPLETE` | 识别、报告、隔离；不续写、不截断、不回放 |
| `CLOSED_UNMANIFESTED` | 保留；不进入正常 replay |
| `MANIFEST_BROKEN` | 整个数据集验证失败，零事件输出 |
| `VERIFIED` | 所有 path/size/hash/line/schema/count/aggregate 通过后才可 replay；replay 使用本次已验证 bytes，不重新打开可变路径 |

以后若抢救 partial，只能写成带 lineage 的新数据集，不能修改原文件。

## DatasetManifest

每段记录相对路径、SHA-256、byte/event/error/unknown count、首末 receive time；顶层还记录
source/stream、公开 subscription/filter、collector commit、collection range、market/
asset IDs、continuity 和 allowlist 配置摘要。subscription 按 source 使用严格 schema，配置
key/value 均为 allowlist；禁止完整环境变量、凭据键或凭据 hash。公开 smoke manifest
必须记录真实已提交 collector Git object ID，不能使用 `UNCOMMITTED`。

没有官方 sequence 时，manifest 的 continuity 只能是 `UNVERIFIED`。

## WSL 文件系统边界

no-clobber hard link、fsync 和目录 durability 以 WSL 原生 Linux 文件系统为验收环境。
`/mnt/c`、`/mnt/d` 的 DrvFS 语义可能不同，当前不作为可信 raw store；若以后改变文件系统，
必须重新做 crash/no-overwrite 验证。

writer 会逐级拒绝 symlink，并从自身 package metadata 定位 Git 根目录；即使从其他 cwd
调用，也不能把 `POLY_DATA_ROOT` 放进仓库。Python verifier 只接受
`POLY_DATA_ROOT/manifests/*.manifest.json` 的 final regular file，拒绝 partial、symlink、
路径逃逸、重复 segment 和验证后路径替换。
