# 项目文档维护协议

## 1. 调度

实质性项目任务完整读取 [docs/INDEX.md](../INDEX.md)、[项目规范](../spec/PROJECT-SPEC.md)、[当前计划](../plan/CURRENT.md) 和 [项目背景](../background/PROJECT-BACKGROUND.md)。再按索引读取目标、决定、批次材料、报告或一份历史摘要；不要全量扫描 archive。

## 2. 结束时更新顺序

1. 用当前工作树、测试和官方协议核对新要求；冲突时以规范的替代规则处理。
2. 完成实现和验证，记录命令与结果到相应 batch report。
3. 只在 `docs/plan/CURRENT.md` 更新当前事实、未完成项和明确停点。
4. 仅有跨会话取舍时更新 `docs/decisions/DECISIONS.md`：新决定插在“最新决定（倒序）”的最上方，并写 `YYYY-MM-DD HH:MM 时区`。
5. 有追溯价值的实质工作使用 [会话模板](SESSION-SUMMARY-TEMPLATE.md) 新增到 `docs/archive/sessions/`；在 `INDEX.md` 表格最上方登记，并写时间。
6. 仅在目标、规范、阶段、路由或架构实际变化时更新相应文档与 `docs/INDEX.md`。

## 3. 单一真相

| 内容 | 权威位置 |
|---|---|
| 阅读入口 | `docs/INDEX.md` |
| 总目标 | `docs/goals/PROJECT-GOALS.md` |
| 稳定 must/must-not | `docs/spec/PROJECT-SPEC.md` |
| 当前阶段与停点 | `docs/plan/CURRENT.md` |
| 长期阶段顺序 | `docs/plan/ROADMAP.md` |
| 未完成项 | `docs/plan/BACKLOG.md` |
| 长期决定 | `docs/decisions/DECISIONS.md` |
| 当前架构 | `docs/architecture/ARCHITECTURE.md` |
| 批次要求 | `docs/batches/` |
| 执行证据/结论 | `reports/batches/` |
| 历史会话与被替代文档 | `docs/archive/` |

## 4. 检查

- 当前状态、计划和报告是否混写？
- 是否出现两个有效目标、live 开关或时间定义？
- 新文档是否已进入 `docs/INDEX.md` 路由？
- 是否有断链、过期路径或未归档的重复文档？
- 是否误存了凭据、原始数据、大型 artifact 或完整会话？
