# 当前状态

更新时间：2026-07-22

本文件只回答“现在做到哪里、下一步是什么、当前能做什么”。历史过程、旧测试数字和逐次
提交记录不在这里维护；截至 2026-07-18 的完整旧状态已归档为
[当前状态历史快照](../archive/current-state/2026-07-18-current-state-snapshot.md)。

## 当前结论

- `polymarket-money` 是唯一主项目；旧 workbench、旧项目和开源引擎只读。
- 本地研究与 paper MVP 工程闭环已完成，结论为 `MVP_ENGINEERING_COMPLETE`。
- K/J 历史结果与少量公开 paper 结果只具描述性：J 的正值对压力和集中度不稳，K 的冻结
  历史结果为负；均未证明可持续盈利。
- L V1 历史门失败；L V2 仍是 research-only 候选，未进入实时 K/J 路径。
- K/J Paper 已把动态策略目标仓位与统一后端审查分开：审查净额化已有/在途仓位，并明确批准、缩小
  或拒绝及理由。当前只观察到最佳卖一和一档可见深度，不能把预估价格表述为多档 VWAP。
- 回测运行名称与说明由后端持久化并随结果/比较 DTO 返回；页面默认显示语义名称，ID 仅保留在技术
  详情。历史运行缺少该字段时明确标为未记录名称，不能反推谱系。
- Batch 4B-R2 以 `INCOMPLETE_EVIDENCE` 关闭且不重跑。公共 CLOB continuity 仍为
  `UNVERIFIED`。
- `paired-20260718-0900` campaign 已在预热前按用户要求永久中止；不得补跑或计入证据。
- 当前没有 shadow/live 准入，也没有可达的真实下单路径。
- 用户已把短期操作方式明确改为 Web；Tauri/Rust 暂停接线和验收，但代码保留供以后恢复。
  React 必须通过仅本机固定 Web API 访问 TypeScript/Python 后端，仍不得直接读取数据库或文件。
- 最新纠偏将目标目录简化为 `frontend/`、轻量 `src-tauri/`、模块化 `backend/` 和独立
  `strategies/`；不再把主要业务放入 Tauri，也不采用 `modules/typescript|python` 分层。
- 本地操作已采用最小双环境：不可变 stable release 在4173使用 `production-sim` 数据根，candidate
  release 在4273使用 `staging-sim` 数据根；4174仅为可选 Vite 热更新并固定代理到4273。环境身份、
  release ID 与数据根后缀不匹配时后端拒绝启动。开发分支只能生成测试 candidate；4173只接受
  干净 `main` checkout 构建、并在4273验证后晋升的明确 release。
- `npm run release:candidate` 现在是候选实测的唯一刷新入口：构建后只重启 4273，并以实际 API 回读
  release ID、`staging-sim` 和 `LIVE_TRADING_ENABLED=false`；随后固定验证两个“应告警、不应拒绝”的参数。
  4173 stable 不会被该命令重启。

## 当前 Batch

Batch 07 的目录纠偏已形成可构建状态：前端合同与测试位于 `frontend/`；`src-tauri/src` 只保留
轻量 app-status；原顶层 `execution/` 已归入 `backend/core/`，同时保留
`backend/{market-data,backtest,risk,storage,tests}` 的明确业务入口。`strategies/` 已包含 TS 合同、
K/J context/warmup，以及列明 B0-B3、J、K、L V1、L V2 的 Python 公共注册表、确定性实现和
专项测试；原 `research/polymarket_money/kj_paper.py` 只保留兼容导入。L V1/V2 的用法、修改规则、
冻结状态和历史测试证据已集中到 `strategies/README.md` 与 `strategies/TEST-RESULTS.md`。

