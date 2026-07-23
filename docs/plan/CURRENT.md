# 当前状态

2026-07-23 18:36 Asia/Singapore 已完成 L V2 的本地离线参数扫描：在数据版本
`a27d9d1bf4dc5276c7ae5b11abd64250b6e6dc17f01fd432ab0dc10e4425cafc` 的 1,440 条
VALIDATION 决策上，以固定 fee-v2、1 秒延迟、10,000 USDC 初始资金扫描 45 个
`maxSignalEdge × maxStakeUsdc × bookParticipation` 组合。原始净收益最高组合为
`0.20 / 400 / 1.00`；按至少 30 笔成交且净收益/最大回撤比最高，风险调整建议为
`0.20 / 200 / 0.25`。建议组合已固化为 L V2 `1.1.0`，真实运行
`bt-1784802951813-d8fd8cb7` 与 B0–B3 自动对照全部成功，结果为净收益 `179.4451`、
费用 `15.4755`、最大回撤 `60.8062`、37/1,440 成交、胜率 `83.78%`、Brier
`0.102712`。策略对比页已展示扫描口径、建议与代表性候选；1440px/390px 浏览器验收无页面级
横向溢出。候选 `5145bfa63c35-c2ac2a8f427f` 已加载到 4273，4174 同步重启；实际 API 回读为
`staging-sim`、`paper-only`、`LIVE_TRADING_ENABLED=false`。结论仅为同一 VALIDATION 上的
探索性选择；数据连续性仍为 UNVERIFIED，且剔除最佳两天后净收益为负，不构成独立样本盈利证据。

2026-07-23 18:16 Asia/Singapore 已纠正回测分析的证据层级：进入回测页会自动恢复当前会话或最近成功
运行，不再要求先从任务历史点击“选择”；单次结果首屏只保留决策总览、收益风险 KPI、累计 PnL/回撤
与单市场 PnL 分布，其余概率、执行、稳健性和原始事件默认折叠。原“参数敏感性”“市场状态热力图”
和“滚动前推验证”在没有对应实验数据时仅是空矩阵，现已删除；未生成的参数网格、连续窗口和执行压力
统一显示为紧凑证据缺口，不再伪装成图。效果比较进入后会自动组合当前 B0–B3 对照组与 J/K/L 每个
策略的最新真实运行，并继续由后端同数据、样本、费用、延迟、资金和仓位比较门拒绝不一致运行。当前
1,440 个验证样本的真实结果中，L V2 因处于 Pareto 集且验证收益、夏普同时为正，被标为下一轮优先
验证；K 因 Brier 略优继续保留为 Pareto 对照，J 被标为受其他候选支配。页面从后端策略版本读取并
展示真实冻结参数；每个策略目前只有一个真实配置，因此明确要求先扫描 L，且不生成参数热力图。
browser-harness 已在 1440px 和 390px 验证无页面级横向溢出、详情默认折叠、空热力图数量为 0；
候选 `5145bfa63c35-86fe52a08348` 已刷新并在 4273 复验。前端 Vitest `30/30`、TypeScript、
production build 与差异检查通过；全仓 Node 首轮 `262/263`，唯一 Paper host 时序项单文件复跑
`9/9` 通过，按偶发时序失败记录而不宣称首轮全绿。Paper 边界未变，`LIVE_TRADING_ENABLED=false`。

