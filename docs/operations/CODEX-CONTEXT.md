# Codex 缓存感知上下文编排

本组件服务于 `polymarket-money`，目标是在不建立第二套语义真相的前提下，降低重复上下文加载并提高任务恢复稳定性。

## 工作方式

1. **Hook（钩子）负责确定性触发**：启动、提示提交、工具调用、压缩前后与停止时执行轻量脚本。
2. **Skill（技能）负责语义规则**：只在路由命中或持久写回时使用，不依赖 Skill 自己隐式触发。
3. **仓外检查点负责恢复**：普通代码进度进入 Git 私有目录或用户目录，不污染仓库文档。
4. **仓内文档是唯一语义真相**：只有长期状态、决策、规范、批次结论发生变化时才最小写回。

## 缓存策略

- 稳定的 `AGENTS.md` 前缀保持短小且少改。
- `SessionStart` 仅注入边界和极短状态，不整篇读取 `GOALS/CURRENT/INDEX`。
- `UserPromptSubmit` 只在路由变化或路由源文档变化时注入，默认最多两个路由。
- 普通任务结束只生成机器检查点；语义写回受评分、显式指令和冷却时间共同限制。
- 文档压缩仅生成候选，默认不自动改写；真正压缩必须先归档、再覆写、再修复索引。

## 三层兜底

| 层 | 职责 | 是否依赖模型判断 |
|---|---|---:|
| Hook | 稳定触发、预算、去重、安全拦截、检查点 | 否 |
| 路由 Skill | 告诉 Codex 本轮应读什么、不要读什么 | 是，但由 Hook 显式提示 |
| AGENTS 最小规则 | Hook 未运行时仍要求渐进读取 | 是 |

## 常用命令

```bash
python3 .codex/hooks/context_orchestrator.py --doctor
python3 .codex/hooks/context_orchestrator.py --status
python3 .codex/hooks/context_orchestrator.py --route "修复回测校准图"
python3 .codex/hooks/context_orchestrator.py --maintain
```

Hook 或脚本发生变化后，在 Codex 中运行 `/hooks`，审核并信任新哈希，然后新建会话。

## 调参

编辑 `.codex/context-policy.toml`。推荐先使用 `balanced`（平衡）模式至少一周：

- `lean`（精简）：更少上下文与更少语义写回。
- `balanced`（平衡）：默认推荐。
- `memory`（强化记忆）：适合跨批次持续工作。

不要以“每次任务都更新 CURRENT”来换取安全感。普通调试、失败实验和可从 Git 恢复的信息，应只进入检查点。
