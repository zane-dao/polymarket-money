# Batch 4B-R2 observation method

状态：**PRE-LAUNCH METHOD FROZEN**

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
