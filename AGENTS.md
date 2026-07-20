# 仓库工作规则

本规则适用于整个仓库。

## 项目上下文与渐进读取

- 本仓是代码、工程文档和项目管理文档的唯一主仓；项目入口为 [docs/INDEX.md](docs/INDEX.md)。
- 每个实质性项目任务先完整读取 `docs/INDEX.md`、`docs/spec/PROJECT-SPEC.md`、`docs/plan/CURRENT.md` 和 `docs/background/PROJECT-BACKGROUND.md`，再按索引精确读取。
- `docs/plan/CURRENT.md` 是当前状态的唯一来源；`docs/decisions/DECISIONS.md` 是跨会话决定的唯一来源。
- 原始会话、原始数据、凭据和大体积产物不入 Git；提炼的历史会话摘要只放 `docs/archive/sessions/`。

## 指令优先级与文档分层

- 用户最新的明确要求优先于旧仓库指引，但不得违背更高层安全规则或已验证事实。若发生冲突，应在同一任务内更新或明确标注被替代的文档，避免留下两套有效规则。
- Batch 的计划、设计、范围和验收要求属于 `docs/batches/batch-XX-topic/`；测试、环境、执行证据和结论属于 `reports/batches/batch-XX/`。
- 每个 Batch 的规范交接文件为 `HANDOFF-BATCH-XX.md`。交接、设计和证据均在本仓的 `docs/` 与 `reports/` 中维护；不得另建默认外部审阅副本。

## Git 协作流程

- 默认流程为：创建主题分支、完成本地检查、推送分支、创建 Pull Request、检查通过后合并到 `main`。
- 不直接向 `main` 推送常规改动；只有用户在当次任务中明确要求时才可例外。
- 提交与 PR 只包含本次任务相关改动；合并前应报告目标分支、改动摘要、验证结果和待处理风险。

## 安全边界

- 除非未来获得明确、经审阅的任务授权，否则持续保持 `LIVE_TRADING_ENABLED=false`。
- 不读取或索取真实私钥、助记词、API Key、cookie 或生产凭据。
- 不提交、撤销或模拟提交真实交易所订单。
- 不在策略模块中新增网络调用。
- `/mnt/d/polymarket-paper`、`/mnt/c/Users/seeta/Desktop/hello-world`、`/root/projects/polymarket-paper-workbench` 和 `/root/projects/olymarket-trade-engine` 均为只读参考。
- 代码迁移须经单独批准，并完成清点、来源、许可证和行为审查。

## 设计规则

- 领域类型不得依赖供应商 SDK。
- 外部 I/O 必须隔离在 adapter。
- 策略函数必须确定性运行，且所有输入显式传入。
- 时间戳使用 UTC ISO 8601 字符串，并沿用 `execution/src/domain` 的规范字段名。
- 新执行行为必须有单元测试，并补充适当的回放、集成、golden 或 shadow 测试。
