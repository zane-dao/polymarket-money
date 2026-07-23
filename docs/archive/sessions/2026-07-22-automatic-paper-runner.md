# 2026-07-22 自动 Paper Runner 收口

本次把 Web 主流程从手工市场 slug、host、session、订单和结算编排，缩为选择策略版本、少量资金/
风险参数、启动、查看结果和停止。后端自动推导当前 BTC 五分钟市场并沿用 rotating public feed、
风控、PaperSimulationEngine、账本、恢复和官方结算。

策略 catalog 从 TypeScript/Python 双登记改为 `strategies/catalog.json` 单一登记源，两侧只加载或生成
各自运行视图；J/K 的 `2.0.0` Paper-ready 冻结版本也由该源内置，新数据根不再要求先手工保存版本。
生产顶栏移除数据模式选择；演示数据仅保留给无后端的开发/测试表面。

验证范围包括 TypeScript、Python 策略测试、前端组件测试、构建、Paper host 专项测试，以及桌面/
移动浏览器从 Runner 到策略竞技场的完整模拟。用户随后批准公开采集；限时实测连接了 Gamma、CLOB
和 Binance，自动发现市场并建立 2500 USDC 的 J 2.0.0 账本。实测同时修复了异步首快照等待、Binance
当前无 `T/E` 字段、供应商时钟微小超前、盘口事件洪峰和页面自动刷新问题。最终一次 35 秒运行接收
34 个一秒标准化快照且 host 无 gap/error；因从五分钟市场中段启动，策略按设计记录
`MISSED_SIGNAL_OPEN_ANCHOR` 并等待下一完整市场，未伪造决策或成交。该限时检查不证明 CLOB 连续性、
跨市场结算或盈利能力。

尚未完成的架构目标是跨运行时的单一策略实现：当前 J/K 回测仍走 Python `run_kj_paper`，Paper 仍走
TypeScript `KJPaperEngine`。本次统一了登记源、冻结参数、公共目标仓位合同和 golden 一致性检查，但
没有用“同一接口”字样掩盖两份执行实现；后续必须选定一个实现并让另一运行模式只更换数据源、时钟、
成交模型和结算来源。

用户要求常驻进程同步后，最终于 2026-07-22 23:48 Asia/Singapore 执行
`npm run release:candidate`。4273 重启到不可变 release `a764f29b125e-ab22c759bd49`（服务 MainPID
31366、监听进程 PID 31390）；当时正在运行的 4174 也已重启（服务 MainPID 31411、监听进程 PID
31423）。API 回读确认环境为 `staging-sim`、live trading 为 false、J 版本包含 `2.0.0`，4174 页面
探测返回当前 Vite 入口；4173 仍未运行。

同时新增 D-059 与运维检查项，并把规则固化到 `npm run release:candidate`：今后运行时代码改动必须在
同一任务内重启 4273 并回读实际版本；若 4174 当时正在运行，也必须重启并验证页面，但未运行时不
主动创建。文档、注释和不进入运行产物的测试改动例外，4173 仍由独立晋升流程控制。

## 2026-07-23 公开 Paper 与界面复验纠偏

真实候选最初无法启动公开 Paper 的直接原因有两层：CLOB/Binance WebSocket 在当前环境握手超时，以及
候选 systemd 服务没有继承 Node 的环境代理。候选刷新现在重建服务并安全传递现有代理变量，Web 后端
使用 `--use-env-proxy`；自动 Runner 内部固定为 Gamma、CLOB REST 和 Binance REST 每秒轮询，避免
REST 快照与迟到 WS 增量并发写入导致交叉盘口和基线丢失。该内部取舍不增加任何前端模式或步骤。

真实运行先从市场中段安全等待，再自动进入下一完整市场。最终稳定样本累计 191 个快照、跨 2 个市场，
host 为 0 gap / 0 error；策略产生 `NO_TRADE`、`EDGE_ACCEPTED`、风控 `REDUCED`、模拟成交和
`SLIPPAGE_LIMIT`。权威 J 账户记录 1 笔成交、1 个 outbox 链接，证明策略到 canonical Paper 账本可达。
期间修复了 Gamma 秒精度区间转 Paper 毫秒精度合同的问题；明确的 `GammaResolutionPending` 现在是
正常等待重试，不再把尚未关闭的市场误报为运行故障。所有公开 Runner 随后停止，最终 API 回读为
`STOPPED / DISCONNECTED`，`LIVE_TRADING_ENABLED=false`。

前端真实 1440×1000 浏览器验收确认字号、控件高度、信息层级与内容感知字段宽度已统一；策略工作室
默认显示 B0–B3 四个只读研究对照，主选择仅含 J、K、L V2，L V1 单列失败审计。回测历史和竞技场已
按持久化策略 ID/版本显示实际 J/K/L 身份，旧的运行名称仅作为单独历史标签。新增 D-060 固化“既有
资产先分类再改动”的规则，防止同一资产在隐藏、恢复和删除之间反复变化。最终候选为
`a764f29b125e-e42c03cf899f`，4273 与活动的 4174 均已重启验证。
