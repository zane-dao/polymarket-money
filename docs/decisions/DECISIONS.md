# 长期决策记录

只记录已经明确、跨会话仍有效的决定。事实状态写入 `docs/plan/CURRENT.md`，历史过程写入
`docs/archive/sessions/`，工程细节写入本仓代码与工程文档。

## 最新决定（倒序）

所有决定均按最新在上的顺序排列。新增决定必须插入本节最上方，使用 `YYYY-MM-DD HH:MM 时区` 时间，并说明决定、原因、适用范围和例外。历史记录若缺少具体时刻，明确标注为“历史记录；具体时刻未记录”，不补造时间。

## D-056 研究参数的窄区间应告警而非任意拒绝

**时间：2026-07-22 21:30 Asia/Singapore**

`maxEdge - edgeThreshold < 0.01` 和 L 的 `maxSignalEdge < 0.05` 不是安全、数据完整性或
Paper 风控边界，不能作为保存研究版本的硬拒绝条件。后端继续校验字段类型、有限数值和真正的
执行风险边界；对于空/过窄的 J/K 优势区间，以及低/零的 L 信号上限，后端返回带严重度的研究告警，
前端只负责显示红/橙提示。警告不会替代真实 Paper 订单的统一风控审查，也不代表策略有效。

## D-055 回测名称是后端持久化谱系字段，ID 仅作技术追溯

**时间：2026-07-22 20:35 Asia/Singapore**

回测请求可携带有限长度的运行名称和说明；桌面后端会为缺失值基于已注册策略展示名、数据集与数据分组
生成名称，并将其连同不可变请求、结果和比较 DTO 持久化。页面默认显示该业务语义名称，运行 ID 与请求
ID 只在可展开技术详情中显示。旧结果没有名称时必须标注为“历史运行（未记录名称）”，不能根据 ID
猜测策略、样本或结论。

该字段只解释谱系，不改变回测比较门槛、策略版本、数据哈希或 Paper-only 边界。

## D-054 动态策略以目标总仓位表达，统一审查产出可解释订单差额

**时间：2026-07-22 20:30 Asia/Singapore**

策略先提出目标总仓位；执行层必须扣除已持仓与在途订单，再经同一纯后端审查处理可见深度、现金、
单笔、单市场和总敞口上限。审查只能明确 `APPROVED`、`REDUCED` 或 `REJECTED`，并返回原因、预估
价格、费用、保留金额和最终订单数量；不得把缩小后的仓位伪装成策略原始意图。

当前 K/J Paper context 只有最佳可执行卖一价及可见一档数量，因此展示为该档价格和深度上限，
不得声称已计算多档 VWAP。未来接入完整深度后可替换输入价格模型，目标仓位和审查合同保持不变。
这不改变 `LIVE_TRADING_ENABLED=false`、canonical Paper session 为权威执行账本的边界。

历史策略 ID 继续用于审计；新展示和新策略命名应使用“策略家族 + 方法 + 版本 + 研究状态”。L V1
必须可见但锁定为历史门失败，L V2 保持研究候选，不能以同一个“L”条目掩盖二者差异。

## D-053 回测比较必须绑定完全一致的评估样本集合

**时间：2026-07-22 20:00 Asia/Singapore**

工作台新回测默认使用验证集，并把数据分组、时间跨度、执行场景、样本指纹和样本数写入结果。
竞技场只有在这些字段以及数据集版本、手续费、延迟、初始资金和最大仓位全部一致时才允许比较；
缺少样本范围证据的旧结果必须重新运行，不得与新结果混排。

J、K 可选择验证集或最终测试集；L V2 只允许验证集。该约束用于避免把不同样本集合上的指标并列后
误判策略优劣，不改变冻结策略或允许依据最终测试结果反向调参。

## D-052 前端语义由后端合同拥有，技术身份默认渐进披露

**时间：2026-07-22 16:09 Asia/Singapore**

策略用途、研究状态和参数名称、单位、说明由后端注册表拥有，前端只消费严格 DTO，不另建平行策略
字典。页面默认按当前选择与状态、主要操作、辅助信息、技术详情排序；短字段与长选择器使用同一套
内容感知响应式栅格。审计所需的策略 ID、数据集 ID、版本哈希和原始合同不得删除，但默认折叠或
降为次要信息。

任何时间字段必须标明真实含义。策略版本生成时间使用已持久化的 `createdAtUtc`；数据集 manifest
没有可信生成时间时显示“未记录”，不得使用扫描时间、数据覆盖时间或文件修改时间代替。

## D-051 本地以 stable/candidate 双环境模拟服务器发布

**时间：2026-07-22 15:06 Asia/Singapore**

个人生产不引入多用户、容器或第三套部署环境。本地 4173 只运行已晋升的不可变 stable release，
写入 `production-sim`；4273 只运行 candidate release，写入 `staging-sim`。4174 仅是需要前端热
更新时临时使用的 Vite 工具，API 固定代理到 4273，不作为服务器环境或数据所有者。

