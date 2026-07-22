# Workbench 只读查询层

`BackendQueryService` 只读取已经持久化的回测结果，不直接访问前端，也不接受文件路径或 SQL。回测结果必须先通过 `FileBacktestResultStore` 的 SHA-256 sidecar 完整性校验，随后查询层才会返回经过字段白名单过滤的 DTO。

桌面后端 `scripts/workbench-command.ts` 暴露以下命令：

- `get-backtest-decisions`、`get-backtest-orders`、`get-backtest-fills`、`get-backtest-settlements`
- `get-backtest-equity`、`get-backtest-replay`
- `compare-backtests`

策略对比只接受数据集及版本、手续费模型、延迟、初始资金和最大仓位完全一致的运行；任一执行假设
不同都会由后端拒绝，避免前端把不可比结果排成误导性排名。
- `get-system-health`、`list-system-incidents`

分页命令使用 `{ runId, page: { page, pageSize } }`，页码从 1 开始，单页最多 100 条。比较命令使用 `{ runIds: [...] }`，最多 20 个不重复的运行 ID。

系统状态当前诚实报告工程现状：数据集扫描和回测任务目录可检查；数据库尚未接入，因此为 `unavailable`，总状态为 `degraded`；当前没有持久化的系统异常仓库，因此异常列表为空，不从日志文字推断或伪造事故记录。所有状态响应固定标记 `executionMode: paper-only` 和 `liveTradingEnabled: false`。

修改查询字段时，需要同步更新 `PUBLIC_FIELDS` 白名单和 `backend/tests/query-service.test.ts`。新增桌面命令时，还需补充 `backend/tests/workbench-command-integration.test.ts`，用真实的临时持久化结果验证完整性校验、分页和敏感字段过滤。
