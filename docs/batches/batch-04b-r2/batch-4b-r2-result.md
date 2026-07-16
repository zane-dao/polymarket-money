# Batch 4B-R2 result

结论：**INCOMPLETE_EVIDENCE**。

预注册配置 hash 未变，metrics-only session 实际运行 7,262.862 秒，触及 24 个市场，但只有
15 个满足覆盖至少 285 秒、开始延迟不超过 15 秒、结束缺口不超过 1 秒的冻结门。运行最终
因过期市场 fee evidence 被送入机会计算而 terminal fail closed。用户明确决定不重跑，故本批
不降低门槛、不创建 `batch-4b-r2-observation-accepted` 或 `batch-4b-accepted`。

Complete-set 2,340 个 audit 中没有费用后正 edge；lead-lag 只有 71 raw triggers、51 episodes、
11 markets，全部来自 Chainlink，远低于 200 triggers/20 markets 门；maker 只有 spread envelope，
没有 markout、fill 或 queue evidence。路线结论保持 `DATA_INSUFFICIENT`，本地判断为
`LOCAL_SHORT_CAPTURE_ONLY`。

运行后已修复市场窗口外降级、旧市场 working-history 有界清理和统一 socket abort，但这些
修复不改变已冻结结果。没有凭据、User Channel、签名、OrderIntent、Fill 或真实订单。