2026-07-23 15:41 Asia/Singapore 在上述研究流程基础上继续完成量化分析界面：后端回测结果现在从逐决策
`probability + outcome` 生成 Reliability Diagram、十档概率/Brier 分桶明细、Brier 分解、Rolling
Brier、概率直方图与样本覆盖，并从结算事件生成单市场 PnL 分布、VaR95/CVaR95；缺少逐样本证据时仍
明确不可用，不从汇总 Brier 反推曲线。效果比较增加同口径资金曲线、风险收益散点、零轴区分正负的
指标条、水下回撤时序、跨策略校准曲线与 Brier 分桶表。运行回放改为“按时间重建过程”，增加决策概率
轨迹和事件构成；决策账本改为“按事实类型审计证据”，增加类型总数、概率审计图和账本表，二者职责
已在页面首屏说明。效果比较的校准计算已统一按后端真实 `UP/DOWN` 大小写归一化，并由独立测试锁定
分桶实际率、Brier 与净盈亏正负零轴；`null`/空概率不再被 JavaScript 转成虚假的 0% 预测，B0 不会
生成伪校准证据。风险收益散点统一使用回撤绝对值，PnL 直方图按真实零点给柱着色；折线图坐标读数已
移出非等比 SVG，避免宽屏下文字被横向拉伸。2026-07-23 16:15 Asia/Singapore 已用实际浏览器连接
4273 对效果比较、回测、运行回放和决策账本逐页验收；桌面 1440px 与手机 390px 均无页面级横向
溢出，宽表只在自身容器滚动。期间发现手机端通用 250px 图表高度裁掉风险收益散点图后三个图例，
现已为散点图保留独立自适应高度并确认五个策略图例完整。实际点击“确认假设并运行回测”后，后端
成功生成主策略运行 `bt-1784794396386-de141e73` 及 B0–B3 自动对照，结果页自动出现概率质量、
累计 PnL/回撤和 PnL 分布图，证明该按钮不是静态空壳。前端 Vitest `28/28`、桌面/手机 Chromium
E2E `6/6`、TypeScript、生产构建和差异检查通过；候选已刷新为
`5145bfa63c35-ca0f033f7842`，4273 与 4174 均通过服务探测。
Paper 边界未变，`LIVE_TRADING_ENABLED=false`。

2026-07-23 15:24 Asia/Singapore 已将 Web 工作台重构为由 `ResearchSession` 串联的研究流程：
数据集、策略版本、执行假设、Run、比较集合与回放范围写入可分享 URL，刷新和跨能力页不再重复选择。
首页改为当前任务、下一步动作、证据脊柱与 Paper Gate；导航按任务职责分组，回测结果按决策总览、
概率质量、收益风险和执行诊断四层组织。共享 SVG 图表现使用真实 UTC/序号坐标，支持坐标轴、单位、
零线、直接标签、键盘/指针十字线和精确读数；回测增加资金曲线与回撤水下图，竞技场增加同时间口径
收益曲线、风险收益散点和对齐指标条。只有汇总 Brier 时仍明确显示校准证据缺口，不虚构概率分箱或
参数扫描。缺失指标仍显示 `not computed`，对照策略不再被误选为候选策略。数据页校验后直接绑定版本
并进入策略选择，结果页可携带冻结 Run 进入 Paper 评审；URL 同时保存费用、延迟、资金、仓位与比较
集合。启动失败改为有界等待、状态说明和重试，不再无限停留。最新 Web Interface Guidelines 审查
补齐统一可见焦点、帮助弹窗 Escape 关闭与焦点归还、动态状态播报、深浅色原生控件、触控与安全区、
减少动效、数字等宽，以及数据登记表单的明确名称、自动填充和操作标签；可选决策行改用真实按钮，
不再把整行伪装成交互控件。桌面/移动 Playwright `6/6`、前端 Vitest `26/26`、全仓 Node
`263/263`、Python 策略 `10/10`、TypeScript、前端生产构建和差异检查通过。最终候选已刷新为
`5145bfa63c35-79c6c78d668d`，4273 与 4174 可访问；4173 因当前主题分支
不具备 stable 晋升条件而保持停止。Paper Runner 保持停止，`LIVE_TRADING_ENABLED=false`。

2026-07-23 01:46 Asia/Singapore 已在实际 `staging-sim` 完成一次 J + B0–B3 自动对照：五个任务均
成功，严格比较门确认 1440 个验证样本、cohort hash、费用、延迟、资金和仓位假设一致。最终候选前后端
已重启到 release `a764f29b125e-bed184e7b42a`（4273 与 4174）；浏览器实测自动选中五个运行，首屏
判定为“本次未超过最强基线”。B0 的每个决策时点现在都保存不变现金余额，实际结果包含 1441 个
值为 1000 的资金点，竞技场可绘制水平现金基准线，不再因零交易误报资金曲线不可用。Paper Runner
保持停止，`LIVE_TRADING_ENABLED=false`。

## 2026-07-22 自动 Paper Runner 收口

2026-07-23 00:38 Asia/Singapore 已执行 `npm run release:candidate`：4273 与当时正在运行的 4174
均已重启到 release `a764f29b125e-e42c03cf899f`。实际 API 回读为 `staging-sim`、
`LIVE_TRADING_ENABLED=false`，Paper host 为 `STOPPED / DISCONNECTED`，没有遗留公开采集。
J、K、L V2 位于可编辑策略选择；B0–B3 不占用策略工作室，而由每次候选回测在后端自动生成同口径
对照组，策略竞技场自动选择最近一组并显示是否超过最强基线。L V1 单列历史门失败审计；回测历史与
竞技场使用持久化策略 ID/版本显示真实身份。