开发分支可生成固定 candidate 供4273测试，但不能直接进入4173。合并后必须在干净 `main` checkout
生成最终 candidate，再由4273验证该精确产物；只有来源为干净 main commit 的 release 才能晋升。
环境身份、release ID 与数据根由后端校验并向前端显示；不匹配时拒绝启动。该决定只建立 paper-only
本地发布与回滚边界，不授予公开联网采集、shadow、真实凭据或真实交易权限。

## D-050 保留 Fusion V3 静态资产，缺数据时使用显式锁定演示

**时间：2026-07-22 11:01 Asia/Singapore**

Fusion V3 HTML 及已实现的 React 静态页面是产品设计和代码资产。真实数据接线不得通过删除页面、
模块或信息结构来处理未完成功能；未接入的交互应保留并禁用，随后逐项进入 Backlog。

真实数据为空或加载失败时允许使用独立演示数据保持页面完整，但必须持续显示醒目的 `DEMO DATA`
状态和失败原因，演示区整体不可交互，且不能进入回测、Paper 账本、导出、比较、持久化或任何后端
命令。用户可显式切换真实数据与界面演示。长期目标是模块级混合状态：有证据的模块显示真实数据，
其余模块显示 `DEMO/UNAVAILABLE/ERROR`，不得静默以演示数据替代真实数据。

## D-049 短期交互入口改为本机 Web，Tauri 延后处理

**时间：2026-07-22（用户明确决定；具体时刻未记录）**

短期内用户通过 Web 浏览器操作研究工作台。React 生产入口改走仅监听 loopback 的固定 Web API，
前端仍只消费严格、版本化、无路径 DTO，不得直接读取数据库、文件、原始数据或连接交易所。
Node/TypeScript/Python 后端继续拥有策略、数据集、回测、Paper、回放、健康和持久化能力。

Tauri/Rust 桥接代码暂时保留但不再作为当前功能接线、验收或阻塞项；D-045 与 D-047 中关于
固定命令、私有 host 和 fail-closed 的安全原则继续有效，但其“桌面为当前生产入口”的选择被
本决定暂停。以后恢复 Tauri 时，必须复用同一后端应用服务和 DTO，不能另建一套业务逻辑。
Web API 不得开放真实交易、钱包、签名、任意 SQL、任意 shell 或任意文件路径接口，
`LIVE_TRADING_ENABLED=false` 保持不变。

## D-048 自动 K/J runtime 与通用 Paper session 暂时分账展示

**时间：2026-07-21 14:46 Asia/Singapore**

组合公共 feed 在同一 `ReceiveClock` 下生成 K/J point-in-time context，并复用现有 K/J paper
engine 与可恢复 journal；通用 Paper session 继续负责人工模拟订单、部分成交、撤单、改价、
到期、仓位和结算。两者尚未建立统一资金协调协议，因此前端必须分开展示各自钱包和事件，
不得把两套余额、PnL 或成交相加后冒充统一账本。

后续整合必须先定义唯一资金真相、幂等键、事件归属和恢复顺序，并补跨 journal/session 的恢复
与回放测试；在此之前不复制第三套策略或执行引擎，也不改变 `LIVE_TRADING_ENABLED=false`。

## D-047 Tauri 持有唯一长期 Paper host，采用私有 stdio IPC

**时间：2026-07-21 14:30 Asia/Singapore**

实时行情、快照缓存和 Paper engine 需要跨前端命令保持进程内状态，因此不能继续用每次调用都退出
的 Node CLI 冒充实时宿主。桌面应用由 Rust/Tauri 持有一个固定 Node child，通过闭合命令枚举、
requestId 对应、输入/输出上限和超时的 stdin/stdout NDJSON 协议串行调用；应用退出、子进程异常、
响应超时或身份不匹配时终止 child。当前不创建 Unix socket，不提供外部或多客户端入口。

构造和 host-status 不执行网络。只有独立 start-public-feed 命令携带精确 BTC 5m slug 与显式联网
批准时才启动 Gamma/CLOB/Binance 公共 feed；session start 不能隐式启动 feed。Tauri 只执行仓内
canonical 的固定脚本，生产禁止任意 `POLYMARKET_BACKEND_CLI` override、URL、路径和环境注入。

## D-046 实时 Paper 只接公开无认证行情，主机生命周期由调用方显式管理

**时间：2026-07-21 14:12 Asia/Singapore**

实时 Paper 行情准备只允许公开无认证来源：Gamma 市场发现、CLOB REST 盘口和 CLOB market
WebSocket；market channel 订阅使用 asset/token IDs，并保留 PING/PONG、book、price_change、
tick_size_change、new_market 与 market_resolved 等公开事件的审计边界。当前不连接需要 API
credential 的 user channel，也不引入钱包、签名、builder、relayer、CTF 或真实订单提交。

`PaperMarketHost` 构造时不执行 I/O，只有调用方显式 start 才能启动注入的只读 feed；stop 后迟到
回调不得污染状态。桌面短命令进程不能冒充长期行情宿主，host 不可用时 start/resume 必须 fail
closed。即使未来保留真实交易 port，也必须与 Paper 实现物理隔离，并经过新的授权与阶段门。

