# 仓库工作规则

本规则适用于整个仓库。

## 项目上下文与渐进读取

<!-- codex-context-orchestrator:start -->
- 本仓是代码、工程文档和项目管理文档的唯一主仓；`docs/INDEX.md` 是跨文档任务的调度入口，但**不作为每个任务的固定前置**。
- 窄范围代码任务先读取目标文件和邻近测试。只有任务涉及当前阶段、授权边界、跨模块影响、具体 Batch、长期决定或语义文档时，才按 Hook 路由渐进读取最多两个入口。
- 需要项目级路由时，顺序为：`docs/INDEX.md`，再按需读取 `docs/plan/CURRENT.md`、对应 Batch、规格、架构、决定或报告。不得为了“了解全貌”扫描全部历史、全部 Skill 或整个文档树。
- `.codex/hooks/context_orchestrator.py` 提供确定性路由和仓外私有检查点；相同路由且来源未变化时不重复注入。检查点只用于恢复未提交意图，不得覆盖代码或规范文档。
- `$polymarket-context-router` 仅用于跨文档编排；普通文件内改动不必加载。语义写回只在用户明确要求或高置信度持久变化时，通过显式 `$polymarket-memory-maintainer` 做一次最小审查。
- `docs/plan/CURRENT.md` 是当前状态的唯一来源；`docs/decisions/DECISIONS.md` 是跨会话决定的唯一来源。普通修复、短期调试、失败实验和重复表述只进入私有检查点。
- 特殊标签：`#ctx:refresh` 强制刷新路由，`#ctx:none` 本轮不注入路由，`#ctx:persist` 明确请求持久审查，`#ctx:root-ok` 表示用户已批准根目录新建项。
<!-- codex-context-orchestrator:end -->
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
- 启动采集需经用户明确批准。
- 不读取或索取真实私钥、助记词、API Key、cookie 或生产凭据。
- 不在本目录保存数据库、原始行情、完整会话 JSONL 或大体积 artifact。
- 在该项目的根目录新建任何文件夹或者文件都需要选项模式询问批准。
- 代码迁移须经单独批准，并完成清点、来源、许可证和行为审查。

## 设计规则

- 领域类型不得依赖供应商 SDK。
- 外部 I/O 必须隔离在 adapter。
- 策略函数必须确定性运行，且所有输入显式传入。
- 时间戳使用 UTC ISO 8601 字符串，并沿用 `backend/core/src/domain` 的规范字段名。
- 新执行行为须有单元测试，并补充适当的回放、集成、golden 或 shadow 测试。
