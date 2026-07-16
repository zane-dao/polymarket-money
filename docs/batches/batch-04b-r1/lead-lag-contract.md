# Batch 4B-R1 cross-venue lead-lag contract

状态：**IMPLEMENTED / NO LONG OBSERVATION**

## 冻结预注册

- 来源：Polymarket RTDS Chainlink、Polymarket RTDS Binance relay、Binance spot、Binance perpetual；
- 阈值：1/2/5 bp；
- trigger window：100/250/500ms；
- horizon：50/100/250/500/1000/2000/3000ms；
- 完整报告：4 × 3 × 3 × 7 = 252 cells，不做 best-only 筛选；
- baseline max age 100ms，horizon state max age 1000ms；
- episode rule `lead-lag-episode-v1`，inactivity gap 固定 500ms。

配置、episode version、gap、grouping dimensions 和连接 reset 行为进入 config hash。

## Baseline

```text
baseline_target = external_event_monotonic_time - trigger_window
```

查询只取 target watermark 及以前、同来源/domain/external connection 的最新状态。记录 target
stamp、observation stamp、age 和 effective window。不存在、过旧、质量失败或连接不符时不
生成 trigger；不插值、不 backward fill。阈值/窗口重叠 trigger 保留，并共享
external_event_id / overlap group / episode。

## Fixed horizon

```text
horizon_target = trigger_monotonic_time + horizon
```

主要 markout 只使用 target watermark 及以前、同 market/domain/Polymarket connection 的最新
合格 snapshot。stale、disconnect、crossed、empty side、quarantine、过旧或任一连接 reset
均 censored；target 后状态绝不冒充固定 horizon。

`next_update_after_horizon` 是独立字段，只报告 delay、direction、magnitude 和 observation
stamp。runtime timer 与 replay 都调用同一纯 as-of engine，并由 ReceiveStamp watermark
确定同 ns 顺序。

## Episode 与统计边界

key 至少包含 source、direction、market、clock domain、external connection 和 Polymarket
connection。反向、跨市场、跨 domain、连接 reset 或 inactivity gap >500ms 开新 episode。
summary 保存 start/end/duration/trigger count。RouteEvaluation 同报 raw triggers、episodes 和
markets，但本批不宣称 episode 统计独立，也不实现最终置信区间模型。
