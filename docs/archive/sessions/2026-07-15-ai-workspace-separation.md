# 2026-07-15 用户/项目/代码三层工作区分离

## 目标

把跨项目通用规则、Polymarket 项目长期上下文和业务代码分开，使用户不必在每个会话
重复项目目标和范围，并让 AI 通过总索引渐进披露。

## 事实与证据

- Windows Claude 用户层已有 `/mnt/c/Users/seeta/.claude/CLAUDE.md`，内容以跨项目规则为主。
- WSL Codex 用户层 `/root/.codex/AGENTS.md` 原为空文件。
- 此前没有 `/root/projects/polymarket-codex-sessions`；项目背景主要散在代码仓 docs 和旧
  `/mnt/d/polymarket-paper` 工作区。

## 修改

- 用户层：为 `/root/.codex/AGENTS.md` 增加通用规则和项目注册表；在既有 Windows Claude
  用户层分布地图中只增加新项目的两个入口，不写入项目细节。
- 项目 AI 层：创建 `polymarket-codex-sessions`，包含总索引、目标、范围、决策、当前状态、
  知识路由、会话摘要、交接、Skill 索引、Claude/Codex 入口和摘要模板。
- 代码层：`polymarket-money/AGENTS.md` 增加项目总索引入口，并修正参考项目实际路径。
- VS Code：多根工作区增加 `polymarket-codex-sessions` 入口。

## 验证

- 15 个项目 AI 层文件均存在且非空；VS Code workspace JSON 解析通过。
- 用户层、项目层、代码层都能检索到相互入口；项目目标、仓库角色和安全开关已写入索引。
- 两个只读参考 Git 仓库 tracked 状态未变化。
- 根据当前 Codex 官方手册核实：全局/项目 `AGENTS.md` 在新会话启动时自动分层加载，普通
  `INDEX.md` 由 AGENTS 指示主动读取；同一会话不会每条消息自动重扫。
- 不涉及业务代码、依赖安装、数据读取、采集、凭据或交易。

## 决定

- `INDEX.md` 是本项目唯一总入口；项目目标/范围不再依赖用户重复描述。
- 不复制旧完整会话或交易 Skill；使用索引链接，只有稳定重复流程才创建新 Skill。
- AI 在实质任务后主动维护项目索引、状态、决策、摘要和交接，无需用户专门提醒；普通
  闲聊不机械写文件。

## 未决问题

- 是否在后续批次稳定后创建 `polymarket-context-router` 或
  `polymarket-backtest-integrity` Skill。

## 下一步

- 等待用户给出下一阶段提示词；不自行开始迁移、采集或执行。
