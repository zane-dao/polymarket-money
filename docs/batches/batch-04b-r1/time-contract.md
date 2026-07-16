# Batch 4B-R1 time contract

状态：**IMPLEMENTED / OBSERVATION NOT RUN**

## ReceiveStamp

亚秒顺序的唯一键是：

```text
(clock_domain, local_monotonic_receive_ns, local_receive_ordinal)
```

- HTTP 在响应头到达后、读取 body 前采样；WebSocket 在 message callback 入口、解析前采样。
- 默认 HTTP、WebSocket 与 horizon timer 共用一个进程级 `ReceiveClock`。
- 同一 monotonic ns 由进程级 ordinal 排序；ordinal 在 clock domain 内正整数、唯一、递增。
- 跨 clock domain 比较直接失败；wall time 不参与亚秒排序，也不由 monotonic time 推导。
- provider source/server time 只保留为供应商字段。展示指标名为
  `providerToLocalWallDelta`，不得称为 receive latency。

## raw-event-v2

活跃 `RawSegmentWriter` 只接受 `raw-event-v2`，一个 segment 只能包含同一 clock domain 且
ReceiveStamp 严格递增的事件。v1 parser 保留只读兼容，但 `requireSubsecondReceiveStamp` 明确
拒绝 v1 进入亚秒研究。

v2 明确区分：provider source/server time、local wall receive time、local monotonic ns、local
ordinal、clock domain 和 transport connection。完整 ReceiveStamp 进入 lead-lag lineage、
Opportunity canonical hash 与 raw envelope。

## 连接身份与失败关闭

Cross-venue 对象没有 generic connection ID，分别保存 branded
`external_connection_id` 与 `polymarket_connection_id`。连接断开或重连会登记 reset：旧外部
baseline、旧 Polymarket snapshot 不得复用；未完成 horizon 被 censored；episode 结束。

## 证据

`receive-time-r1.test.ts`、`runtime-wiring-r1.test.ts`、`lead-lag-r1.test.ts` 覆盖同 ns ordinal、
早 watermark 排除未来 ordinal、跨 domain 失败、网络边界采样、v1 禁亚秒、连接 reset 和
runtime/replay as-of 一致性。