## D-045 桌面前端只通过固定命令消费无路径 DTO

**时间：2026-07-21 13:44 Asia/Singapore**

生产 React renderer 不读取数据库、原始历史文件或绝对路径，也不接受任意 shell/SQL。Tauri 只调用
固定 allowlist 中的 Node 后端命令，并设置超时、stdout/stderr 上限和清空后的最小环境。策略版本、
数据集 manifest/SHA 验证、回测 worker、结果完整性、Paper 会话状态和 Kill Switch 均由后端拥有；
renderer 只解析严格、禁止额外字段的版本化 DTO。

历史回测使用现有 Python K/J/L 离线引擎，不复制第二套核算；任务状态和结果写在仓外 data root，
结果附 SHA-256 后才进入 `verified-local` read-model。实时公共数据 adapter 采用 caller-managed
生命周期；未经当次联网批准不得由桌面命令隐式启动。真实交易继续没有命令、凭据、钱包或签名路径。

## D-044 前端以设计稿为只读规格并通过数据端口解耦

**时间：2026-07-21 09:52 Asia/Singapore**

`frontend/polymarket_btc5m_workbench_fusion_v3.html` 只作为视觉和交互参考，React 生产实现不得
导入、读取、解析或在运行时嵌入该文件。工作台按 app shell、页面模块、共享组件、框架无关
domain/reducer、数据源 port 和 adapter 分层；页面只消费版本化 read-model，不直接访问文件、
数据库、网络、Tauri command 或后端具体实现。

在真实只读数据源完成前，界面可以使用独立预览 adapter 验证布局，但必须持续显式标记
`PREVIEW DATA`，不得把预览指标描述为真实行情、收益或研究证据。真实接入必须通过 schema、
新鲜度和来源校验；缺失数据应显示 unavailable，而不是静默回退成示例值。

## D-043 目录收敛采用 frontend/backend/strategies，Tauri 保持轻量

**时间：2026-07-21 08:51 Asia/Singapore**

用户纠正 D-042 中过度复杂的分层：目标顶层使用 `frontend/`、`src-tauri/`、`backend/`、
`strategies/`、`tests/`、`data/` 和 `docs/`。`src-tauri` 只承担配置、启动、系统能力和轻量
命令桥接；主要业务进入模块化 backend。策略必须是独立业务模块，以标准输入输出供回测、
paper 和后续执行共同调用，不得依赖 UI、Tauri、数据库实现、网络或下单逻辑。

本决定只修正目标目录与职责，不授权大规模搬迁。现有 `execution/`、`research/` 在逐项清点、
接口冻结和测试证明前保持原位；不为模板创建空目录。当前先修复半完成变更并恢复可构建状态。
D-042 中“Rust 承担主要后端”和 `modules/typescript|python` 目标路径由本决定取代；其主仓唯一、
渐进保留合格 TS/Python 和安全边界仍有效。

## D-042 主项目采用 Tauri + React + Rust，现有 TS/Python 通过接口渐进收敛

**时间：2026-07-21 08:02 Asia/Singapore**

**目录与职责已被 D-043 取代。** 本节只保留当时形成渐进迁移原则的历史背景。

用户明确指定 `polymarket-money` 为唯一主项目，桌面外壳采用 Tauri，前端采用 React +
TypeScript + TSX，新增主要后端与性能敏感能力优先使用 Rust。现有 TypeScript 执行/paper
内核和 Python 离线研究模块若功能完整、边界清楚且测试可用，则先保留并通过版本化 DTO、
Tauri command 和受控模块/子进程边界接入，不为了语言统一盲目重写。

参考项目保持只读，迁移前必须核对功能、依赖、测试、许可证和行为；不整体复制旧项目。
目录重排不得制造第二套策略、费用、账本、回放或产品入口。第一条纵向链先实现只读桌面
health/safety 状态，证明 React → Tauri → Rust 边界后再移动现有模块。该决定不改变
`LIVE_TRADING_ENABLED=false`、无凭据、无签名、无订单和联网采集需单独批准的边界。

## D-041 文档按唯一权威来源和全局唯一文档名治理

**时间：2026-07-20 20:42 Asia/Singapore**

项目文档采用确定性检索：`docs/INDEX.md` 是唯一阅读入口，`CURRENT.md` 只保存当前状态，
Batch 设计与报告分居 `docs/batches/` 和 `reports/batches/`，历史过程进入 `docs/archive/`。
仓库自有 Markdown/MDX 文档必须全局文件名唯一，只有 `docs/INDEX.md` 可名为 `INDEX.md`；
报告、Batch 和归档入口使用带职责的名称。Python `__init__.py`、TypeScript `index.ts`、
`.gitkeep` 等非文档语言/目录约定不属于此文档命名规则。

## D-040 决策与会话摘要采用最新在上的时间顺序

**时间：2026-07-20 15:00 Asia/Singapore**

