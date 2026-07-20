# 2026-07-15 第一批安全/domain/golden 与文档调度重组

## 目标

在新代码仓完成第一迁移批次，并把项目 AI 文档收敛为可自动调度、按需披露和持续更新的
单一真相结构；不开始第二批或任何实盘能力。

## 事实与证据

- 开始前完整读取代码仓的 audit findings、module inventory、migration plan 和 target
  architecture。
- 新测试先因 `research.polymarket_money` 不存在而失败，随后用 clean-room 最小实现转绿。
- Python 全套 30 项离线测试通过；WSL 原生 Node 下 TypeScript 5.9.3 typecheck 通过。
- 三个人工市场 net PnL 分别为 4.40、5.03、2.19，与十进制手算一致。
- Batch 1 工厂没有可达 live adapter；默认 live=false、dry-run=true、credential=none。
- 没有读取凭据、联网、启动 WS、发送订单、复制旧模块或修改两个参考项目。

## 修改

- 代码层：新增 Python domain/rules/ledger/safety、30 项 unit/golden 测试、三市场 fixture、
  四份第一批文档，并修正 README/architecture/inventory/plan/target 状态。
- AI 项目层：新增 `spec/`、`plan/`、`goals/`、`background/`、`decisions/`、`operations/`；
  根 INDEX 内置一段式总目标和标准必读包；旧 context/handoff 文件改为跳转页。
- 开发环境：WSL 安装官方 Linux Node v24.18.0/npm 11.16.0 和 Ubuntu
  `python3.14-venv`；没有改动交易所或账户外部状态。

后续审阅交接：在用户明确要求后，将四份第一批文档和六份验证/结论报告导出到
`D:\polypolycache\polymarket-money-batch-1-review`。审阅包不含代码、凭据或真实数据；
四份文档已用 `cmp` 确认与代码仓原文一致，内部 Markdown 链接检查通过。

## 验证

- `python3 -m unittest discover -s tests -p 'test_*.py'`：30/30 通过。
- WSL `/usr/local/bin/node` + `/usr/local/bin/npm` 执行 `npm ci && npm test`：通过；
  `process.platform=linux`。
- 全新 venv 构建并安装 wheel，导入来自 venv `site-packages`，仓库外 30/30 通过。
- Markdown 旧路径检索与本地目标检查：标准必读和新权威路径存在；旧入口仅保留跳转。

## 决定

- 一段式总目标放根 `INDEX.md`，详细子目标按需读取。
- 实质任务 100% 调度 INDEX + spec + current plan + minimal background；其余按需。
- 第一批黄金测试是后续迁移裁判，旧 108 项测试不能覆盖新业务规则。
- 最新用户会话的明确要求在安全/事实边界内优先于旧项目文档；AI 同步删除、归档或标注
  旧约束，不能留下双重真相。
- 可逆工程与开发环境决策由 AI 自主完成；只有真实凭据、实盘授权、不可逆外部操作或
  产品方向取舍交给用户。

## 未决问题

- TypeScript 实时 schema 尚未与 Python 第一批契约完全对齐。
- 是否启动第二批尚待用户判断；一旦启动，数据源、跨语言 schema、fixture provenance 和
  必要依赖由 AI 在只读边界内固定并记录。
- 没有 durable ledger、reconciliation、可信回测、策略、shadow 或 live。

## 下一步

停止在第一批完成点。只有用户明确启动第二批后，才规划无凭据只读数据链；不得先做采集、
回测迁移、模型上线或实盘开发。
