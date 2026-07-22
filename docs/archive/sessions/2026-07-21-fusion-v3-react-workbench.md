# 2026-07-21 09:52 Asia/Singapore｜Fusion V3 React 工作台实现

## 目标

把 `frontend/polymarket_btc5m_workbench_fusion_v3.html` 的视觉与交互设计实现为低耦合、模块化
React 前端；设计稿保持只读参考，不启动采集、账户或交易能力。

## 事实与证据

- 当前仓原先只有 app-status 合同，没有 React 组件和 production build。
- 用户明确批准安装 React/Vite 与前端测试依赖。
- 生产源码检索不到设计稿文件名；预览数据位于独立模块并在页面持续标记。
- 独立前端类型检查、2/2 组件测试、Vite production build、localhost bundle smoke、Playwright
  桌面/移动 E2E 4/4 与全仓 157/157 Node 测试通过。

## 修改

- AI 项目层：更新 Batch 07 设计、当前状态、架构、长期决定、报告和本摘要。
- 代码层：新增 React/Vite 入口、8 个页面模块、共享 UI/SVG 图表、响应式样式、纯 reducer、
  strict manifest parser、只读数据源 port、预览 adapter 和测试。
- 外部状态：只安装 npm 项目依赖；没有启动联网采集、持久服务或交易行为。

## 验证

- `npx tsc -p frontend/tsconfig.app.json`：通过。
- `npm run frontend:test`：2/2 通过。
- `npm run frontend:build`：通过。
- 临时 localhost preview + `curl`：入口和 bundle 可读取，服务自动终止。
- `npm run frontend:e2e`：桌面与 Pixel 7 共 4/4 通过；截图检查通过。
- `npm run typecheck`：通过；`npm test`：157/157 通过。
- 用户指出第一轮还原不完整且部分文字过小后，按原稿与实现的 8 个路由分别生成 1440×1000
  同尺寸截图。对照结果显示概览结构、实时盘口/决策、策略编辑器、回测统计、决策检查器、回放
  侧栏、竞技场排名与系统服务控制存在缺项；本轮已逐页补齐，并把正文、导航、表格和辅助文字
  调整到更可读的字号。
- 视觉校正后再次通过 TypeScript、Vitest 2/2、Vite build、Playwright 桌面/Pixel 7 4/4 和
  全仓 Node 157/157；人工查看总览、决策、回放、竞技场与移动健康截图，没有发现横向溢出。
- 图表采用可测试的 React SVG 组件而非复制原稿 canvas 脚本，这是保留的实现差异；数据仍由
  独立 preview adapter 注入并明确标记，不能解释为真实行情或研究证据。

## 决定

- 设计稿只作规格；生产前端通过版本化 read-model 与可注入 port 解耦，记录为 D-044。

## 未决问题

- 真实本地产物尚未通过 Tauri/只读 adapter 接入；当前指标只能作为明确标记的 UI 预览。
- 用户已有两个 Python 文件存在 diff-check 行尾问题，本任务未触碰。

## 下一步

- 以 `WorkbenchDataSource` 为边界，先接入 app-status 和经过验证的 summary/diagnostics read-model，
  未就绪页面保持 unavailable。

## 13:44 后端接入续篇

- 预览实现已接入固定 Tauri → Node backend → Python 离线引擎链；新增策略版本、数据集、回测、
  决策/回放/比较、app-status 和 Paper Kill Switch 能力。
- 真实历史副本 E2E 返回 1,597 个事件和 160 个资金曲线点，且 DTO 不泄露数据路径。
- 实时采集没有启动；Live 生产页保持 unavailable，只暴露持久化 Paper Kill Switch。
- 全仓 Node 188/188、前端 6/6、Vite build、Playwright production-bridge E2E 4/4、Rust 5/5
  与离线 build 通过。

## 14:12 实时 Paper 主机与 L 策略整合

- 新增惰性、caller-managed 的 `PaperMarketHost`：只接受注入的公开只读 feed，保存有界快照，
  记录连接、缺口和错误健康状态；构造和测试均未联网。
- 新增具体 `PublicClobPaperMarketFeed`：按精确 BTC 5m slug 使用 Gamma 发现市场，以两腿 CLOB
  REST 盘口启动，再消费无认证 CLOB market WebSocket 的 book/price_change；网络、时钟与 timer
  均可注入，离线 fixture 覆盖订阅无 auth、PING/PONG、断连和 stop abort。
- CLI、Tauri 与 React 增加 Paper 会话 start/status/stop/resume。当前桌面短进程使用 unavailable
  adapter，因此未获批准或无长期 host 时明确拒绝启动，不回落到 Mock 行情。
- 按用户指定的 `web3-polymarket` Skill 核对后，未来 feed 仅使用无认证 Gamma/CLOB REST 与
  CLOB market WebSocket；user channel、凭据、钱包、签名和真实订单均不进入当前实现。
- L V1、L V2 的实现入口、注册身份、专项测试和历史证据索引集中到 `strategies/`；兼容模块不再
  作为新增实现位置。L V1 继续是 `RESEARCH_GATE_FAILED`，L V2 继续是离线候选。
- 当前验证：Node 195/195、前端 Vitest 8/8、Vite build、Rust 5/5 与离线 build、策略 Python
  unittest 5/5 通过。Playwright 首轮因实时页安全文案更新导致旧断言 2/4；修正过期断言后
  桌面/移动 production-bridge E2E 4/4 通过。

## 14:30 长期 Paper host、Binance 与模拟订单纵向链

- 新增惰性 `scripts/paper-market-host.ts`，固定 NDJSON request/response schema、闭合命令枚举、
  1 MiB 请求上限和无批准拒绝联网测试；同一进程保存 feed、session 和模拟账本状态。
- Rust/Tauri 新增唯一 child owner、requestId 校验、20 秒响应超时、16 MiB 响应上限和退出 kill；
  Paper session 命令在 host 存活时统一路由到它。修复原桥可通过环境变量执行任意目录同名脚本的
  问题，生产只接受 canonical 固定构建产物。
- 抽取并加固 Binance BTCUSDT bookTicker parser，校验 symbol、时钟、update ID、正数量和非交叉
  盘口；旧 live runtime 与新 feed 共用。新增惰性 Binance Spot feed和 CLOB+Binance 组合 feed，
  任一源断开或信号陈旧即 fail closed。
- Paper session facade、短 CLI、长期 IPC、Tauri 和 React 补齐订单详情、提交、撤单、重新报价、
  到期、手工 Paper 测试结算接口。Live verified 页面显示 host 状态、显式联网批准、后端账本、
  模拟订单票、撤单、改价、到期检查和结算，不访问数据库、文件或网络。
- 组合 feed 使用同一 ReceiveClock 形成 K/J PIT context，现有 K/J paper engine 通过 journal 恢复；
  Live 页面显示真实 runtime 状态、J/K 钱包与最近事件。该 strategy journal 与通用 Paper session
  账本尚未合并资金口径，当前明确分开展示。
- 新增回测 decisions/orders/fills/settlements/equity/replay、比较、健康和异常的只读查询 API，
  经 SHA-256 sidecar 校验、分页与字段白名单后由固定 CLI/Tauri command 暴露。
- 本节代码实现和测试均未启动公网；真实行情运行仍等待用户明确批准。
- 本轮最终回归：Node 205/205、前端 Vitest 12/12、Vite production build、Playwright 桌面/移动
  4/4、Rust 7/7（`-D warnings`）通过；L V1/V2 策略专项 Python 测试 5/5 通过。