用户明确决定：长期决策记录和会话摘要都采用“最新内容在最上方”的倒序写法，并为每项新增内容记录时间。决策正文保持跨会话规则、原因、适用范围与例外；会话摘要保持事实、证据、决定、未决问题与下一步。历史内容也按可追溯日期倒序整理；缺少具体时刻时明确标注，不补造时间。

## D-039 默认使用主题分支与 Pull Request 合并

**时间：2026-07-20（历史记录；具体时刻未记录）**

用户明确决定：后续对本仓的常规变更默认创建主题分支，完成本地验证后推送、创建 Pull Request，
并在检查通过且无冲突时合并到 `main`。这为改动提供可审阅、可追溯的记录；不得直接推送
`main`，除非用户在当次任务明确要求例外。PR 只能包含当前任务相关改动，合并前必须说明改动、
验证结果、目标分支和未决风险。

## D-038 不再维护仓外 review pack 副本

**时间：2026-07-20（历史记录；具体时刻未记录）**

早期 Batch 02、02.5、03A、03B 的仓外 `review-packs` 已逐份核对为主仓 Batch 文档、报告和
交接内容的重复摘要，且没有独有事实。因此删除该副本；后续交接、审阅与证据均以主仓
`docs/`、`reports/` 和 Git 历史为准，不再默认创建或维护仓外 review pack。

## D-037 后续策略在主仓统一研究

**时间：2026-07-20（历史记录；具体时刻未记录）**

用户明确决定不再为策略建立独立研究代码仓或工作副本。后续 L 或其他策略均在
`polymarket-money` 主仓中，以明确的模块、配置、预注册 artifact、测试和报告进行隔离；不得再创建
`polymarket-money-*-research` 类平行目录。该决定不改变 L V1 已被历史 gate 拒绝、只允许
TRAIN/VALIDATION、不得进入 shadow/live 的事实；任何新策略仍须遵守独立样本、固定验收规则与
当前安全边界。

## D-036 项目文档与代码收敛到主仓

**时间：2026-07-20（历史记录；具体时刻未记录）**

用户明确要求将原独立项目文档工作区并入 `/root/projects/polymarket-money`。本仓的
`docs/INDEX.md` 是唯一文档调度入口，`AGENTS.md` 是唯一 AI 工作规则；`CLAUDE.md` 只指向
前者，不维护第二套规则。`docs/plan/CURRENT.md`、`docs/decisions/DECISIONS.md`、
`docs/goals/PROJECT-GOALS.md` 和 `docs/architecture/ARCHITECTURE.md` 分别承担当前状态、长期
决定、总目标和当前架构的唯一权威职责。

批次计划/设计保留在 `docs/batches/`，测试与执行结论保留在 `reports/batches/`；提炼历史会话
和被替代的工程文档在 `docs/archive/`。原工作区在迁移验证后删除，不能再作为独立事实来源。

## D-035 重启 public paper 前先冻结有限协议，禁止以运行结果选参数

**时间：2026-07-18（历史记录；具体时刻未记录）**

MVP 验收后可恢复 public paper 测试，但每轮必须先有具体问题、固定策略/来源/窗口/验收规则，并取得
当次用户联网批准。当前冻结的下一轮协议为 4 个不重叠 paired run、每轮 3 个目标市场、Binance 与
Chainlink 独立腿、180 秒 journaled warmup、600 秒结算宽限；任何漏窗或失败轮为
`INCOMPLETE_EVIDENCE`，不平移、补跑或进入完整 cohort。L V2 继续仅限离线研究。协议正文位于
代码仓 `docs/batches/batch-06-kj-paper/next-controlled-paper-protocol.md`。

同一 campaign launcher 必须先取得持久化、原子 `O_EXCL` claim；claim 已存在时一律拒绝，不因
结果文件缺失、进程崩溃或重启而释放。这个 fail-closed 规则防止两个 launcher 竞争同一计划，或把
已错过的预注册窗口替换成事后运行。

## D-034 MVP 产品操作面优先于连续实时策略测试

**时间：2026-07-18（历史记录；具体时刻未记录）**

持续 public paper 的作用是未来检验预先冻结的假设，不是当前 MVP 的前置或替代品。用户已明确
要求先实现可操作的产品环境：统一的策略回测入口、受控的实时 paper、导出/可视化和安全边界；
只有当这些能力完成且存在具体待检验假设时，才启动有限、可验收的采集。不得自动串联 campaign
或以“不断积累样本”为由延后 MVP。`0965be5` 的 localhost-only `mvp:console` 是该操作面的
第一层：仅显示明确可复制的命令和安全状态，不能发起网络、paper 或订单。

## D-033 L V1 亏损先归因、保留候选，而非删除或用 Final Test 调参

**时间：2026-07-18（历史记录；具体时刻未记录）**

