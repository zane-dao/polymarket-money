# Batch 02.5 unresolved issues

## Critical

无。

## High

无 Batch 2.5 gate 阻断项。

## Medium

### 上游 continuity 无法证明

公开 feed 没有项目可验证的 gap-free sequence/cursor。决定不是补猜 sequence，而是 raw、
normalized、view 永久 `UNVERIFIED`。任何回测若要求连续盘口，必须另有明确覆盖规则或拒绝该
区间。

### 长期 reconnect 行为未验收

本批只实现 normalized connection/snapshot state；没有长期 supervisor、退避、抖动、断线窗口
或多小时恢复测试。已明确移入 Batch 2B。

### BTC-only 在线更新仍有 evidence debt

15 秒有限 probe 只看到一个非目标 frame，未观察到 BTC parsed update。离线合同和官方文档
支持精确 `btcusdt` filter，但这不等于当前网络路径已有分布证据。不得把 Batch 2 的 fallback
smoke 或本批 offline fixture 宣传为 BTC-only 长期成功。

### Content hash 不是第三方签名

Manifest/output SHA-256、no-overwrite 和 directory version 可检测正常操作下的变化与篡改；若
攻击者拥有整个 data root 的写权限，可替换内容、重算 hash 并重命名目录。本批没有签名、
append-only filesystem、remote attestation 或可信时间戳。部署权限模型需在生产数据治理前
单独设计。

### Single-writer only

`O_EXCL` lock + atomic rename 按明确的 single-writer 合同实现；没有 NFS、分布式锁、多容器或
crash lease 协调。跨进程/跨机器 writer 不在支持范围；进程被不可恢复地杀死后遗留 lock 需要
运维确认后处理，本批不自动猜测 owner 已失效。

### 跨 manifest 同毫秒事件没有可靠全序

同一 manifest 内可以用 segment/line/message ordinal 恢复 append 顺序；不同 manifest 的 exact
persist-time tie 没有已证明的共同 cursor。当前对相互矛盾的连接或盘口状态选择
`RESET_REQUIRED`，不按 dataset/event ID 虚构顺序。若未来需要消除这些区间，应在采集层提供
可验证的共同顺序，而不是在 normalized 层排序猜测。

## Low

### JSONL 尚未做大数据量性能验收

Canonical JSONL 当前适合作为可审计 gate；尚未证明多年 tick 数据的扫描、空间和索引性能。
未来可从 immutable version 生成列式派生，但不能无验证地替换事实源。

### Schema 未引入 runtime JSON Schema validator

Python 代码执行同等或更严格的逐字段验证，schema 文件是跨语言合同；当前未增加
`jsonschema` runtime dependency。若其他语言开始消费，应添加 schema conformance suite。

### Normalizer 尚未拆分为更小组件

当前实现集中在一个 Python module，便于本批审计单一 gate，但随着新增 source/record 类型需
拆成 contract、PIT view、source normalizers 和 publisher，避免形成新的耦合点。拆分不能改变
canonical bytes/hash 行为。

### CLOB provider timestamp 仍是 opaque

当前只保存 `provider_timestamp_raw`，不会把未证明语义的 provider 字段冒充 `source_time`。
这降低了前视风险，但也意味着盘口事实的 stale/可见性主要依赖本地四时钟，后续若升级语义必须
先用官方协议与 fixture 证明。

## Accepted platform limits

- DrvFS 不验收，发布器在 `/mnt/<drive>` 创建前拒绝；
- 只支持 WSL/server Linux-native filesystem；
- Binance 默认 BTC-only；all-symbol raw 只有 config 显式 opt-in 且 manifest 已记录时可构建；
- 不含回测、策略、Fill/PnL、订单或 live。
