# Batch 02：原始数据合同

## 结论

`contracts/raw-event-v1.schema.json` 是 Python 与 TypeScript 共用的唯一 wire contract。
原始采集先保存收到的 UTF-8 文本，再解析；任何规范化结果都不能替代或重写原始消息。

TypeScript 使用两个阶段：

- `RawEventEnvelopeDraftV1`：socket/HTTP 边界创建，不允许调用方提供 `persist_time`；
- `RawEventEnvelopeV1`：存储层分配逻辑持久化提交时间，并且只有写入和 `fsync` 成功后才
  返回 durable receipt。

Python 只接受 manifest 已完整校验的 closed segment，再验证每行合同、raw hash 和时间。

## 字段与时间

| 字段 | 含义 | 可空 |
|---|---|---|
| `source_time` | 数据本身的观察/事件时间 | 数据源未给或语义未被官方定义时必须为空 |
| `server_time` | provider/relay 声明的发送时间 | provider 未给时为空 |
| `receive_time` | HTTP response headers 可用时，或 WS message callback 入口处、解析前采样 | 否 |
| `process_time` | 解析和合同校验完成 | 否 |
| `persist_time` | writer 分配的逻辑 durability-commit 时间；只在随后的 fsync 成功后承认 | 否 |

`decision_time`、`order_send_time`、`fill_time`、`settlement_time` 不属于采集信封。全部 wire
time 只接受 `YYYY-MM-DDTHH:mm:ss.SSSZ`；不接受模糊精度、非法日历日、naive time、
无单位 epoch 或本地时区字符串。唯一语法避免 Python 与 TypeScript 对 week-date、空格
分隔符和亚毫秒比较产生不同结论。

RTDS 官方明确规定外层 `timestamp` 是消息发送毫秒，映射 `server_time`；
`payload.timestamp` 是价格记录毫秒，映射 `source_time`。CLOB Market Channel 虽提供
`timestamp`，但官方未同等定义其时钟语义和稳定格式，所以 v1 将它留在 raw payload 和
`providerTimestampRaw`，不伪造成 `source_time`。

## 精度与原始保真

- `raw_payload` 是解析前完整字符串，`raw_sha256` 对其 UTF-8 bytes 计算。
- CLOB 的 price/size/fee/tick 保持原始 decimal string。
- RTDS 的 `value` 官方 wire type 是 JSON number。Node 24 使用 JSON reviver 的原始 source
  lexeme 读取，Python 使用 `Decimal` parser；普通 `number`/`float` 不进入规范化价格。
- `source_sequence` 是 string/null，避免超过 JavaScript `2^53-1` 时失真。
- vendor 的未知字段保留在 `raw_payload`；未知 `event_type` 以 `unparsed` 保存。

## parser 状态和事件流

| 状态 | 原始层 | 有效规范化流 |
|---|---|---|
| `parsed` | 保存 | 可进入，按 `event_id` 幂等 |
| `unparsed` | 保存 | 不进入；计入 unknown |
| `error` | 保存 | 进入逻辑 quarantine，不进入有效流 |
| `quarantined` | 保存 | 进入逻辑 quarantine，不进入有效流 |

合法 JSON 但 topic/type/symbol 不属于请求目标时归为 `quarantined`；它不因缺少目标事件才
要求的标量价格字段而被误记成语法错误。空帧、坏 JSON 或目标事件自身缺少必需字段才是
`error`。这条分类由实际 RTDS 初始帧触发，并有 Python/TypeScript 对称负向测试。

原始层不会按 raw hash 删除观察：相同 payload 可能是 provider 合法重复发送。writer retry
若使用同一 `event_id` 且内容完全相同，返回首次 receipt 而不追加；同 ID 不同内容是完整性
错误。manifest 验证会检查所有 parser status 的同 ID 冲突；Python effective replay 再按
event ID 去重。

## 跨语言裁判

共享 fixture 位于 `data/fixtures/batch-2/raw-event-v1.golden.jsonl`。它包含 nullable source/
server time、超过 JS 安全整数的 sequence、高精度十进制字符串、Unicode、转义换行和未知
vendor 字段。两种语言验证同一 raw hash、字段投影、精确 byte count 和 UTF-8 segment
hash；不比较各自重新序列化 JSON 的字节顺序。

早期 TypeScript execution scaffold 也已收敛：观察时钟改为 source/server/receive/process/
persist，外部 price/size/fee 改为 decimal string，官方未提供 sequence 时保持 `null`，不得
为了满足旧接口虚构连续编号。