2026-07-18 对冻结 r3 artifact 的重算显示：Validation net PnL `-1287.046169895371064543169651`
中，gross PnL 已为 `-1123.455321415232349157732573`，fee 仅 `163.5908484801387153854370784`；
因此主因不是单独费率或波动拖累。虽然 filled win rate 为约 66.9%，但选中 outcome 的极端价格段
发生赔率/概率校准失效：80¢ 以上 184 fills、gross `-487.21`，20¢ 以下 73 fills、gross `-564.41`；
2--5pp edge-surplus bucket 也为 gross `-652.47`。UP、DOWN 两侧均负，五个 validation 日均负，
说明不是单边偏置或一个偶发日。L 保持为候选策略；下一步先记录这些分层，再用新的连续 quote/basis
输入和预注册方案验证校准假设，不删除策略、不以 Final Test 或事后系数搜索“修正”它。

## D-032 双信号长期证据必须以一个 paired campaign artifact 预注册

**时间：2026-07-18（历史记录；具体时刻未记录）**

单一来源的 `kj-paper-campaign-v1` 不能证明 Binance/Chainlink 的每轮结果是同窗口、同 commit
的一对，也不能阻止事后把各自独立运行拼成有利比较。`55cb52c` 新增
`kj-signal-compare-campaign-artifact-v1`：同一 SHA-256 artifact 同时固定两份 source campaign
和每轮 compare plan/source run mapping；launcher 只能在每轮目标边界前 210 秒按原 index 启动，
错过即失败，不重排、不补跑。每条腿仍以独立 v3 journal、钱包和 Gamma 结算执行。该约束只保证
样本选择/来源归因，不构成 alpha、盈利、shadow 或 live 证据。

## D-031 正式预热样本必须在 RUN_PLAN 中 hash-bind warmup 参数

**时间：2026-07-18（历史记录；具体时刻未记录）**

`9318a2f` 引入 `kj-paper-run-plan-v3`：在任何 `WARMUP_SIGNAL` 前，journal 必须同时
hash-bind `warmupSeconds`、窗口、commit 和（如适用）campaign binding。报告只在 v3 计划与
durable warmup count/span/source family 都一致时，才把预热视为预注册事实。早期 v1/v2 journal
即使能重放出实际 warmup 信号，也只能用于诊断，不得进入正式 paired/campaign evidence。

## D-030 K 预热只能使用独立的 journaled 信号输入

**时间：2026-07-18（历史记录；具体时刻未记录）**

K 的 180 秒 EWMA 预热由 `c6c86ac` 的 `WARMUP_SIGNAL` 完成：启动计划须预留完整 180 秒，
记录必须随 journal fsync/hash-chain 并在 replay 时只更新波动状态。它没有 market identity、
book、intent、wallet、position 或 Gamma settlement 语义；engine 在首个 market session 后拒绝
warmup，journal 也拒绝 Binance/Chainlink source-family 变化。任何旧的“以计划前市场 session
预热”的运行都仍只是诊断，不能追认为使用该合同的样本。

## D-029 报告必须显式披露有限十进制的 PnL 尾差

**时间：2026-07-18（历史记录；具体时刻未记录）**

逐市场的 `Money` 累加与最终钱包的逐事件计算可能因有限十进制精度、运算结合顺序产生极小
尾差。`paper:report` 只能在绝对尾差不超过 `1e-60`、且 accepted result 的 final cash/net PnL
仍严格匹配钱包时接受，并必须导出 `pnlReconciliationResidual`；超过阈值或结果不一致一律拒绝。
这不是放宽会计身份校验，也不改变任何 paper 结果的描述性性质。

## D-028 配对信号样本必须排除预热市场

**时间：2026-07-18（历史记录；具体时刻未记录）**

2026-07-18 的首轮 Binance/Chainlink 同窗口三市场运行发现：进程在计划首个完整市场前为
EWMA 预热而发现的前一市场，被 runtime 错误登记为 engine 的结算候选。两条腿虽均通过
原有 target-window 验收，但 engine 总市场数为 4 而计划目标为 3。该轮只保留为可复放的
诊断性比较，不进入正式 paired evidence 或策略盈利判断。后续 K/J MVP 必须把
`firstFullMarketStart` 显式传给 runtime；任何早于此边界的市场不得建立策略 session、写入
journal context 或加入 Gamma settlement candidates。干净重跑前仍维持
`profitabilityClaimEligible=false` 和 `LIVE_TRADING_ENABLED=false`。

## D-027 正式 J/K paper campaign 必须完整预注册并完整汇总

**时间：2026-07-18（历史记录；具体时刻未记录）**

后续希望作为独立样本比较或长期积累的 J/K public paper 运行，必须先用离线
`paper:campaign-plan` 固定 campaign ID、当前 collector commit、所有五分钟半开窗口、每轮
目标市场数、间隔和结算宽限，生成 canonical SHA-256 campaign hash。每一轮只能在下一完整
五分钟边界以相同 commit 通过 `paper:mvp -- --campaign-plan ... --campaign-run N` 启动；其
`kj-paper-run-plan-v2` 必须在任何 context 前进入 journal 哈希链。只有
`paper:campaign-cohort-report` 且准确包含计划内每轮一次、并核对 hash/index/window/count/commit
的结果，才能称为完整 campaign 描述性样本。旧 run 和一般 `paper:cohort-report` 仍可用于
诊断，但不能追认成完整 campaign，也持续 `profitabilityClaimEligible=false`。运行质量必须由
`paper:campaign-cohort-observability-report` 对完全相同的全计划输入重放；不得用不同的事后
子集分别呈现 PnL 与稳定性。