前端工作台已完成本机 Web 后端接线：React/Vite 入口、9 个页面模块、共享布局/组件、SVG 图表、
响应式样式、框架无关 reducer、严格 workbench manifest 与只读数据源端口均位于 `frontend/`。
概览、实时、决策、策略、数据集、回测、回放、竞技场和健康页均通过 loopback 固定 Web command
访问同一后端应用服务。原 Tauri command 暂不再作为当前入口或验收对象。在
真实 DTO 不足时明确显示 unavailable。生产 `verified-local` 分支不再回退到 preview 数字；前端
不读取数据库、文件路径或原始数据。策略版本、数据集扫描、历史回测任务、结果/事件/资金曲线、
Paper Kill Switch 与 app-status 均由后端拥有。设计稿阶段曾按 1440×1000 同尺寸截图核对，并补齐
原稿中的高密度检查器、状态卡、运行排名、服务控制与事件流；正文和辅助字号也已上调。设计稿
`polymarket_btc5m_workbench_fusion_v3.html` 仍是独立参考文件，生产代码没有对它建立依赖。
预览模式仍只用于独立视觉测试并显式标记 `PREVIEW DATA`；Web 生产入口必须使用 `VERIFIED LOCAL`。
生产入口现已保留静态 React 资产的页面级演示能力：当本地只读数据加载失败，或在无命令桥且
工作台 DTO 完全为空时，自动显示醒目的 `DEMO DATA` 警示、失败原因和锁定的完整静态页面；顶栏
可在自动、真实数据和界面演示间切换。演示区使用 `inert` 和事件拦截，不能触发后端、Paper、
导出或持久化操作。当前仍是页面级切换；真实与演示模块在同一页面按字段混合是后续工作。
实时公共行情采集尚未取得本次启动批准，因此实时页面的 host 状态保持 STOPPED/NOT READY，
不会伪报 WebSocket、延迟或盘口健康；Paper 安全控制、会话与已持久化账本仍可查询。当前已实现具体 `PublicClobPaperMarketFeed`：精确 BTC 5m
slug 的 Gamma discovery、两腿 CLOB REST bootstrap、公开 CLOB market WebSocket、PING/PONG、
book/price_change 与 abort/断连；其网络/时钟/timer 可注入且构造不执行 I/O。caller-managed
`PaperMarketHost`、有界快照缓存、连接/缺口/错误健康状态，以及 Paper 会话启动、停止、恢复、
状态核对的固定 Web/CLI 命令。服务启动不会隐式联网，只有页面提交精确 slug 和当次明确批准后才
启动公开 feed。

长期运行基础由一个 Web 进程内的惰性 Node Paper host 持有；前端提供精确 slug 和显式公开联网
批准控件。公共 feed 已组合 Gamma/CLOB 与 Binance Spot
`bookTicker`，两源未同时连接或 Binance/CLOB 数据陈旧时不发布 ready 快照。Paper 会话现已提供
订单提交、撤单、重新报价、GTD 到期、手工 Paper 测试结算及订单/成交/仓位/结算/审计事件账本；
生产 Live 页已接入 V2 手续费证据、GTC/GTD/FAK/FOK、账本、模拟订单、撤单、改价、到期检查和
手工 Paper 测试结算，所有操作只经过 Web 后端。官方 Gamma 自动模拟结算使用有界重试、严格市场
身份绑定和 hash-linked outbox，能够恢复 J/K canonical session 的 pending 结算。

组合 feed 现已在同一 `ReceiveClock` 下生成完整 K/J point-in-time context，并由现有 K/J paper
engine 写入可恢复 journal。Live 页显示真实 runtime 状态、J/K 钱包和最近事件。回测分类事件、
资金曲线、回放、比较、系统健康和异常也已通过固定 Web 只读查询接口暴露。运行证据仓在仓外保存
有界 hash 链，记录连接、缺口、错误、快照年龄、延迟和结算失败；数据库未接入时明确报告
`unavailable/degraded`。数据集页支持后端只读归一化 CSV、JSON、NDJSON/JSONL，并发布为内容寻址、
不可变的统一历史事件；Parquet 尚未支持。

数据集、策略和回测三页已完成第一轮信息架构收口：页面默认视图按“当前选择/状态 → 主要操作 →
辅助信息 → 技术详情”排序；新增统一 12 列响应式表单栅格，短版本/金额/枚举不再机械占据半行或
整行，长数据集选择获得更宽空间。数据集页把可用版本置于首位并折叠添加操作，策略页展示后端
拥有的用途、研究状态、参数中文名/单位/说明和真实版本生成时间，回测页按策略、版本、数据集顺序
配置。新生成数据集使用 `normalized-dataset-manifest-v2`，名称、说明、来源、标签和发布时间由后端
拥有；展示元数据不参与内容哈希，旧 V1 继续兼容读取。数据集 DTO 已升至 V2，并兼容 V1 输入。
数据集、策略版本和终态回测任务均提供确认后删除；外部登记数据集只读，已有回测引用或运行中任务
会由后端拒绝删除。

