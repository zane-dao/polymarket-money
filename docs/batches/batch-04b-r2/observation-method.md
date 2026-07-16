# Batch 4B-R2 observation method

状态：**METHOD FROZEN / OBSERVATION CLOSED**

启动包装器只负责配置哈希、Git/磁盘/单 session 安全门和进程生命周期；实际公共数据读取、
盘口、ReceiveStamp、费用、Opportunity 与 lead-lag 全部继续调用 `scripts/live-runtime.ts` 及
R1 唯一活跃实现。

运行输出位于
`$POLY_DATA_ROOT/experiments/batch-04b-r2-24-market-observation/`，不写 `/mnt/d`。session
元数据记录 PID 或 systemd unit、运行 commit、配置 hash、起止时间、heartbeat、stdout、
stderr、exit status、stop reason、metrics 与报告路径。包装器提供 `launch`、`status`、`logs`
和 `stop` 子命令，并拒绝已有活跃 session 时重复启动。

完整市场按冻结配置判断：可观察覆盖不少于 285 秒、开始延迟不超过 15 秒、结束缺口不超过
1 秒。该定义在看见长期观测结果前冻结；若最终不足 24 个，结论只能是
`INCOMPLETE_EVIDENCE`，不得降低门槛。

每个有效统计点必须通过 snapshot、双边、非 crossed、非 stale、非 disconnect、非 reset、
非 quarantine 门。公共 CLOB 无 gap-free cursor，因此 continuity 始终保持 `UNVERIFIED`。

启动健康门确认当前 Gamma 将 `feeSchedule.rate` 返回为 JSON number。兼容层只从原始响应中
保留其精确数值词法（例如 `0.07`），再交给 R1 Money/FeeEdgeCalculator；不把 JavaScript
number 传入金额合同。指数或非 canonical 数值词法继续失败关闭。

## 运行后降级与有界性整改

本次证据确认原 R1 已有 reconnect、connection reset censor、quarantine、stale/empty/crossed
排除、`UNVERIFIED` continuity 和 RuntimeIncident fail-closed，但长期运行仍缺三项：

1. 市场窗口外的 fee evidence 应成为“不生成机会/trigger”的质量拒绝，而非 terminal error；
2. 已结算市场的 as-of working history 应在最长 3 秒 horizon 落定后清理，不能长期全表增长；
3. SIGTERM 或 terminal failure 必须统一 abort 所有 socket，等待 recorder 收口后退出。

收口实现补齐以上三项，并移除每秒 metrics snapshot 中重复构造的 252-cell grid；最终 summary
仍输出完整 252 格。专项测试证明清理 working history 不删除 trigger/horizon/episode/grid 证据，
AbortSignal 会关闭并 resolve 公共 socket。该整改只修复未来运行，不追认本次不完整观测。