## D-026 paper PnL 与运行质量必须分别聚合

**时间：2026-07-18（历史记录；具体时刻未记录）**

`paper:cohort-report` 保持只核验/汇总已经完成的报告与 PnL 分布；公共流重连、quarantine、
Gamma 官方结算等待和 J/K intent/fill/no-fill/partial 分布由独立的
`paper:cohort-observability-report` 重放 runtime summary 与 journal 后产生。两层都只接受
非重叠 `HASH_CHAINED` 描述性报告，并永久保留 `profitabilityClaimEligible=false`。运行质量
计数不用于补强 alpha、参数选择或把理论 fill 说成交易所成交；它只为后续预绑定 paper
样本提供可审计的可靠性/执行风险维度。

## D-025 Chainlink relay 预估不等于官方结算

**时间：2026-07-18（历史记录；具体时刻未记录）**

当前 RTDS `chainlink` 只是在 runtime 中观察到的 relay，尚未证明等于每个市场在精确开/收边界
使用的 canonical Chainlink 值。因此任何未来推断只能名为
`PRELIMINARY_RELAY_OBSERVED`，并独立持久化/重放；它不能释放 reservation、修改 wallet/PnL、
调用 `settle()` 或令市场 `DONE`。Gamma/UMA resolved 的原始官方响应持续是唯一正式结算路径。
实现前必须重新核对当时市场规则和公共 stream 协议，并把边界选择/可见性规则版本化。

2026-07-18 的公开官方复核确认：BTC 五分钟市场规则确实指定 Chainlink BTC/USD stream，RTDS
也公开提供 `crypto_prices_chainlink` 的 `btc/usd` 时间戳/数值。这足以将其保留为低延迟信号和
预估/一致性观测输入；但官方页面同时提示 live data 可能延迟，且没有把 RTDS frame 定义为单场
边界的 canonical settlement record。因此结算边界不变，不能称“100% 准确”。权威链接与完整
理由记录在代码仓 `docs/batches/batch-06-kj-paper/chainlink-provisional-settlement.md`。

## D-024 L adaptive 保持为独立研究策略，不自动混入 K/J runtime

**时间：2026-07-17（历史记录；具体时刻未记录）**

**已被 D-037 取代。** 本节保留 L V1 的历史隔离原因与验收边界；后续策略研究不再通过独立代码仓或工作副本隔离。

`L_ADAPTIVE_EXECUTION` 不复用或修改已冻结的 J/K runtime、journal、MVP report/cohort 契约。
它在 Python 历史侧单独版本化，采用无绝对 base edge 的拆项执行门槛、平滑波动/概率拖累和
动态 anchor band；CLI、专用 API 和通用 runner 都只允许 TRAIN/VALIDATION，拒绝 Final Test。
V1 的冻结独立验证为负，故它不自动混入当前 K/J real-time paper、shadow 或 live 路径；策略本身
保留、可复现并继续接受原因归因与后继预注册研究。未来 V2 不得用这个短样本反复扫系数；须先补齐
连续 CLOB quote velocity 与 point-in-time Chainlink boundary evidence，再预注册候选网格、只在
TRAIN 选择一次并进行一次 Validation。

## D-023 公开 paper MVP 以原始官方结算证据闭环

**时间：2026-07-17（历史记录；具体时刻未记录）**

`polymarket-money` 的第一版产品入口固定为有界 `paper:mvp`：只使用公开行情、独立模拟钱包
和仓外 durable journal，不连接账户、User Channel 或订单路径。结算必须保存并重放验证
Gamma 原始响应，只有 market/token/time identity、closed/status 和唯一 1/0 winner 全部一致
才进入 DONE；延迟结果通过冻结半开目标窗口的 `paper:settle` 恢复，不从末价猜 winner。
计划的 run ID、目标数量/半开窗口和 collector commit 必须在首个 context 前进入 journal
哈希链；`paper:report` 只能从 replay 验证后的结算/PnL 生成描述性结果，旧的未绑定计划必须
显式标 `LEGACY_UNBOUND`。单场 `accepted=true` 只证明产品闭环，不改变历史 Final Test，
也不授权 shadow/live。延迟官方结果只能先追加原始证据，再由与初始运行相同的验收器生成
`RECOVERED_FINAL`；恢复不得绕过 clean exit、runtime safety、计划绑定或 pending-risk 门禁。

## D-022 polymarket-money 成为唯一主项目并以证据重建 K/J

**时间：2026-07-17（历史记录；具体时刻未记录）**

