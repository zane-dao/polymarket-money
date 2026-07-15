# Batch 02.5：Quality gates

## Build admission gate

Normalization 只接受 `ManifestVerifier.verify()` 返回的 proof object，并在实际构建前重新核对：

- final raw manifest 的 exact bytes 与 SHA-256；
- 每个 closed segment 的 exact bytes 与 SHA-256；
- proof 中的 source、stream、subscription、sanitized config、collector commit 和 continuity；
- 所有输入 continuity 必须是 `UNVERIFIED`。
- raw `dataset_id` 必须唯一；lineage 同时绑定 dataset ID 与 exact manifest SHA-256；
- 不同 manifest 中相同 `(source, event_id)` 若内容冲突，整个构建失败。

因此，verify 后再篡改 manifest 或 segment 也会失败。不能直接伪造 `VerifiedDataset`，不能用
`.partial` segment，不能通过 normalized API 绕过 raw gate。

## Fact quality gate

| 问题 | 处理 |
|---|---|
| parser error/quarantined/unparsed | raw 保持不变；normalized quarantine；不进入有效 fact |
| off-topic RTDS symbol/topic/type | quarantine；不进入 BTC normalized price |
| market/condition/token 不明 | quarantine；不猜测映射 |
| condition/token 被多个 market 声称 | identity collision quarantine；禁止 last-write-wins |
| Gamma payload/envelope/subscription 不一致 | 两侧 identity binding quarantine；未来才解析出的被声明身份也失败关闭 |
| CLOB audit envelope/payload 不一致 | `INVALID_CONNECTION_AUDIT` + `RESET_REQUIRED` |
| delta 早于当前 snapshot | quarantine + `RESET_REQUIRED` |
| invalid Decimal、size、price | quarantine/合同拒绝 |
| crossed book | quarantine + `RESET_REQUIRED` |
| 任一 token empty bid 或 ask | row 可保留作事实；该 token midpoint null；整个 market `UNTRADEABLE` |
| market identity revision 冲突 | quarantine；旧身份不被覆盖 |
| 同业务键冲突 | quarantine；禁止 last-write-wins |
| 生命周期关闭/不接单/窗口外 | row 可审计；所有 book 不可执行 |
| 当前连接缺任一 Up/Down snapshot | 所有 token 保持 `WAITING_FOR_SNAPSHOT` |

任何 market 或 token 级 active quarantine 都使该 market 的所有 token book 失败关闭。
Quarantine 只能随 `visible_at` 生效，不反向污染它出现前的 view；若归类依赖未来才出现的 Gamma
身份，其 `visible_at` 会提升到依赖可见时刻，direct lineage 仍保留原 raw persist time。

真实 collector audit payload 必须恰好是 `{audit_event, details}`，且 `audit_event` 与 envelope
`event_type` 一致。`subscription_sent`、`heartbeat_ping`、`heartbeat_pong` 只做校验而不改变连接
状态；`capture_complete`、timeout、error、early close 都使连接进入 `DISCONNECTED`。

## Binance gate

默认 normalized config 是 `binance_default_transport_scope=btc-only`。若 raw manifest 记录
`transportScope=all-symbols-quarantine`，构建器还要求显式
`allow_binance_all_symbols_fallback=true`；否则拒绝构建。显式选择和 raw transport scope 都会
进入 normalized manifest。

即使显式启用 fallback，非 `btcusdt` 消息仍只能进入 quarantine，不能成为 BTC price。

## Storage gate

- 单写者 lock；不声称支持多 writer 协调服务；
- 临时目录中完成 write、flush、file fsync 和 directory fsync 后才 rename 发布；
- Linux `renameat2(RENAME_NOREPLACE)` 原子发布；已存在的 `version=<dataset_hash>` 永不覆盖；
- publish 前重新从 frozen rows 生成 bytes，并核对 manifest、hash 与 output inventory；
- load 时重新核对 manifest hash、目录版本、每个 output SHA/bytes/rows 和逐行合同；
- 每条 direct/dependency lineage 必须能回指 manifest 的 raw input segment；
- `/mnt/<drive>` 路径在创建目录前拒绝，并读取 `/proc/self/mountinfo` 识别 bind-mounted
  `9p`/`drvfs`/NTFS；支持范围仅为 WSL/server Linux-native filesystem；
- review pack 不含 normalized/raw data，只含 HANDOFF。

## Accepted limitations

- continuity 永久 `UNVERIFIED`；这不是待“修复”的缺口；
- 长期 reconnect supervisor 延后到 Batch 2B；
- 当前只有 single-writer，不支持并发 writer 协调；
- 不验收 DrvFS；
- 未做长期采集、吞吐、容量或恶意磁盘写权限攻击测试；
- SHA-256/content-addressing 提供完整性与可复现性，不等同于签名或可信时间戳。
- CLOB provider timestamp 暂按 opaque payload 保存，尚未升级为可信 `source_time`。
- 跨 manifest exact-millisecond 冲突没有可证明顺序，当前选择 `RESET_REQUIRED`，不虚构全序。