当前 Web 实时页已从手工 slug/联网复选、host、session、订单、改价、到期和手工结算编排，收敛为
“选择策略版本 → 设置资金和风险 → 启动/停止/紧急停止 → 查看决策与账本”。后端启动时自动推导
当前 BTC 五分钟 slug，现有 rotating feed 自动进入后续市场，并复用统一风控、PaperSimulationEngine、
账本、恢复和官方 Gamma 结算。内部标识只在折叠诊断区出现。

策略身份、展示元数据、实现版本、内置冻结版本、参数 Schema、允许模式和执行器键已集中到
`strategies/catalog.json`；TypeScript 与 Python 均从该文件加载。Tauri 已从当前架构主链删除，代码
仅保留为暂停资产。浏览器级确定性 E2E 覆盖启动 Runner、决策、成交/持仓展示和策略竞技场比较。
经用户批准的限时公开实测已连通 Gamma/CLOB/Binance，最终 35 秒样本形成 34 个一秒标准化快照且
host 无 gap/error；该次从市场中段启动，按设计等待下一完整市场，不能据此声称连续性、结算或盈利。

仍有一个明确未收口点：J/K 离线回测继续执行 Python `run_kj_paper`，实时 Paper 继续执行 TypeScript
`KJPaperEngine`。两侧现在共用 catalog、冻结版本参数、目标仓位语义和跨语言 golden，但还不是同一份
策略函数与同一条执行管线；`strategies/src/index.ts` 的新目标仓位合同尚未成为两侧唯一入口。不得把
当前状态表述为“回测与 Paper 已复用同一策略实现”。

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
- `npm run release:candidate` 现在是候选实测的唯一刷新入口：构建后重启 4273，并以实际 API 回读
  release ID、`staging-sim` 和 `LIVE_TRADING_ENABLED=false`；随后固定验证两个“应告警、不应拒绝”的
  参数。若 4174 开发前端当时正在运行，该入口也会重启并探测 4174；不会主动创建未运行的开发服务。
  4173 stable 不会被该命令重启。
- 从 D-059 起，任何影响 Web 前端、Web 后端、策略 catalog 或 Paper 运行链的改动，都必须在同一任务
  内执行上述候选刷新并回读实际 4273，同时重启当时正在运行的 4174；源码、构建产物或临时验收服务
  更新不再视为常驻进程已更新。
  仅文档、注释或不进入运行产物的测试改动例外。

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
公开行情由 Runner 内部组合 Gamma discovery、两腿 CLOB REST 与 Binance Spot REST `bookTicker`；
当前候选固定使用每秒公开 REST 快照，因为本机 WebSocket 握手不稳定，且 REST 快照与迟到的 WS 增量
并行写入会造成盘口基线竞争。两源未同时连接或数据陈旧时不发布 ready 快照。当前标准化策略输入固定
最多每秒一条。用户只点击启动；精确
slug、联网批准、host、session、手工订单和手工结算均不再是生产 Live 页步骤。停止会关闭 feed 并
停止本次 canonical session，同一 Web 进程可再次启动新 Runner；紧急停止同时启用 kill switch 和
关闭 feed。官方 Gamma 自动模拟结算继续使用有界重试、严格市场身份绑定和 hash-linked outbox。

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

B0–B3 已按 D-060 固定为长期保留、默认可见的只读对照资产，不再与不可运行的失败策略一起藏入折叠
诊断区，也不混入可编辑策略或 Paper 选择。任何既有资产今后必须先稳定分类为主流程、只读归档或确认
无调用后删除，禁止在隐藏、恢复和删除之间反复摆动。

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