最新目标取代 D-021 的产品主体选择：`/root/projects/polymarket-money` 是后续研究、paper
simulation 和未来产品能力的唯一主项目；workbench、hello-world 和开源引擎只读参考，
不得继续形成平行产品真相。K/J 先以 clean-room 纯函数接入可信历史 receipt、Decimal
paper 账本和可审计导出。规范化官方 1 秒 close 可生成 point-in-time 5 秒 EWMA，但缺旧
逐笔流、K USD 换算或 legacy phase 时只能标规范化 fidelity，不得称 Strict legacy
equivalence；BASE 微正但压力转负或盈利集中同样不构成候选，不反向调参，不进入
shadow/live。

## D-021 Batch 5P 以旧产品为唯一 UI 主体

**时间：2026-07-17（历史记录；具体时刻未记录）**

**已被 D-022 取代。** 本节只保留当时的产品路线决定用于追溯。

日常研究工作台以 Linux-native `/root/projects/polymarket-paper-workbench` 为产品主体；旧
Tauri/React/Python/K/J 保持 Legacy 行为，`polymarket-money` 只作为未来 Strict 可调用可信
内核，`olymarket-trade-engine` 仅适配经审查的工程模式。不得建立第四套完整产品、第二套
WebSocket/订单簿/账本，或把 Legacy PnL 当 Strict 收益证据。Workbench safe mode 必须使
auth、账户、签名、订单、watchdog 与配置写路径不可达；公开监控只标 `MONITOR_ONLY`。

## D-020 Batch 4B-R2 不完整观测不重跑

**时间：2026-07-16（历史记录；具体时刻未记录）**

Batch 4B-R2 冻结配置未改，但 24 个 observed markets 中只有 15 个满足完整覆盖门，且运行以
terminal failure 结束，唯一结论为 `INCOMPLETE_EVIDENCE`。用户明确决定不重跑；不得降低
285 秒/15 秒/1 秒门槛，不得创建 R2/4B 验收 tag，也不得把运行后 graceful-degradation 整改
写成长期观测已经通过。路线保持 NOT_OBSERVED/DATA_INSUFFICIENT/
REQUIRES_PRIVATE_FILL_EVIDENCE，不进入 shadow/live。

## D-019 Batch 4B-R1 合同通过不等于观测通过

**时间：2026-07-16（历史记录；具体时刻未记录）**

Batch 4B-R1 的 `PASS_WITH_NONBLOCKING_EVIDENCE_DEBT` 只验收 ReceiveStamp/raw-v2、incident、
fee/edge、Opportunity/Route 与 lead-lag 因果合同。它不补做也不追认 24 市场/150 分钟观测，
不创建 4A/4B 验收 tag，不授权训练、shadow/live、User Channel、凭据、签名或订单。后续若
重跑观测，必须另开批次并重新创建预注册配置；CLOB continuity 仍为 `UNVERIFIED`，精确 fee
tie 仍以 `ROUNDING_TIE_UNVERIFIED` 失败关闭。

## D-018 Batch 3B 弱信号不进入 shadow

**时间：2026-07-16（历史记录；具体时刻未记录）**

Batch 3B 的 headline 只使用 PRIMARY_V2、官方 resolution、官方静态手续费、PLUS_1S 可见性、
BASE_1S 与 +1 tick 压力。B3/30 只在 BASE 小幅为正，压力转负、bootstrap 区间跨 0 且盈利
集中，因此固定为 `WEAK_RESEARCH_SIGNAL`，不进入 shadow。后续若研究 GARCH、漂移或风险
模型，必须使用新预注册和新实验版本，不得覆盖本次 immutable Final Test。

## D-017 Batch 3A 只验证内核，不证明真实净收益

**时间：2026-07-16（历史记录；具体时刻未记录）**

Batch 3A 的人工 fee 是确定性测试 fixture，不是历史费率证据；即使数值毛收益、手续费与
净收益可复算，也必须标为 `COMPLETE_FEE_UNVERIFIED`。只有 published/hash-pinned normalized
输入、所有成交市场完成结算且每笔 fee 有历史证据时，才允许 `net_pnl_verified=true`。
3A 完成不自动授权 3B。

## D-016 Windows 默认只交付单一 HANDOFF（取代旧双包规则）

**时间：2026-07-15（历史记录；具体时刻未记录）**

每批完成后，AI 不等待用户提醒，默认只把 `HANDOFF-BATCH-XX.md` 放到
`D:\polypolycache`，不自动复制 docs、reports 或完整审阅包。项目外 Linux 审阅目录仍按
D-013 只保存统一 HANDOFF。只有用户明确要求时才额外生成支持文档包；任何外交付都不得
包含源码、raw、真实 manifest、凭据、数据库、日志或大文件，复制后必须验证一致性。

## D-015 Point-in-time normalized dataset 真相

**时间：2026-07-15（历史记录；具体时刻未记录）**

