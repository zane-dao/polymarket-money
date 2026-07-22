# 2026-07-22 11:01 Asia/Singapore｜Fusion V3 静态资产保护与锁定演示

## 目标

保留 HTML 转 React 后的完整静态信息结构；真实数据尚未接入、为空或加载失败时仍能查看界面，
同时清楚区分演示数据并阻止任何演示交互进入后端。

## 事实与证据

- Fusion V3 HTML 仍在 `frontend/`，总览、实时、回测、竞技场和健康等静态 React 结构主要仍在
  页面 preview 分支；生产 `verified-local` 分支此前直接返回精简页面。
- 新增页面数据视图状态和顶栏选择器。空的无命令 DTO 或初始数据加载失败时自动显示演示；用户
  可以强制查看真实数据或界面演示。
- 演示区显示黄色 `DEMO DATA` 横幅、失败原因和固定水印，并以 `inert` 与捕获事件阻断整体锁定。
- 未启动联网采集，未读取凭据，未改变 `LIVE_TRADING_ENABLED=false`，未创建真实订单路径。
- 前端 TypeScript、Vite production build 和 `git diff --check` 通过；Vitest `23/23`、Playwright
  桌面/移动 `4/4`、全仓 Node `252/252` 通过。

## 决定

- D-050：静态页面是持续维护的产品资产；未接入功能保留、禁用并进入 Backlog。
- 演示数据只能用于布局和视觉检查，不能静默替代真实数据或参与任何研究/交易证据。

## 未决问题

- 当前切换粒度仍是整页；后续需要模块级 `REAL / DEMO / UNAVAILABLE / ERROR` 混合呈现。
- 决策筛选与导出、完整回测诊断、盘口回放、竞技场图表、健康控制和 Parquet 等真实接线见
  `docs/plan/BACKLOG.md`。

## 下一步

按 Backlog 逐模块恢复 Fusion V3 结构，在每个真实 DTO 接入后用桌面/移动截图和行为测试替换对应
演示模块；在证据不足时继续显示明确状态，不删除界面。
