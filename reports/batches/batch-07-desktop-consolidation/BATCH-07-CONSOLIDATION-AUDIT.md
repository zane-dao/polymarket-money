# Batch 07 整合审计基线

审计时间：2026-07-21 08:02 Asia/Singapore

## 结论

主仓已有可信度较高的 TypeScript paper/数据运行链与 Python 研究链，不应为了目标目录一次性
重写。纠偏后，Tauri 只保留轻量桥接，业务后端与策略分别收敛；本轮只修复新建的半完成
文件并恢复验证，不搬现有业务代码。

## 精确范围与状态

| 来源 | 状态 | 证据与处置 |
|---|---|---|
| `/root/projects/polymarket-money` | 唯一写入主仓；分支 `architecture/tauri-consolidation-audit` | 开始检查时观察到用户未跟踪 `.obsidian/`；本批没有读写该目录 |
| `/mnt/d/polymarket-paper` | 只读知识工作区，不是可迁移代码仓 | 除 `start_api.py` 外未发现产品 manifest；入口硬编码 Windows 旧仓路径，只作历史定位 |
| `/root/projects/polymarket-trade-engine` | MIT、TypeScript/Bun + React/Vite，只读 | HEAD `eda6759323b1b4cdb3559ca97876436c8fc231fd`；4 个 tracked 文件有未提交修改，因此不把当前工作树视为可复现源码基线 |

早期归档审计中的 `/root/projects/olymarket-trade-engine` 是当时路径。归档不改写；当前文档
使用本次文件系统证实的新路径。

## 主仓模块职责

| 模块 | 负责 | 不负责 | 输入 → 输出 | 可独立测试/替换 |
|---|---|---|---|---|
| `research/polymarket_money` | 离线数据质量、PIT 回放、策略研究、回测与 Python ledger | 桌面 UI、真实执行、凭据 | manifest/fixture/config → receipt/report/events | 可测试；保留为 Python 模块 |
| `execution/src/domain` | Money、ReceiveStamp、raw/opportunity 类型与不变量 | 网络、文件、UI | 规范值 → domain value | 可测试；未来可逐类型移植 Rust |
| `execution/src/adapters` | 公共行情和官方 Gamma 结算适配 | 策略、UI、真实订单 | 公共 payload → domain snapshot/evidence | 可测试；暂留 TS |
| `execution/src/strategy` | K/J context、warmup 与确定性判断 | I/O、钱包、页面 | 显式市场输入 → strategy context/intent | 可测试；暂留 TS |
| `execution/src/runtime` | 观测、paper 生命周期、fee/edge 和 incident | 桌面呈现、真实账户 | context/config → observations/paper events | 可测试；暂留 TS |
| `execution/src/storage` | raw segment、hash-chain paper journal/replay | UI、真实 exchange truth | event → durable artifact/replayed state | 可测试；暂留 TS |
| `execution/src/product` | MVP、campaign、结算恢复与汇总报告 | 通用桌面 transport | validated artifacts → product report | 可测试；先由 DTO 包装 |
| `scripts` | 固定 CLI 组合与 localhost-only console | 可复用业务 domain、任意桌面 shell | argv/env → bounded workflow | 脚本薄厚不一；逐步收窄 |

## 参考引擎处置

| 能力 | 决定 | 原因 |
|---|---|---|
| React 分析页面布局/图表交互 | 仅参考交互 | 直接解析宽松日志、`any` 和 JS `number` 金额，不符合主仓合同 |
| `PriceLevelMap`/订单簿 fixture | 后续单独评估测试资产 | MIT 允许，但当前主仓已有更严格 staleness/identity/clock 合同 |
| lifecycle/user-channel/撤单竞态 | 迁移脱敏失败场景，不迁移 runtime | 早期审计已证明 finality、幂等、恢复和部分成交缺陷 |
| wallet/PnL/recovery/live gate | 废弃实现 | 不能成为 exchange/accounting truth，且当前任务保持无真实交易路径 |
| React/Vite 构建配置 | 不直接复制 | 版本和目录可参考，主仓需要 Tauri command 契约与自己的测试边界 |

## 可扩展性、耦合与测试风险

1. `scripts/mvp-console.ts` 同时承担 HTTP、进程启动、文件扫描和 HTML，不能直接成为 Tauri
   command；先抽只读 service/DTO。