策略目录现在同时展示 L V1（历史门失败、仅审计）与 L V2（研究候选、仅验证集回测），名称优先使用
业务语义而保留内部 ID 供技术详情追溯；策略工作室可加载全部已保存版本，并按上一版本显示逐参数差异。
实时页把最近真实 K/J 策略判断置于审计事件之前，展示概率、净优势、目标总仓位、已有/在途仓位、
预估价格/费用与风控调整；完整键值事件默认折叠。

## 下一步

1. 在取得当次明确联网批准后，做一次公开 Gamma/CLOB/Binance 的短时 Web Paper 集成验证；未批准前
   保持 STOPPED，当前只声明离线工程链通过。
2. 继续把 `strategies/src/python/kj_l.py` 中 paper 成交、组合和导出编排拆到 `backend/backtest`
   或 `backend/core`，纯 J/K/L 决策留在 `strategies/`；不得复制实现或修改冻结结果。
3. 继续消除 `strategies` 对 research/backend 具体 adapter/domain 路径的依赖，改用稳定策略 DTO。
4. 若要启动任何公开联网 paper/campaign，必须取得用户当次明确批准，并在启动前冻结窗口、
   配置、commit/hash 和完整 cohort 验收规则。
5. K/J 保持冻结，禁止用单场或 Final Test 结果反向调参；L 的后续研究须先补齐连续、
   point-in-time 的 CLOB quote 与可验证 Chainlink boundary 输入。
6. shadow/live 继续关闭，只有独立证据门和单独授权才能改变；Tauri 恢复另行安排。

## 当前硬边界

- `LIVE_TRADING_ENABLED=false`。
- 不读取凭据，不连接私有用户频道，不签名，不发送或撤销任何真实订单；Paper 模拟订单严格隔离。
- 不把 paper PnL、单场成功、旧测试通过或工程完成当作盈利、连续性或实盘证据。
- 不自动重跑被中止 campaign，不以降低门槛“补齐”不完整证据。

## 最近验证基线

- 2026-07-22 候选发布防陈旧：`npm run release:candidate` 已改为构建后只刷新 4273、回读实际
  `staging-sim` release ID、并验证 Paper-only 状态与参数告警回归。实际候选
  `e5375af912e6-5916f270efdc` 返回 J/K 空优势区间与 L V2 零最大信号优势均为
  `valid=true`、`errors=[]`，分别带 `EMPTY_EDGE_WINDOW` 和 `ZERO_SIGNAL_EDGE_GUARD` 红色告警；
  未重启 4173、未启动公网采集或真实交易。后端回环测试 `7/7`、前端 Vitest `25/25`、
  TypeScript build、前端 production build、`git diff --check` 通过。

- 2026-07-22 研究参数告警化：删除策略版本保存入口中任意的 `0.01` J/K 优势间隔和 L 的
  `maxSignalEdge=0.05` 最低硬门；空/过窄 J/K 优势区间、低/零 L 信号上限现在由后端返回红/橙研究
  告警，版本仍可保存和用于离线研究。字段类型、有限数值及真实 Paper 统一风控边界未放宽。`npm run
  typecheck`、前端 Vitest、后端策略/前端合同测试、Python 策略测试与 `git diff --check` 通过。

- 2026-07-22 回测谱系与历史决策解释补充：回测请求/任务/结果/竞技场比较增加后端拥有的名称与说明，
  缺失值由已注册策略、数据集和数据分组生成；回测实验室与策略竞技场均把 ID 收进技术详情。离线
  回测的公开决策 DTO 增补已记录的价格、费用、目标/当前仓位、深度参与和风险字段白名单，缺失字段
  保持缺失。`npm run typecheck`、前端 Vitest、`npm run build`、`npm run frontend:build`、编译后的
  backtest/strategy/KJ 单测和 `git diff --check` 通过；未启动公网采集或真实交易。

- 2026-07-22 决策与回放谱系层级补充：决策记录和市场回放的已完成运行选择器改用后端运行名称；
  所选运行名称置于查询上下文，运行 ID 收入可展开技术详情。决策账本主列改为格式化 UTC 时间、
  事件类型和原因/状态，字段检查器提供中文业务标签；`npm run frontend:test -- --run` `24/24`、
  `npm run typecheck`、前端 production build 与 `git diff --check` 通过。

