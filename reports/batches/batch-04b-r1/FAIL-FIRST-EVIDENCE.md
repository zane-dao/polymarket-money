# Batch 4B-R1：fail-first 证据

每节记录实现前的真实失败；后续实现提交不得删除这些失败证据。

## Group 1：ReceiveStamp 与 raw-event-v2

fail-first 输入为 `tests/unit/receive-time-r1.test.ts`，命令 `npm test`。基线报错显示缺少 `receive-time.js`、`createEnvelopeDraftV2` 和 `requireSubsecondReceiveStamp`。这证明审查基线没有可比的 ReceiveStamp 契约、没有启用的 raw-event-v2 constructor，也没有阻止 v1 record 进入 subsecond 工作。

## Group 2：RuntimeIncident 与 terminal fallback

`tests/unit/runtime-incidents-r1.test.ts` 要求 structured incident contract、fail-closed runtime controller 和 one-shot emergency receipt path。基线没有 `runtime/incidents.js`，编译还暴露未标注类型的 callback parameter，故实现前必须失败。

## Group 3：Decimal 复用与统一 fee/edge

共享 `fee-edge-v1.json` fixture 与 TypeScript/Python contract test 要求 `decimal.js`、私有 `MoneyDecimal`、单一 `FeeEdgeCalculator` 和 Python fee evidence/status field。基线缺 `decimal.js`、`fee-edge.js`、`money.js` 和 `FeeEvidenceStatus`，两种语言测试均按预期失败。

## Group 4：Opportunity observation 与 route evaluation 分离

`opportunity-observation-r1.test.ts` 要求不可变、versioned、canonical-hashed 的 `OpportunityObservationV1` fact contract，以及独立的 `RouteEvaluationV1` aggregate；当前唯一决策应是 `DATA_INSUFFICIENT`。基线只有 mutable-shallow 的临时 record，缺少该 module。后续加强测试还要求显式 `git_commit`、`session_id`、fee evidence、continuity、eligibility、rejection 与 `observation_id`；不得把必填 schema field 藏在 generic facts。

兼容的 `observeCompleteSet` 过去会从单条 quote 返回 `RESEARCH_CANDIDATE`，违反冻结契约；加强后的 legacy test 要求 `OBSERVED_NOT_EXECUTABLE`，直到移除 route-level label 才通过。

## Group 5：跨 venue lead-lag 因果契约

`lead-lag-r1.test.ts` 要求冻结四来源 252-cell grid、严格 ReceiveStamp baseline、fixed-horizon as-of query、外部与 Polymarket connection identity、reconnect censoring、独立 next-update metric、quality gate、replay/runtime equivalence 和 versioned 500ms episode。基线没有 `LeadLagEngine` 或 `EpisodeTracker`，只在 display loop 比较相邻 spot value。

## Group 6：活跃 ReceiveClock 与 raw-event-v2 接线

`runtime-wiring-r1.test.ts` 要求 HTTP/WS receive boundary 共享 `ReceiveClock`，active `RawSegmentWriter` 只接收 v2 draft，v1 只读。基线 runtime 缺 `receiveClock`/`receiveStamp`，writer 只为 v1 类型化，因此 v2 draft 不能赋值。

## Group 7：runtime 集成与显式错误处置

`runtime-integration-r1.test.ts` 静态防止退回到 adjacent-spot 5bp observer、重复算术、将 provider-time 标成 receive latency 和空 catch。它还要求 active runtime 引用冻结的 lead-lag、精确 fee、不可变 observation 和 fail-closed incident contract；基线不引用这些 R1 contract。

## Second Sol Critical 后续

read-only re-review 发现初版没有把 horizon record 做成自包含 causal artifact：缺 input lineage watermark，rejected frame 后未使既有 Polymarket state 失效，A -> B -> A market transition 可错误复活 A episode，也没有 versioned runtime config binding。加强测试要求 `input_hash`、`external_event_id`、`notePolymarketQualityFailure`、`opportunity-config.js`、`grossEdge`、canonical-string-only Gamma fee、真实 lead-lag observation 与 trigger output。

offline Python truth chain 原先只导入 `RawEventEnvelopeV1`，导致 collector 产生的 raw-event-v2 segment 无法通过 manifest/replay/normalization。跨语言 fixture 还冻结：缺 fee 必须返回 `None`/`MISSING_FEE_EVIDENCE`，价格高于一必须 fail closed，不能使用 `Decimal("0")`/`UNKNOWN_FEE`。

horizon contract 进一步分开 trigger-time 与 horizon-state 的 Polymarket lineage：成功 50ms markout 必须命名 640ms state input，rejected frame 的 censor 必须命名对应 raw input。fractional-millisecond duration 在进入 facts 前必须序列化为 canonical non-exponent decimal string；safe integer count 保持 JSON number。

offline raw-v2 验证必须拒绝 cross-domain 或非递增 segment ReceiveStamp；同纳秒允许 ordinal 1 再 2，反序必须在 `RawReplay` 暴露前失败。CLOB integration 只允许成功应用的 `book`/`price_change` mutation 刷新 lead-lag book ReceiveStamp；`last_trade_price` 仅 raw-preserved，失败 mutation 必须使旧 state 失效。

post-implementation review 还发现 v2 ReceiveStamp loop 将局部 `ordinal` 复用并覆盖 manifest segment ordinal。multi-segment test 要求保存 `[0, 1]` 并按 `segment-0`、`segment-1` replay，而不是 receive ordinal `[1, 2]`。data-quality report 也不得将 provider-clock 与 local-wall delta 标为 `receive_latency`；必须使用 `provider_source_to_local_wall_delta_ms` 或 `provider_server_to_local_wall_delta_ms`。

最后，unknown-fee branch 曾在 `paper.ts` 和 `opportunities.ts` 绕过 `FeeEdgeCalculator` 并手写 gross edge。fail-first guard 禁止该 fallback，要求两处均输出 `MISSING` evidence，并以 visible size 2 验证 legacy opportunity gross amount 为 `0.08`，而不是未按数量缩放的 `0.04`。