2. 当前 `tsconfig.json` 把 execution、tests、scripts 编成一个 root，未来前端必须使用独立
   tsconfig，避免 DOM/Node 类型和运行时依赖互相泄漏。
3. Python package 仍位于 `research/`，移动前必须修复 setuptools package 映射和 CLI；不能
   只移动目录。
4. 新增 Rust 与 TS 的 Money 类型必须通过共享 golden 对拍，避免十进制舍入形成第二本账。
5. Tauri command 如果直接 spawn 现有脚本，会把路径、联网和副作用权限放大；第一批只做
   原生 Rust 只读状态，后续桥接必须固定命令和 schema。

## 测试与工具链证据

- `npm test`：147/147 通过。
- `npm run typecheck`：通过。
- `.venv/bin/python -m pytest -q`：未运行，`.venv/bin/python` 不存在。
- 系统 `python3`：3.14.4，未安装 pytest/ruff。
- 默认 `rustc/cargo`：rustup shim 无默认 toolchain；`/usr/bin/rustc` 与 `/usr/bin/cargo`
  均为 1.93.1，可用于后续离线 scaffold 检查。
- 本轮没有运行参考引擎测试：来源工作树有用户修改，且不得安装其 Bun/依赖或执行入口。

## 07B 半完成修改收口

- 前端合同从错误的顶层 `src/` 移到 `frontend/src/`，测试 import 与 tsconfig 同步修复。
- `src-tauri` Rust crate 尚未加入 Tauri/serde 外部依赖；crate 更名为 tauri bridge。
- 删除本轮新建的空 domain/service/adapter 层，收敛为 `app_status.rs` 与 `lib.rs`；功能保留，
  不在 Tauri 目录承载市场、策略、回测、风险、账本或执行业务。
- `domain::AppStatusV1` 只有 `paper_only` 构造入口，字段私有，`live_trading_enabled` 固定为
  `false`；页面或配置不能通过字段赋值打开 live。
- app-status 只依赖注入的 UTC clock、模块 probe 和数据根 probe；只暴露状态，不返回绝对
  路径或文件内容。
- UTC 时间使用固定秒级 ISO 8601 `Z` 合同，并覆盖 Unix epoch、闰日和非法日期测试。
- 收口后的最终测试结果见本报告末尾“纠偏验证结果”。
- 新增 `strategies/src/index.ts` 作为统一策略合同和注册表；旧 strategy index 成为兼容入口。
- 新增 `backend/market-data`、`risk`、`storage` 稳定入口，均复用现有唯一实现；新增
  `backend/backtest` 通过注册表调用策略，不接触 UI、Tauri、网络、数据库或下单逻辑。
- 新增 backend/strategies 专项测试，并把 frontend 测试放入 `frontend/tests/`。

## 当前风险与未决项

- 新 React/Tauri 依赖尚未安装；按仓库规则需先取得安装批准。
- 没有 Python venv，暂不能证明 Python 当前分支回归。
- Tauri 系统 WebKit 依赖是否仍完整需要在 07B 构建时验证。
- rustfmt/clippy 命令当前落入未配置的 rustup shim；本轮未安装组件，因此不能声称两项通过。
- 参考引擎的 4 个本地修改来源未知；保持只读，不纳入迁移 provenance。
- Rust 核心已创建并测试；React、Tauri command、serde DTO 和 Tauri build 仍未完成。

## 前端合同层

- `contracts/app-status-v1.schema.json` 固定 camelCase wire shape、paper-only 模式、
  `liveTradingEnabled=false` 和禁止额外字段。
- `frontend/src/types/app-status.ts` 对未知 command 输出做运行时解析，拒绝 live=true、额外字段、
  重复 module id、非法 UTC 和缺失 unavailable reason。
- `frontend/src/services/app-status.ts` 只允许调用固定的 `get_app_status_v1`，transport 可注入并离线测试。
- `data/fixtures/app-status-v1.golden.json` 是 Rust serde command 后续必须对拍的共享 fixture。
- Node 测试增加 3 项合同/安全负例，当前为 150/150；TypeScript typecheck 通过。

## 纠偏验证结果

