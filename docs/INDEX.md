# Polymarket BTC 五分钟项目文档索引

本仓是项目代码与项目文档的唯一主仓。本文件是 AI 和人工阅读的唯一调度入口：按任务渐进读取，不为了解背景扫描全部历史。

## 最小必读包

每个实质性项目任务先完整读取：

1. 本文件：权威来源、边界和路由；
2. [当前状态](plan/CURRENT.md)：现在做到哪里、下一步和授权边界；
3. 当前任务涉及 Batch 时，再读取 [Batch 索引](batches/BATCHES-INDEX.md) 和对应设计。

项目规范、背景、架构和决定只在任务需要时按下表读取，不作为每次任务的固定前置。普通
闲聊、单句解释和无关任务不必加载本包。当前状态只有 [plan/CURRENT.md](plan/CURRENT.md)
一份权威来源；跨会话决定只有 [decisions/DECISIONS.md](decisions/DECISIONS.md) 一份权威来源。

## 当前状态入口

当前阶段、活跃 Batch、下一步和授权边界只看 [plan/CURRENT.md](plan/CURRENT.md)。稳定的
must/must-not 只看 [spec/PROJECT-SPEC.md](spec/PROJECT-SPEC.md)。本索引不复制易变状态或
测试数字。

## 按需路由

| 任务 | 先读取 |
|---|---|
| 目标、优先级、模型方向 | [goals/PROJECT-GOALS.md](goals/PROJECT-GOALS.md)、[goals/SUBGOALS.md](goals/SUBGOALS.md) |
| 当前进度、下一步或未完成项 | [plan/CURRENT.md](plan/CURRENT.md)、[plan/BACKLOG.md](plan/BACKLOG.md)、[plan/ROADMAP.md](plan/ROADMAP.md) |
| 既定取舍 | [decisions/DECISIONS.md](decisions/DECISIONS.md) |
| 代码边界或模块关系 | [architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md)、`execution/src/`、`research/` |
| 具体批次设计或要求 | [batches/BATCHES-INDEX.md](batches/BATCHES-INDEX.md) 后进入对应目录 |
| 测试、执行证据或验收结论 | [../reports/REPORTS-INDEX.md](../reports/REPORTS-INDEX.md) 后进入 `reports/batches/` |
| 开发、运行、维护 | [operations/SETUP.md](operations/SETUP.md)、[operations/RUNBOOK.md](operations/RUNBOOK.md)、[operations/MAINTENANCE.md](operations/MAINTENANCE.md) |
| 项目专用 Skill | [operations/PROJECT-SKILLS.md](operations/PROJECT-SKILLS.md) |
| 旧项目审计或参考来源 | [archive/ARCHIVE-INDEX.md](archive/ARCHIVE-INDEX.md) 后进入 `reference-audits/` |
| 历史会话 | [archive/sessions/SESSION-ARCHIVE-INDEX.md](archive/sessions/SESSION-ARCHIVE-INDEX.md) 后精确读取一份摘要 |
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
  REPORTS-INDEX.md         报告入口
  batches/                测试、执行证据、验收结论
```

## 权威来源

| 问题 | 唯一当前权威来源 |
|---|---|
| 项目最终目标 | [goals/PROJECT-GOALS.md](goals/PROJECT-GOALS.md) |
| 范围、非目标与稳定规则 | [spec/PROJECT-SPEC.md](spec/PROJECT-SPEC.md) |
| 当前做到哪里、下一步、当前 Batch | [plan/CURRENT.md](plan/CURRENT.md) |
| 长期阶段顺序 | [plan/ROADMAP.md](plan/ROADMAP.md) |
| 未完成工作 | [plan/BACKLOG.md](plan/BACKLOG.md) |
| 当前架构 | [architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md) |
| 架构与跨会话取舍原因 | [decisions/DECISIONS.md](decisions/DECISIONS.md) |
| Batch 范围与验收要求 | [batches/BATCHES-INDEX.md](batches/BATCHES-INDEX.md) |
| 测试、执行证据与验收结论 | [../reports/REPORTS-INDEX.md](../reports/REPORTS-INDEX.md) |
| 历史过程 | [archive/ARCHIVE-INDEX.md](archive/ARCHIVE-INDEX.md) |

代码/API/schema/测试事实以当前工作树和验证结果为最高权威；时效性协议必须重新核对官方来源。完成实质任务后按 [维护协议](operations/MAINTENANCE.md) 更新当前状态、决定和摘要。
