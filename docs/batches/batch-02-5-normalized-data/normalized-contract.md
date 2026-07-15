# Batch 02.5：Normalized contract

## 结论

`contracts/normalized-record-v1.schema.json` 是 point-in-time fact 与 quarantine 的 wire
contract，`contracts/normalized-dataset-manifest-v1.schema.json` 是不可变版本的 manifest
contract。唯一输入是 `ManifestVerifier` 产生且在构建时再次核对磁盘字节的
`VerifiedDataset`；不能直接把旧项目对象、SDK 对象或未经验证的 JSON 送入发布器。

本批使用 canonical UTF-8 JSONL，而没有引入 Parquet/DuckDB。原因是当前 gate 首先要证明
Decimal、UTC、lineage 和确定性，而不是分析吞吐：JSONL 可逐行审计，Python runtime 依赖仍为
0，且同一输入、代码和配置会产生完全相同的 bytes。列式派生只能在后续批次从这个不可变
版本生成，不能替代它成为事实源。

## Record 类型

| `record_type` | 内容 | 关键身份 |
|---|---|---|
| `market_metadata` | BTC 五分钟窗口、oracle、生命周期 | `market_id`、`condition_id`、`observed_at`、`valid_from` |
| `outcome_token_mapping` | Up/Down 到 CLOB token 的标签映射 | `market_id`、两个 token ID |
| `clob_book_state` | 当前连接内完整物化的 bids/asks | market、asset、connection、snapshot/delta 观察 |
| `chainlink_btc_usd` | Chainlink BTC/USD 观察 | market window、`source_time` |
| `binance_btc_usdt` | Binance BTC/USDT 观察 | market window、`source_time` |
| `connection_state` | CONNECTED、DISCONNECTED、STALE、RESET_REQUIRED | market、connection |
| `quality_interval` | 从某个可见时点开始的质量降级区间 | market、connection、质量状态 |

每条 fact 都包含：

- `record_id`：业务语义的 SHA-256；本地到达时钟和 lineage 不参与，因此完全相同的事实可合并；
- `business_key`：冲突检测键；同键、不同语义不能 last-write-wins；
- 五个原始时钟及 `visible_at`；
- 永久为 `UNVERIFIED` 的 continuity；
- parser、connection、market/token 身份；
- 一项或多项 direct raw lineage；
- 可为空的 `dependency_lineage`，记录用于归类/富化该事实的 Gamma 身份等因果输入。

Quarantine 单独写入 `quarantine.jsonl`，包含 reason、业务键、受影响 record ID、首次可见时间、
direct raw lineage 和可选 dependency lineage。它不是可用市场事实，也不能被静默删除。

## 时间合同

| 字段 | 含义 |
|---|---|
| `source_time` | provider 声明的事实观察时间；可空 |
| `server_time` | relay/provider 声明的发送时间；可空 |
| `receive_time` | 本地 I/O callback 在解析前采样 |
| `process_time` | 原始合同校验/解析完成 |
| `persist_time` | raw 已持久化的逻辑提交时间 |
| `visible_at` | 该 normalized fact 连同所有因果依赖最早可供决策使用的时间 |

所有时间只接受 UTC、恰好毫秒精度的 `YYYY-MM-DDTHH:mm:ss.SSSZ`。合同强制：

```text
receive_time <= process_time <= persist_time <= visible_at
```

若 market identity 在 raw fact 之后才可用，record 与 direct raw lineage 的可用时间会提升为
两者的较晚时间；`dependency_lineage` 保留依赖事实自身的真实可见时间。构造器禁止 record 早于
任一依赖可见。`source_time` 无论多早都不能降低 `visible_at`，而 future `source_time` 也不能
进入更早的 view。

CLOB payload 的 provider `timestamp` 在本批仅原样保存在 `provider_timestamp_raw`；其语义尚未被
本项目合同证明，因此不会冒充 `source_time`。Book 的本地可见性与 stale 判断仍使用已审计的
receive/process/persist 链。

## Decimal 与 payload

- 外部价格、数量在 normalized payload 中是十进制字符串；
- Python `Decimal` 可进入构造器并转换成保留尾零的普通十进制字符串；
- binary `float` 在合同边界直接拒绝；
- 盘口 price 必须在 `[0, 1]`，snapshot size 必须大于 0；
- 发布和读取都重新计算 record/quarantine ID、row count、byte count 和 SHA-256。

这保证 `67234.500000010000` 往返后仍是同一 lexeme，不会先经过 IEEE-754。

## Market 和 token 身份

身份沿用 Batch 2 的严格 Gamma 规则：slug epoch、UTC 五分钟窗口、condition、Chainlink
BTC/USD resolution source、tie=Up 规则和两个十进制 token ID 必须一致。Up/Down 始终按 label
映射，不按数组位置。

同一 `market_id` 的生命周期字段可以形成新的 metadata revision；窗口、condition、oracle 或
token mapping 若发生冲突则 quarantine，不能改写已建立的五分钟分区。condition、slug、窗口或
token 被两个 market 声称时会同时 quarantine 冲突两侧，不采用 last-write-wins。Gamma payload、
raw envelope 的 market/condition/asset 与 raw manifest subscription slug 必须一致；错误声明的
身份即使在后续 manifest 才首次出现，也会在该依赖身份可见时失败关闭，而不会向过去泄漏。

## Lineage

每项 lineage 至少包含：

- raw dataset/manifest ID 与 exact manifest SHA-256；
- raw segment SHA-256，以及 segment、line、outer-array message ordinal；
- raw event ID 与 payload SHA-256；
- raw 原始 `persist_time` 与该 lineage contribution 的 `visible_at`。

`raw_lineage` 证明本 row 直接来自哪个 raw event；`dependency_lineage` 证明哪个 Gamma raw fact
建立了 market/condition/token 归属。两类 lineage 都必须能在 manifest `raw_inputs` 中找到对应
manifest 与 segment。

Raw causal identity 是 `(manifest ID, manifest SHA-256, segment ordinal, line ordinal,
message ordinal)`；输入 `dataset_id` 不允许重复。跨 manifest 在同一 raw persist millisecond
发生相互矛盾的连接或盘口状态时，没有可靠先后关系，view 必须失败关闭，不能按 event ID 猜顺序。

Normalized manifest 另外记录所有输入 subscription、脱敏采集配置、collector commit、segment
路径/hash、实际 normalizer Git HEAD、normalizer source SHA-256 和 worktree state。订阅与配置
只允许 Batch 2 已审计的 public、credential-free 字段。