- 2026-07-22 历史回测风险语义纠偏：历史回测公开 DTO 区分“策略意向数量/投入”与真正的目标仓位、
  统一风险审查和批准数量。缺少审查记录的旧 J/K/L 回测不再把意向数量冒充目标仓位；Paper engine
  的 `target-position-review-v1` 仍是当前唯一完整审查证据。适配器烟测、编译后 query/backtest 测试和
  Python 策略单测通过。

- 2026-07-22 公共事件展示语义：公共 UI 模块集中管理事件字段中文标签、事件主因和带 UTC 标记的事件
  时间格式；决策页已改用该单一来源，避免各页面各自解释相同 DTO 字段。完整前端 Vitest `24/24`、
  TypeScript 与前端 production build 通过。

- 2026-07-22 回放与健康页语义收口：市场回放事件表和检查器现在以 UTC 时间、事件原因/状态及中文业务
  字段为主，技术事件 ID 收入可展开详情；验证本地数据的健康页同样格式化快照/异常时间，并将异常 ID
  收入技术详情。完整 Node `258/258`（含工作台本机回环子集 `10/10`）、Python 策略 `10/10`、
  `npm run typecheck`、前端 Vitest `24/24`、`npm run frontend:build` 与 `git diff --check` 通过。
  Playwright 桌面/移动配置可列出 4 个用例；本轮运行停在 “Running 4 tests”，仅保留桌面总览和移动健康
  页截图，未产出最终通过/失败汇总，故不计为端到端验收。未启动公网采集或真实交易。

- 2026-07-22 回测与竞技场的标识层级补齐：已验证回测结果与竞技场比较用固定后端策略/数据集目录显示
  语义名称，技术策略 ID、数据集 ID 与事件 ID 均收进可展开详情；目录缺少旧对象时明确标记为“未记录
  名称”，不会从 ID 猜测含义。`npm run typecheck`、前端 Vitest `24/24`、production build 与
  `git diff --check` 通过。

- 2026-07-22 回放、竞技场与回测默认值修复：市场回放将事件流改为主栏独立滚动表格，当前事件
  检查器收窄并限制高度；竞技场比较显示选择数、进行态、完成态和后端拒绝原因。零成交胜率统一为
  “不可用”。策略工作室不再把参数下限当默认值：J/K 默认最小净优势 0.05、最大信号优势 0.25、
  单次最大投入 400、盘口参与比例 0.5；L V2 使用冻结候选配置并只开放受控覆盖。新版本号自动递增。
  新回测默认验证集并记录数据分组、时间跨度、场景、样本指纹和样本数；竞技场拒绝范围缺失或样本
  不一致的旧运行。真实历史数据离线诊断中，同一验证集 1,440 个样本已分别产生 J 159、K 189、
  L V2 46 次成交，证明订单到成交链恢复，但结果只作描述。前端测试 `24/24`、策略测试 `25/25`、
  全仓类型检查、生产构建和差异格式检查通过；全仓 Node 在受限环境中 `59/61`，仅两个本机端口测试
  文件受限，放开本机回环端口后其 15 个子项全部通过。已生成分支测试候选版本
  `aa58e9256d36-58bca03336e1`，但未经批准未重启 4273。未启动公网采集或真实交易。

- 2026-07-22 回测 candidate 打包修复：确认 4174 的 3 个失败任务均因 release 漏打包
  `contracts/raw-event-v1.schema.json`，并非数据或策略失败。candidate 构建现将整个 `contracts/`
  纳入 artifact 与指纹；新 candidate `aa58e9256d36-d75ba3a4f586` 完成 Python import 和同一 J 策略/
  数据集离线回测冒烟（1,279 个公开事件）。全仓 Node `255/255`、TypeScript 通过。现有 4273 未经
  批准没有重启，仍运行旧 candidate。

- 2026-07-22 数据语义与安全删除：全仓 Node `254/254`、前端 Vitest `23/23`、全仓 TypeScript、
  Vite production build 通过。4174 对应 staging-sim 已登记仓库外只读历史源，实时接口返回 2 个
  哈希验证版本（22,396 / 14,632 条）。未启动联网采集或真实交易；4273 仍为既有不可变 candidate，
  未擅自重启，新删除命令需获批重建/重启后才会在 4174 生效。

