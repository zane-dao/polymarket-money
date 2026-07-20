# Polymarket BTC 五分钟项目文档索引

本仓是项目代码与项目文档的唯一主仓。本文件是 AI 和人工阅读的唯一调度入口：按任务渐进读取，不为了解背景扫描全部历史。

## 标准必读包

每个实质性项目任务先完整读取：

1. 本文件：目标、边界、路由；
2. [项目规范](spec/PROJECT-SPEC.md)：稳定 must/must-not；
3. [当前计划](plan/CURRENT.md)：当前事实、停点和授权边界；
4. [项目背景](background/PROJECT-BACKGROUND.md)：为何采用当前边界。

普通闲聊、单句解释和无关任务不必加载本包。当前状态只有 [plan/CURRENT.md](plan/CURRENT.md) 一份权威来源；跨会话决定只有 [decisions/DECISIONS.md](decisions/DECISIONS.md) 一份权威来源。

## 当前阶段与硬边界

Batch 1、2、2.5、3A、3B、4B-R1、5P 和 Batch 06 已有历史设计/报告；4B-R2 以 `INCOMPLETE_EVIDENCE` 关闭且不重跑。后续只在本仓收敛研究和产品主线。K/J 的 paper 结果仍是描述性证据，L 仅为离线研究候选，均不构成 shadow/live 准入。

- `LIVE_TRADING_ENABLED=false` 持续默认。
- 不读取凭据、不连私有用户频道、不签名、不下单或撤单。
- 旧项目、旧 workbench 与开源引擎均只读，不整体复制。
- 没有可信数据、成交模型和独立样本证据，不能宣称盈利或进入 shadow/live。

## 按需路由

| 任务 | 先读取 |
|---|---|
| 目标、优先级、模型方向 | [goals/PROJECT-GOALS.md](goals/PROJECT-GOALS.md)、[goals/SUBGOALS.md](goals/SUBGOALS.md) |
| 当前进度、下一步或未完成项 | [plan/CURRENT.md](plan/CURRENT.md)、[plan/BACKLOG.md](plan/BACKLOG.md)、[plan/ROADMAP.md](plan/ROADMAP.md) |
| 既定取舍 | [decisions/DECISIONS.md](decisions/DECISIONS.md) |
| 代码边界或模块关系 | [architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md)、`execution/src/`、`research/` |
| 具体批次设计或要求 | `batches/batch-XX-topic/` |
| 测试、执行证据或验收结论 | [../reports/INDEX.md](../reports/INDEX.md) 后进入 `reports/batches/` |
| 开发、运行、维护 | [operations/SETUP.md](operations/SETUP.md)、[operations/RUNBOOK.md](operations/RUNBOOK.md)、[operations/MAINTENANCE.md](operations/MAINTENANCE.md) |
| 项目专用 Skill | [operations/PROJECT-SKILLS.md](operations/PROJECT-SKILLS.md) |
| 旧项目审计或参考来源 | `current-project-audit.md`、`engine-review.md`、`module-inventory.md`、`archive/REFERENCE-SOURCES.md` |
| 历史会话 | `archive/sessions/INDEX.md` 后精确读取一份摘要 |
| 被替代的旧设计 | `archive/legacy-engineering/`，只用于追溯，不作为操作依据 |

## 文档职责

```text
docs/
  INDEX.md                阅读入口
  spec/                   稳定规范
  goals/                  目标树
  plan/                   当前、路线与 backlog
  decisions/              长期决定
  architecture/           当前系统结构
  batches/                批次计划、设计、要求
  operations/             设置、运行、维护
  archive/                历史会话和被替代文档
reports/
  batches/                测试、执行证据、验收结论
```

代码/API/schema/测试事实以当前工作树和验证结果为最高权威；时效性协议必须重新核对官方来源。完成实质任务后按 [维护协议](operations/MAINTENANCE.md) 更新当前状态、决定和摘要。