Normalized 层只接受 manifest-verified raw；历史查询以 `visible_at <= decision_time` 为主门禁，
future source time 额外拒绝，禁止 backward fill、双向插值和事后回写。Direct/dependency lineage
必须绑定 manifest SHA 与 raw persist/segment/line/message 顺序；跨 manifest 无可靠全序时失败
关闭。任一 sibling token stale、空侧、crossed、歧义或 quarantine 都使整个 market 不可执行，
空侧 midpoint 必须为 null。Canonical dataset 使用 Linux-native filesystem、single writer、
content-addressed no-overwrite 发布；DrvFS 不支持。Binance 默认 BTC-only，all-symbol fallback
必须显式开启并记录；长期 reconnect supervisor 留到单独 Batch 2B。

## D-014 Raw 数据真相与连续性

**时间：2026-07-15（历史记录；具体时刻未记录）**

TypeScript 拥有公共 I/O 边界、最早 receive time 和不可变 raw 落盘；Python 只从完整验证
的 manifest/bytes 做合同验证、质量和离线回放。官方无 sequence/cursor 时必须持续标记
`continuity=UNVERIFIED`，不能把“保存收到的事件”写成“证明上游无丢包”。

## D-013 批次文档与外部审阅包分层

**时间：2026-07-15（历史记录；具体时刻未记录）**

从 Batch 2 起，设计/结果放代码仓 `docs/batches/batch-XX-topic/`，测试/Git/环境/验证证据放
`reports/batches/batch-XX/`。原项目外 `review-packs` 已在 D-038 删除；
统一 `HANDOFF-BATCH-XX.md`，不复制源码、raw、凭据、数据库或大文件。

## D-012 AI 自主完成可逆工程决策

**时间：2026-07-15（历史记录；具体时刻未记录）**

项目范围内可逆的代码、文档、测试、依赖选择和开发环境安装由 AI 根据证据直接完成并
记录，不把可自行解决的问题反交给用户。只有真实凭据、实盘授权、不可逆外部操作或会
改变产品方向的业务取舍才请求用户决定。

## D-011 第一批黄金测试是迁移裁判

**时间：2026-07-15（历史记录；具体时刻未记录）**

第一批 clean-room 规则和 golden PnL 是后续迁移的验收基线。旧项目 108 项测试只能说明
旧实现符合旧假设，不能覆盖或修改新裁判。

## D-010 项目文档六类结构

**时间：2026-07-15（历史记录；具体时刻未记录）**

项目上下文按索引、规范、计划、目标、背景和迭代记录分工。总目标放在
`docs/goals/PROJECT-GOALS.md`；子目标按需读取；旧 `context/` 和 `handoffs/` 已归档或删除。

## D-009 AI 主动维护项目记忆

**时间：2026-07-15（历史记录；具体时刻未记录）**

实质任务结束后，AI 按 `docs/operations/MAINTENANCE.md` 更新当前状态、必要决策、会话摘要和
索引，不等待用户提醒。每个事实只有一个权威位置，其他文件使用链接。

## D-008 上下文加载契约

**时间：2026-07-15（历史记录；具体时刻未记录）**

产品自动加载 AGENTS 规则；`AGENTS.md` 再要求读取 `docs/INDEX.md` 及其标准必读包。详细子
目标、路线、决策、知识和会话按任务路由，不全量扫描。

## D-007 实盘默认关闭

**时间：2026-07-15（历史记录；具体时刻未记录）**

`LIVE_TRADING_ENABLED=false` 是持续默认。研究/测试环境不提供真实 adapter；真实执行必须
未来单独批准。

## D-006 VaR/CVaR 的职责

**时间：2026-07-15（历史记录；具体时刻未记录）**

VaR/CVaR 用于组合尾部风险和 sizing，不生成方向 alpha，也不能替代 worst-case、日亏、
滑点、挂单、流动性与 stale 硬门禁。

## D-005 模型采用证据赛马

**时间：2026-07-15（历史记录；具体时刻未记录）**

市场、0.5、GBM/EWMA、正则化逻辑回归是基线。GARCH 家族、肥尾分布、HMM 和漂移模型
必须在独立样本证明增量；复杂度本身不是价值。

## D-004 时间与可见性

**时间：2026-07-15（历史记录；具体时刻未记录）**

source、server、receive、decision、order-send、fill、settlement 含义分开；实时 ingest 另有
process/persist。源未提供的时间为空，回放按当时可见性推进，禁止模糊单一 timestamp。

## D-003 参考项目不是真相源

**时间：2026-07-15（历史记录；具体时刻未记录）**

旧项目只提炼业务知识、事故、测试和脱敏样本；开源引擎只经适配层使用验证后的能力。
vendor SDK 类型不得进入新 domain。

## D-002 阶段门不可跳过

**时间：2026-07-15（历史记录；具体时刻未记录）**

顺序为：数据/标签/时间可信 → 回测与 PnL 可信 → 基线样本外有效 → 影子交易 → 单独批准
的极小资金实盘。“能运行”不能替代证据门。

## D-001 工作区三层分离

**时间：2026-07-15（历史记录；具体时刻未记录）**

**已被 D-035 取代。** 保留本节仅供迁移前历史追溯。

用户层只保存跨项目通用规则；本目录保存项目 AI 上下文；`polymarket-money` 只保存代码、
测试和代码工程文档。