- 2026-07-22 前端信息架构与紧凑表单：全仓 Node `254/254`、前端 Vitest `23/23`、前端与全仓
  TypeScript、Vite production build、临时独立端口的 Playwright 桌面/移动 `4/4`、
  `git diff --check` 通过；人工检查策略、数据集、回测三页 1440×1000 截图。没有启动公网采集或
  真实交易路径；默认4174验收端口被既有进程占用，未终止该进程，改用临时4374完成同等验证。

- 2026-07-22 本地服务器模拟：全仓 Node `253/253`、前端 Vitest `23/23`、TypeScript typecheck、
  Vite production build 通过；candidate/stable 指向同一不可变 release，4273 staging、4174代理及
  独立4373 production-sim 验证通过。既有4173/4174工作区进程随后经用户批准终止；当前主题分支
  不能冒充干净main，因此4173保持停止，等待合并后构建并验证首个合规stable。未启动公网采集或
  真实交易路径。

- 2026-07-22 静态资产保护与锁定演示：全仓 Node `252/252`、前端 Vitest `23/23`、Playwright
  桌面/移动本机 Web server `4/4`、前端 TypeScript、Vite production build 和
  `git diff --check` 均通过；没有启动公网采集或真实交易路径。
- 2026-07-22 Web 工作台收口：全仓 Node `251/251`、前端 Vitest `22/22`、Playwright 本机真实
  Web server 桌面/移动 `4/4`、策略目录 Python unittest `9/9`，TypeScript typecheck、后端 build、
  Vite production build 和 `git diff --check` 均通过。公开联网未获当次批准，因此没有把离线测试
  冒充实时采集证据；Tauri/Rust 未纳入本轮验收。

- 2026-07-21 本地工作台纵向链：全仓 Node `205/205`、前端 Vitest `12/12`、前端 production build、
  Playwright 桌面/移动 production-bridge E2E `4/4`、Rust Tauri bridge `7/7`（`-D warnings`）及
  离线 `cargo build` 通过。临时只读历史数据副本完成
  真实端到端回测：任务 `succeeded`，返回 1,597 条决策/成交/结算事件与 160 个资金曲线点，
  DTO 无本地路径；Paper Kill Switch 跨独立 CLI 进程持久化/恢复冒烟通过。
  长期 IPC、caller-managed Paper host 与公开 feed 专项 Node 测试、策略目录 Python unittest `5/5` 通过。

- 2026-07-21 目录与策略注册纠偏验证：Python 策略注册表 `3/3`、Node `154/154`、TypeScript
  typecheck 通过；Rust Tauri bridge `5/5` 通过，并在 `RUSTFLAGS='-D warnings'` 下重新编译通过；
  `git diff --check` 通过。
- 2026-07-21 React 工作台验证：前端独立 TypeScript 检查通过，Vitest + jsdom 组件测试
  `2/2` 通过，Vite 8 production build 通过；Playwright Chromium 桌面/Pixel 7 E2E `4/4`
  通过，覆盖 8 个路由、console/page error 和 paper-only 票据，并完成桌面/移动截图检查；全仓
  Node 测试 `157/157` 通过。
- 2026-07-21 视觉校正复验：原稿与实现按 8 个页面、同一 1440×1000 viewport 截图对照；修正
  信息结构和小字号后重新通过 TypeScript、Vitest `2/2`、Vite production build、Playwright
  桌面/Pixel 7 `4/4` 与全仓 Node `157/157`，并人工检查总览、决策、回放、竞技场和移动健康页。
- 最近完整 MVP 工程审计：Node `146/146`、Python `200/200`、Ruff 与 TypeScript 通过
  （提交 `cfb6f64`）。
- 当前 `.venv` 不存在，系统 Python 3.14.4 未安装 pytest/ruff，因此本轮不能重新证明 Python
  测试；旧通过数只保留为历史基线。系统 `/usr/bin/rustc` 与 `/usr/bin/cargo` 为 1.93.1，
  shell 默认 rustup shim 未配置 toolchain。
- Ubuntu Rust 包未包含可直接调用的 rustfmt/clippy 组件；调用会落入未配置的 rustup shim。
  未经批准不下载 toolchain，当前以 `-D warnings` 编译和单元测试作为临时验证，不声称
  fmt/clippy 已通过。

具体结果必须进入 [报告索引](../../reports/REPORTS-INDEX.md)；长期取舍只进入
[长期决策](../decisions/DECISIONS.md)；未完成工作只进入 [Backlog](BACKLOG.md)。