- `npm run typecheck`：通过。
- `npm test`：154/154 通过；包含 frontend、backend 和 strategies 新目录专项测试。
- `npm run build` 先清理明确的生成目录 `dist/`，防止已移动测试的旧 JavaScript 继续被
  Node test glob 执行；纠偏时确实捕获并消除了这一陈旧产物失败。
- `PATH=/usr/bin:$PATH RUSTFLAGS='-D warnings' cargo test --manifest-path src-tauri/Cargo.toml`：
  5/5 通过；crate 为 `polymarket-money-tauri-bridge`。
- `git diff --check`：通过。
- 相对 Markdown 链接检查：通过；仓库自有 Markdown/MDX 没有重复文件名。
- Python：`.venv/bin/python` 不存在，系统 Python 3.14.4 也没有 pytest/ruff，本轮未复验。
- 07B 收口时 React/Tauri production build 尚无对应依赖、组件、Tauri 配置或 command；随后
  获得授权完成的 React 工作台证据见下方 07C，Tauri production build 仍未完成。
- 最终 `git status` 仍是当前主题分支的未提交任务变更；没有 commit、push、PR 或来源仓修改。

## 07C React 工作台实现证据

时间：2026-07-21 09:52 Asia/Singapore

- 安装 React 19、React DOM 19、Vite 8、React Vite 插件、类型与 jsdom/Testing Library/Vitest；
  `npm audit` 在安装时报告 0 漏洞。首次 Vite 7 与最新版插件的 peer 冲突被正常拒绝，随后改用
  匹配的 Vite 8/plugin 6，没有使用 `--force` 或 `--legacy-peer-deps`。
- `frontend/src/workbench/` 按 app、domain、ports、services、data、components、layout 和 pages
  分层；8 个页面均为独立模块，路由/选择/回放/对比状态由纯 reducer 管理。
- `rg` 在排除设计稿与 build 产物后未发现任何 `fusion_v3.html` 或设计稿文件名引用，证明生产
  源码不依赖设计文件。
- `npx tsc -p frontend/tsconfig.app.json`：通过。
- `npm run frontend:test`：1 个组件测试文件、2/2 测试通过；覆盖跨页面导航与 paper-only
  票据边界。框架无关合同继续由全仓 Node 测试覆盖。
- `npm run frontend:build`：Vite 8.1.5 production build 通过；32 modules transformed，JS
  222.87 kB（gzip 69.24 kB），CSS 13.52 kB（gzip 3.55 kB）。
- 临时 `vite preview` 仅绑定 `127.0.0.1:4174`，`curl` 成功读取入口和 222303-byte JS bundle，
  进程由 20 秒 timeout 自动终止，没有留下常驻服务。
- `npm run typecheck`：通过；`npm test`：157/157 通过。
- 用户后续授权浏览器环境后，安装 `@playwright/test`、Playwright Chromium/Headless Shell、
  `libnspr4`、`libnss3` 与文泉驿中文字体。官方 `install-deps` 曾因 Ubuntu 镜像上的可选日文字体
  包返回 502 而退出，随后按真实缺库信息安装最小运行库，没有掩盖失败。
- `npm run frontend:e2e`：桌面 Chromium 与 Pixel 7 两种 viewport 共 `4/4` 通过；两种尺寸均
  遍历 8 个页面且无 console/page error，并验证模拟票据没有 live action。首次移动测试发现侧栏
  footer 隐藏后安全状态不可见，已把 `PAPER ONLY · LIVE OFF` 固定到顶栏并由复测证明。
- 桌面总览和移动健康页截图已人工检查。首次截图暴露中文缺字方框，安装中文字体并刷新缓存后
  截图文字、布局、图表和响应式层级正常；截图保存在 `/tmp/polymarket-money-playwright/`，不入 Git。
- 第二轮按原稿与实现的全部 8 个页面生成 1440×1000 同尺寸截图并逐页比较，补齐总览、实时、
  决策、策略、回测、回放、竞技场与健康页缺失的信息结构，并上调正文、导航、表格和辅助字号。
  修正后重新通过前端 TypeScript、Vitest `2/2`、production build、桌面/Pixel 7 E2E `4/4` 与
  全仓 Node `157/157`；总览、决策、回放、竞技场和移动健康截图经人工查看无横向溢出。