- 2026-07-23 L 决策热路径与持久化背压修复：纯策略计算正式基准 20,000 个样本为 P50
  `0.3054 ms`、P95 `0.6282 ms`、最大 `10.5110 ms`，无需为语言原因改写 Rust。运行时新增独立
  `strategyComputation` 指标；此前实时 1,000 样本为 P50 约 `1.04 ms`、P95 约 `1.95 ms`，
  已满足 P50 ≤20 ms、P95 <50 ms。原行情→持久化决策队列曾随运行增长至 P50
  `7000.8 ms`、P95 `10661.996 ms`，根因是每个盘口串行等待 durable journal/checkpoint，而非
  策略计算。journal checkpoint 改为每 64 个 CONTEXT 批次落盘，非 CONTEXT 与关闭仍强制落盘；
  host 在拥堵时保留正在处理项与最新盘口，合并已过时的中间盘口，不再形成无界陈旧队列，前端显示
  合并计数。100 个同步盘口压力测试至少合并 98 个且最后盘口成功写入 journal；hash、幂等、风控与
  恢复校验未绕过。runtime evidence 的旧压缩链错误也已兼容修复，其他篡改继续拒绝。验证：
  Node `271/271`、前端 Vitest `30/30`、typecheck、Vite build、决策基准与
  `git diff --check` 通过；candidate `5145bfa63c35-30d85a251454` 已在 4273。当前环境对 Gamma、
  CLOB、Binance 三个公共端点均 8 秒超时，两次实时 Paper 启动均安全失败为 STOPPED，因此新候选
  尚无联网后的端到端延迟样本，不能把离线压力测试冒充实时验收。

- 2026-07-23 journal 耐久写分级：实时 Host 的普通 CONTEXT 改为追加到常开文件但不逐条
  `fsync`；出现可提交 FILL 时先 flush 当前 journal 尾，再写 durable PENDING outbox、调用
  canonical Paper，最后写 SUBMITTED。累计 64 条、关键非 CONTEXT 记录和关闭仍强制耐久化。
  8 轮同盘对照、每轮 60 个上下文：逐条耐久写平均 `240.060 ms`，批量追加后一次 flush 平均
  `193.884 ms`，总耗时下降约 `19.2%`。新增测试验证 buffered receipt 在 flush 前不是 durable、
  flush 后可恢复且不重复执行；Node `272/272`、前端 `30/30`、typecheck、production build 和
  diff check 通过。candidate `5145bfa63c35-47209465d39e` 的刷新命令在服务 smoke 阶段超时退出，
  但直接 API 回读确认 4273 实际运行该 release、`staging-sim`、paper-only、
  `liveTradingEnabled=false`，Paper host 为 STOPPED。

- 2026-07-23 outbox 热路径继续压缩：File outbox 在 coordinator 初始化时完成目录/文件安全检查并
  保持 `O_APPEND | O_NOFOLLOW` 句柄，Runner 停止时等待串行尾并关闭；第一笔及后续订单都不再于
  PENDING/SUBMITTED 时重复 mkdir、lstat、open、close。PENDING 和 SUBMITTED 仍分别 `fsync`，
  Paper 提交前的崩溃恢复屏障未削弱。8 轮、每轮 20 条本机机械写基准从“每条重开”平均
  `50.456 ms` 降至常开句柄 `18.339 ms`，下降约 `63.7%`。Node `272/272`、前端
  `30/30`、typecheck、production build 和 diff check 通过；4273 API 已确认 candidate
  `5145bfa63c35-fcc3f0324ba8`、paper-only、`liveTradingEnabled=false`、Paper STOPPED，
  发布命令仍因内置 smoke 超时返回非零。

- 2026-07-23 L V2 实时 Paper 接入：L V2 已通过既有 Paper engine 合同运行，K/J/L 的正式决策均由
  去重后的订单簿变动触发，不再使用固定 30 秒或 1 秒决策窗口；只有所选策略会执行。4273 的完整
  新市场在约 34 秒内产生 494 次 L 决策、3 个意图和 3 个 shadow fill。行情接收至决策完成的进程
  单调时钟延迟为 P50 `38.239 ms`、P95 `135.227 ms`、最大 `217.894 ms`（502 个样本）；
  意图至 canonical Paper 提交链完成为 P50 `1114.663 ms`、P95/最大 `1150.020 ms`（3 个样本）。
  3 个 canonical 订单均被 `STALE_OR_FUTURE_QUOTE` 风控拒绝，故本轮没有权威成交，也没有官方
  真实“锁单成功”样本。前端实时页已展示两段延迟和样本数。Node `269/269`、前端 Vitest
  `30/30`、TypeScript、Vite build 与 `git diff --check` 通过；candidate
  `5145bfa63c35-235f8a231e7d` 已运行，L Paper 已重新启动并保持 `LIVE_TRADING_ENABLED=false`。

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
