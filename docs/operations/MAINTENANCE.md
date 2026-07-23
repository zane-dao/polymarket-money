# 项目文档维护协议

## 1. 调度

实质性项目任务先完整读取 [docs/INDEX.md](../INDEX.md) 和
[当前状态](../plan/CURRENT.md)。涉及具体 Batch 时再读
[Batch 索引](../batches/BATCHES-INDEX.md) 与对应设计；其余规范、背景、架构、决定、报告或
一份历史摘要按任务读取，不全量扫描 archive。

## 2. 结束时更新顺序

1. 用当前工作树、测试和官方协议核对新要求；冲突时以规范的替代规则处理。
2. 完成实现和验证，记录命令与结果到相应 batch report。
3. 只要改动影响当前 Web 前端、Web 后端、策略 catalog 或 Paper 运行链，就必须在同一任务内执行
   `npm run release:candidate`，让 4273 使用新不可变 release 重启；不能把源码已构建等同于进程已更新。
   若可选的 `polymarket-vite-4174.service` 当时正在运行，该命令还必须重启并回读 4174；未运行时不主动
   创建开发服务。
   重启后必须从实际 4273 API 回读 release ID、`staging-sim`、`LIVE_TRADING_ENABLED=false`，并核对
   本次改动的一个可观察特征。仅文档、注释或不进入运行产物的测试改动不要求重启。
4. 只在 `docs/plan/CURRENT.md` 更新当前事实、未完成项和明确停点。
5. 仅有跨会话取舍时更新 `docs/decisions/DECISIONS.md`：新决定插在“最新决定（倒序）”的最上方，并写 `YYYY-MM-DD HH:MM 时区`。
6. 有追溯价值的实质工作使用 [会话模板](SESSION-SUMMARY-TEMPLATE.md) 新增到 `docs/archive/sessions/`；在 `SESSION-ARCHIVE-INDEX.md` 表格最上方登记，并写时间。
7. 仅在目标、规范、阶段、路由或架构实际变化时更新相应文档与 `docs/INDEX.md`。

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
| Batch 导航与要求 | `docs/batches/BATCHES-INDEX.md`、对应 Batch 目录 |
| 报告导航 | `reports/REPORTS-INDEX.md` |
| 执行证据/结论 | `reports/batches/` 对应 Batch 目录 |
| 历史会话与被替代文档 | `docs/archive/` |

## 4. 检查

- 当前状态、计划和报告是否混写？
- 是否出现两个有效目标、live 开关或时间定义？
- 新文档是否已进入 `docs/INDEX.md` 路由？
- 是否有断链、过期路径或未归档的重复文档？
- 仓库自有 Markdown/MDX 文档是否保持全局文件名唯一？
- 是否只有 `docs/INDEX.md` 使用 `INDEX.md` 文件名？
- 是否误存了凭据、原始数据、大型 artifact 或完整会话？
- 运行时代码有改动时，4273 是否已重启并从实际 API 回读了新 release 与安全开关；若 4174 原本在运行，
  它是否也已重启并通过页面探测？