- 全树 `git diff --check` 仍会报告用户已有的 `research/polymarket_money/kj_ewma.py` 与
  `kj_paper.py` 末尾空行，本任务未修改这两个文件，不能声称全树 diff check 通过。

## 07D 本地后端与桌面命令纵向接入证据

时间：2026-07-21 13:44 Asia/Singapore

- 新增严格 `workbench-view-v1`、策略注册/不可变版本、双位置 normalized 数据集扫描与 SHA 门禁、
  后台历史回测任务、查询/比较/回放 DTO、Paper 模拟执行、Paper 会话恢复和文件 Kill Switch。
- Tauri 注册固定策略、数据集、回测、app-status 和 Paper 安全命令；子进程使用固定 Node/CLI、
  清空环境、10 秒超时、16 MiB stdout 与 16 KiB stderr 上限，不接受 shell、SQL 或数据路径参数。
- 生产前端新增数据集页；策略和回测表单从后端加载真实注册项、不可变版本和验证后的数据集。
  verified-local 的总览、决策、回放、比较、健康和实时页只渲染 DTO，字段不足显示 unavailable。
- 临时目录 `/tmp/polymarket-workbench-e2e.fLQ2pR` 使用只读复制的真实已发布历史数据完成 E2E：
  `J_FEE_AWARE` 任务成功，1,597 个事件、160 个 equity 点，结果/工作台 DTO 均无 `/tmp/` 路径。
  该 PnL 只是工程冒烟，不构成盈利证据。
- Paper Kill Switch 在三个独立 CLI 调用间完成启用、恢复读取和解除，未启动网络或 Paper 会话。
- 验证：`npm test` 188/188、前端 Vitest 6/6、Vite production build、Playwright 桌面/移动
  production-bridge E2E 4/4、Rust 5/5（`-D warnings`）、离线 `cargo build` 均通过。回测成功后
  会重新拉取 workbench view，使总览、决策、回放和比较无需整页重载即可看到新结果。Python
  adapter 由系统 Python 对真实数据完成执行；完整 pytest/ruff
  仍因无 `.venv` 未复验。全树 diff-check 仍只有上述两个既有 Python EOF 空行问题。

## 07E 静态界面资产保护与演示隔离

时间：2026-07-22 11:01 Asia/Singapore

- 保留现有页面的 preview 分支并在生产工作台增加 `自动 / 真实数据 / 界面演示` 选择器；没有复制
  HTML，也没有删除真实命令页面。
- 本地 view DTO 加载失败时不再只留下启动错误页，而是显示失败原因、醒目的 `DEMO DATA` 横幅、
  固定水印和原静态 React 页面。
- 演示页面使用独立 `PREVIEW_WORKBENCH_DATA`，整区设置 `inert` 并在捕获阶段阻断点击；不会调用
  后端命令、Paper 账本、回测、导出或持久化。
- 未完成的真实功能已逐项登记到 `docs/plan/BACKLOG.md`；当前只完成资产展示与安全隔离，不声称
  各演示模块已经接入真实数据。
- 验证：前端 TypeScript 通过，Vitest `23/23`，Vite production build 通过，Playwright
  桌面/移动 `4/4`，全仓 Node `252/252`，`git diff --check` 通过。

# 2026-07-22 本地服务器模拟补充

- 4173/4273 分别固定为 stable/candidate 模拟环境；4174只作 Vite 热更新并代理到4273。
- `.local/releases/<releaseId>/` 保存不可变前端、后端和 Python 回测运行材料；Git 忽略该目录。
- `production-sim` 与 `staging-sim` 数据根由后端环境校验隔离，交叉配置测试为拒绝。
- 验证：`npm test` 为 `253/253`；前端 Vitest `23/23`；TypeScript typecheck 与 Vite build 通过。
- 运行冒烟：4273返回 `staging-sim` 和 candidate release；4174代理返回同一身份；为避开用户现有
  4173进程，在4373临时验证相同 stable release 返回 `production-sim` 后关闭。没有公网采集。
- 用户随后批准终止旧4173/4174工作区进程。promotion 与 production-sim 进一步限制为只接受干净
  main checkout 构建的release；当前主题分支不得冒充stable，4173保持停止等待合并后最终验证。
