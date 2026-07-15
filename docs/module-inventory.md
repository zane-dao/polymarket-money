# 第二阶段模块与迁移资产盘点

## 审计范围与路径说明

- 新主项目（唯一写入位置）：`/root/projects/polymarket-money`
- 旧项目 AI/知识工作区：`/mnt/d/polymarket-paper`
- 旧项目真实 Git 仓库：`/mnt/c/Users/seeta/Desktop/hello-world`
- 旧项目 Python 代码根：`/mnt/c/Users/seeta/Desktop/hello-world/polymarket_paper`
- 开源引擎逻辑名称：`polymarket-trade-engine`
- 开源引擎实际审计路径：`/root/projects/olymarket-trade-engine`

请求中的 `~/projects/polymarket-paper` 和
`~/projects/polymarket-trade-engine` 当前不存在。VS Code workspace 与旧项目
`AGENTS.md` 证明了上述实际位置。开源引擎目录少了开头的 `p`，本阶段遵守只读
要求，没有重命名。

审计基线：旧代码仓库提交 `d08ba3e591617e45b2463777afc6ec64a3ad1a46`
（`master` 比远端领先 1 个提交）；开源引擎提交
`eda6759323b1b4cdb3559ca97876436c8fc231fd`（干净的 `master`）。未读取数据库、
`.env`、私钥、助记词、API Key 或钱包凭据，也没有执行项目入口。旧项目仅运行了
108 项不联网的定向测试；引擎因当前 WSL 没有本地 Bun/依赖且默认套件含公网测试，
没有安装依赖或运行测试。

## 旧项目 18 个模块

下表的“处理方式”严格使用约定枚举。

处理方式只使用以下枚举：`直接迁移`、`重构后迁移`、`仅迁移测试和脱敏样本`、
`通过适配层使用开源引擎`、`使用成熟 Python 库替换`、`保留作对照`、`废弃`、
`需要进一步验证`。其中“通过适配层使用开源引擎”不表示复制整个模块或允许它未经
适配直接进入实盘。

| # | 模块与文件路径 | 主要功能 | 输入 → 输出 | 外部依赖与耦合 | 测试 | 已知或疑似问题 | 可复用业务知识 | 处理方式 |
|---|---|---|---|---|---|---|---|---|
| 1 | 数据采集：`recorder/recorder.py`、`recorder/rawtap.py`、`market/feeds/*.py` | 采集 CLOB、Chainlink、Binance、Coinbase、OKX、Bybit、Kraken 原始帧与归一化数据 | WS/REST 帧、当前市场 → JSONL、`market_data.db` | 标准库网络层、`core.miniws`、`core.config`、市场表 | `test_recorder.py`、`test_rawtap.py`、各 feed 测试 | `binance_bookticker.parse` 返回四元组而 recorder 解包两项，首条合法帧可让 gather 失败；RawTap 无界队列且 close 有末帧竞态；保留代码与“永久真相源”文档冲突 | 双时间戳、tail 断点、质量巡检、单连接多消费者思路 | 重构后迁移 |
| 2 | 市场发现：`market/feeds/polymarket.py`、`market/service.py` | slug O(1) 直查，列表兜底，标题周期校验，提前发现下一盘 | 当前时间、slug 模板、Gamma JSON → `MarketInfo` | Gamma/CLOB REST、配置、主市场循环 | `test_polymarket.py` | override 可绕过正常发现校验；市场服务失败时保留旧市场快照；没有统一生命周期版本号 | 5m slug 规则、预挂市场经验、Up/Down token 映射、流动性门槛 | 重构后迁移 |
| 3 | WebSocket 行情：`market/feeds/polymarket.py::BookFeed`、`core/miniws.py` | 订单簿订阅、快照与增量合并、REST 兜底、重连 | CLOB market channel → 内存 bid/ask/ask_size | 自研 RFC6455 客户端、市场发现 | `test_polymarket.py`、`test_miniws.py` | 无 sequence/hash、无盘口 receive timestamp 和 staleness；断线后旧值仍可交易；当前官方字段是 `price_changes` 且 token 在数组项内，旧代码入口要求顶层 `asset_id` 并读取 `changes`，会丢弃增量；REST 仅在最优价为空时刷新 | 最优价失效后的 REST 修复、深度截断测试 | 仅迁移测试和脱敏样本 |
| 4 | 外部交易所价格：`market/feeds/binance*.py`、`rtds_chainlink.py`、`coinbase.py`、`okx.py`、`bybit.py`、`kraken.py` | 多源成交/BBO、Chainlink 官方结算流、信号新鲜度 | 交易所 WS/REST → 最新价、源时间、EWMA 输入 | miniws、signal、RawTap、main | 各 feed 专项测试 | 主 Binance feed 明确没有 stall watchdog；Z-score 可能把真实快速行情连续拒绝并冻结信号；不同源的 timestamp 语义不同 | Chainlink 结算口径、币安/美元量纲经验、同源价锚、stale gate | 重构后迁移 |
| 5 | 数据清洗和时间同步：`recorder/recorder.py`、`quality.py`、`strategy/replay.py` | `src_ts/recv_ts` 归一化、缺口/积压/离群检测、跨源事件合并 | 原始帧、SQLite 行 → 归一化表、质量问题、事件流 | recorder schema、配置、回放器 | `test_quality.py`、`test_replay.py` | 交易决策库仍只有单一 `ts`；缺 process/persist 时间；Binance bookTicker 无源时间；时区解析部分依赖本机时区 | 源时间与接收时间分离、延迟审计方法、脏区间隔离 | 重构后迁移 |
| 6 | 数据存储：`core/storage.py`、`recorder/recorder.py` | SQLite WAL、市场/记录/订单/资金池/锚点、原子结算与分池 | 领域数据 → `paper.db` / `market_data.db` | SQLite 与几乎所有业务模块高度耦合 | `test_storage.py`、API/报表/结算测试 | schema 在运行时迁移；无 FK；`orders.order_id` 不唯一、无 idempotency key、无订单状态/成交表；类型和单位隐含；读写模型混在一个 Store | 模拟数据标记、结算与资金池原子提交、策略×资产分池、锚点持久化 | 重构后迁移 |
| 7 | 特征计算：`strategy/signal.py`、`core/metrics.py`、`recorder/quality.py` | 单/双速 EWMA、GBM 概率映射、Brier/校准、数据质量特征 | 价格事件与参数 → sigma、概率、指标 | 可选 Rust 扩展、配置、feed | `test_signal.py`、`test_metrics.py`、registry/golden 测试 | 固定/正态 GBM 不表达波动聚集、肥尾和 regime；两套 Ito/漂移口径不一致且路由不完整；GARCH 必须预测剩余 horizon 累计方差，不能直接塞 next-step sigma | 5 秒因果采样、双速波动率基线、Brier/覆盖率验证框架 | 重构后迁移 |
| 8 | 策略：`strategy/main.py`、`order/trader.py::decide`、`variant_signal` | 多策略 A/B、edge/费率/临界带/深度/预算决策 | 显式行情与配置 → `TradeIntent`、records | main 同时编排网络、存储、结算和下单，耦合很高 | `test_trader.py`、`test_variant_signal.py`、`test_fallback.py`、`test_main.py` | `strategy/main.py` 近 900 行；策略并非纯函数边界；使用系统时钟/共享 feed/store；子策略在实盘模式也可能逐个下真实单 | 临界带、费率感知、深度参与率、信号降级整组切换 | 重构后迁移 |
| 9 | 回测：`strategy/replay.py`、`strategy/sweep.py`、`recorder/autosweep.py` | 事件回放、参数网格、实验台账和对账 | capture、两库、当前 config、可选下载数据 → replay rows、报告 | 直接复用生产解析和策略函数，但依赖历史 DB/日志/网络缓存 | `test_replay.py`、`test_sweep.py`、`test_autosweep.py`、golden registry | 使用真实 records 决定决策 tick；历史用当前 config；USD 常量由未来窗口校准；anchor 预装不按可用时刻 gate；全窗质量事后筛样本；同窗选参/报告；毫秒 tie 使行情优先于 tick | 同一解析器回放、脏区间思想、逐字段对账、实验台账 | 重构后迁移 |
| 10 | 模拟交易：`scripts/simulate.py`、`order/service.py::place_sim_order` | 本地假交易所端到端、手工模拟单落库 | 随机游走/HTTP/WS mock、面板请求 → 独立 sim DB 或 simulated record | 主循环、Store、mock server | 多数单元测试；脚本本身缺独立断言套件 | sim client 不模拟真实队列位置、延迟、部分成交与取消竞争；手工模拟单 fee=0 | 离线端到端拓扑、`simulated=1` 纪律、双结算路径 | 仅迁移测试和脱敏样本 |
| 11 | 实盘下单/撤单：`order/trader.py::place_order`、`order/service.py`、`api/handler.py` | py-clob-client GTC 买单、API 实盘切换和面板下单 | `TradeIntent`、配置/凭据 → CLOB order response、orders row | 凭据、py-clob-client、API/main 强耦合 | `test_trader.py` 有 mock；无真实撤单生命周期测试 | 没有撤单实现、幂等键、超时/重试分类、成交确认；真实 submit 后本地落库可异常返回 500；未认证 API 可切实盘；响应缺 order id 仍可能标 ok | 只有请求字段与历史失败经验可转为负向测试 | 废弃 |
| 12 | 订单状态跟踪：`core/storage.py::record_order`、`api/handler.py` 账户查询 | 记录提交结果、REST 展示 open/filled | 提交响应/账户 REST → `orders` 行、API JSON | Store、API 会话、官方 REST | API/auth/storage 测试 | 没有事件驱动状态机、部分成交、撤单确认、重启对账或本地/exchange 状态归并 | API 展示字段可作为验收样本 | 废弃 |
| 13 | 仓位和盈亏：`order/trader.py::trade_pnl`、`core/storage.py`、`strategy/settlement.py` | 纸面股数、资金池、手续费、结算和官方结果改判 | records、官方/Chainlink outcome → pnl、bankroll | Store 与 settlement 强耦合 | `test_sizing.py`、`test_storage.py`、`test_phase2.py`、`test_hedge_cap.py` | 不是实盘持仓账本；没有 fill-level 成本、实际手续费、未实现 PnL、exchange reconciliation | 官方改判差额、手续费公式、原子结算、分池 | 重构后迁移 |
| 14 | 风控：`order/trader.py::decide`、`strategy/main.py`、`core/config.py` | Kelly、单批/单市场预算、最大交易次数、陈旧信号和临界带 | 配置、资金池、行情 → 放行/拒绝/缩量 | 风控散落在策略与配置，执行层无法强制 | trader/hedge/fallback/sizing 测试 | 无中央 RiskDecision；缺每日亏损、最大未成交单、滑点、WS 断线、幂等、实盘账户限额；API 手工单绕过策略风控 | sizing、深度和 fee-aware 的业务规则 | 重构后迁移 |
| 15 | 日志和监控：`core/alerts.py`、`healthcheck.py`、`recorder/quality.py`、`watchdog/*`、report/API/UI | 数据新鲜度、磁盘、进程、备份、告警和报告 | DB/文件/进程状态 → 告警、质量表、网页、重启动作 | Windows 计划任务、psutil/pywin32、多个 Facade | alerts/healthcheck/watchdog/quality/report 测试 | 监控与自动重启混合；大量异常只记日志；缺执行级审计事件和统一 correlation id；监控自身会改配置/进程 | 数据质量评分、备份新鲜度、实验报告 | 重构后迁移 |
| 16 | 配置管理：`core/config.py`、`core/configedit.py`、`watchdog/config_edit.py`、`config.toml` | dataclass 配置、热重载、网页写配置、实盘开关 | TOML/API 表单 → Config、重启/模式变化 | 全项目共享；配置文件可能同时含策略、路径和凭据 | config/configedit/API 测试 | 运行时默认 fee=200 与文档/实盘口径 1000 有漂移风险；实盘开关可由本机 API 改写；凭据允许出现在同一 TOML；缺版本和 schema migration | dataclass 分组、热重载测试、策略快照日志 | 重构后迁移 |
| 17 | 测试：`tests/test_*.py`、`tests/golden` | 标准库 unittest，覆盖解析、策略、存储、API、数据质量 | fixtures/mocks → assertions | 多数不联网；部分通过 monkeypatch 隔离 | 48 个 `test_*.py` 文件，策略/数据层覆盖较广 | 缺真实执行适配器契约、断电窗口、重复请求、外部取消、WS gap、部分成交全排列、实盘门禁负向测试 | 大量纯函数样例、协议样本和回归案例 | 仅迁移测试和脱敏样本 |
| 18 | 临时/废弃：`scratchpad/`、`_tmp/`、`polymarket_paper_old_backup.zip`、旧 `dashboard.py`/`api/legacy_dashboard.py`、D 盘 archive/.reasonix/.playwright-mcp | 探针、一次性修复、备份、旧 UI、AI 会话产物 | 不定 | 依赖环境和历史数据，产品边界不清 | 基本无稳定测试 | 重复代码、超大归档、路径硬编码、可能含过时假设；不应进入新产品仓库 | 仅在具体事故追溯时作证据 | 废弃 |

## 开源引擎 18 项能力评估

“可复用”表示经过适配与补测后可复用，不表示当前可直接实盘。目前没有任何开源
运行时模块适合不经适配直接用于实盘；可直接吸收的范围仅限纯数据结构、fixtures、
测试场景与不触发外部副作用的工具知识。

| # | 能力与主要文件 | 可复用性 / 适配层 | 相对旧项目 | 明显缺陷与缺测 | 实盘结论 | 与旧项目重复 |
|---|---|---|---|---|---|---|
| 1 | 市场发现：`tracker/api-queue.ts`、`utils/slot.ts` | slug/slot 工具可参考；Gamma 响应必须适配到新 domain | 生命周期联动更直接，但旧项目的标题、周期、流动性校验更完整 | 默认取第一个 event/market；缺 outcome/token 映射校验；API 无限重试 | 不适合直接实盘 | 是，旧项目更强 |
| 2 | 市场生命周期：`engine/market-lifecycle.ts`、`early-bird.ts` | 状态机和测试场景值得复用，必须放在新 orchestrator/adapter 后 | 明显比旧项目的实盘生命周期完整 | 状态、网络、策略、风控、PnL 混在一个类；系统时钟和回调驱动，不可确定回放 | 修复后再 shadow | 旧项目仅纸面周期 |
| 3 | CLOB 客户端：`engine/client.ts` | `PolymarketEarlyBirdClient` 只能作为 vendor adapter 内部实现 | 比旧 `trader.place_order` 完整，支持查询/撤单/余额/兑换/赎回 | 无 idempotency/clientOrderId；异常分类弱；`viem` 与 builder signing 为隐式传递依赖；生产类无直接测试 | 条件复用 | 是，开源更强 |
| 4 | WebSocket 订单簿：`tracker/orderbook.ts`、`PriceLevelMap` | parser/数据结构/fixture 可复用，连接状态需由新 adapter 包装 | 比旧项目维护全档更完整 | 无 sequence/hash、recv/exchange timestamp、staleness；断线期间无交易熔断；解析异常可逃逸 | 不可直接实盘 | 是，开源更强但仍不够 |
| 5 | 用户订单频道：`engine/user-channel.ts` | 事件 race 处理思路可复用，需重写为持久事件归并器 | 旧项目基本没有，明显更完整 | ready 在 socket open 即完成而非认证确认；立即重连无 backoff；REST 对账错误静默；部分成交可能过早 settle；外部取消会丢已成交部分 | 当前不适合实盘 | 否，填补旧项目空白 |
| 6 | 下单：`client.ts::postMultipleOrders`、`market-lifecycle.ts::_placeWithRetry` | CLOB v2 签单/批量提交可藏在 adapter 后 | 比旧单笔 GTC 完整 | 无幂等；fire-and-forget；网络结果不明时无查单再重试；按错误字符串改 shares | 不可直接实盘 | 是，开源更强 |
| 7 | 撤单：`cancelOrder/cancelOrders`、`_cancelOrders` | 批量撤单接口可复用 | 旧项目没有真正撤单 | 先 untrack 再调用 API，API 异常时本地失去事件路由；not_canceled 处理不足 | 补对账后可用 | 基本不重复 |
| 8 | 部分成交：`user-channel.ts`、expiry/commitFill | trade-id 去重与 maker/taker 分流可参考 | 比旧项目完整 | 只传股数，不保留实际成交价/fee；MATCHED 集合并非最终交易集合证明，可能首笔 MINED 后提前完成；取消竞态覆盖不足 | 高风险，不可直接实盘 | 旧项目无实现 |
| 9 | GTC/FOK：`MultiOrderRequest`、CLOB mapping | 订单类型映射可直接包在 adapter | 比旧项目只支持 GTC 完整 | FOK 费率和净 shares 在 lifecycle 内硬编码；缺 FAK/GTD 的统一 domain 映射 | 补契约测试后可用 | 部分重复 |
| 10 | 紧急退出：`_emergencySells` / `_emergencySellLoop` | 流程场景可复用，不复用实现 | 旧项目无真正退出流程 | 用 GTC 挂 best bid，不是保证退出；无最大滑点；cancel not_canceled 后可能不继续；直到收盘循环 | 当前不适合实盘 | 否 |
| 11 | 仓位管理：`WalletTracker` | 仅适合 sim/reference；新项目需 exchange-reconciled ledger | 比旧纸面资金池更接近订单生命周期 | 内存乐观账本，不从成交/链上持续对账；启动只取 collateral，不重建 conditional positions | 不适合实盘 | 是，但两者均不足 |
| 12 | PnL：`_computePnl`、`WalletTracker` | 测试场景可复用，实现需替换 | 有订单生命周期但不比旧项目的结算知识可靠 | 使用委托价而非实际 fill price；fee 主要只对 FOK 算；恢复 fill fee=0；缺未实现 PnL | 不适合实盘 | 是，旧项目业务知识更好 |
| 13 | 状态持久化：`engine/state.ts` | 原子 rename 模式可参考 | 比旧项目有 pending order snapshot | 5 秒快照产生 crash gap；无 schema version/checksum/event journal；load 失败静默返回 null | 不足 | 旧项目偏业务 DB，互补 |
| 14 | 崩溃恢复：`engine/recovery.ts` | 流程和测试需求可参考，不能直接复用 | 旧项目没有实盘恢复，概念更完整 | 不枚举 exchange 全部 open orders；REST null 会丢单；恢复 fill 用原始 shares 且 fee=0；无 sell 的持仓会被跳过；`recovery.ts` 无直接测试 | Critical，禁止实盘 | 基本不重复 |
| 15 | 多交易所行情：`tracker/ticker.ts`、`reconnecting-ws.ts` | provider adapters 可拆用 | 接口集中，旧项目的数据记录与时间语义更强 | 价格无 timestamp getter；值在断线后永久保留；stale 只检查首个全局消息；killswitch 不在中央执行风控强制 | 只适合信号参考 | 是，双方各有优势 |
| 16 | 风险控制：`WalletTracker`、session loss、strategy guards | 只能迁移测试想法 | 比旧项目多 session loss 与余额预留，但仍不完整 | 缺单笔/市场/每日/滑点/open orders/stale WS/idempotency；风险散落且策略可绕过 | 不适合实盘 | 是，双方均需重建 |
| 17 | 测试覆盖：`test/` | fixture runner、WS fixtures、生命周期场景建议迁入 golden/replay | 对执行生命周期覆盖远胜旧项目 | 生产 CLOB client、recovery、CLI prod gate、真实 user reconnect 无直接测试；主要是 sim happy/已知 race | 只能证明局部行为 | 与旧测试互补 |
| 18 | 配置/密钥：`utils/config.ts`、`.env.sample`、`index.ts` | 非敏感 typed config 思路可参考，密钥加载必须替换 | 配置较小，但安全门禁更弱 | 私钥/Builder 凭据直接来自进程环境；`--prod` 单开关；`FORCE_PROD=true` 时没有设置 `PROD=true`，可绕过内置策略 prod guard | Critical，禁止直接实盘 | 是，均需新方案 |

## 跨项目迁移对照表

| 功能领域 | 旧项目文件 | 开源引擎文件 | 旧项目优点 | 开源引擎优点 | 风险或缺陷 | 最终采用来源 | 迁移方式 | 优先级 | 验证方法 | 当前状态 |
|---|---|---|---|---|---|---|---|---|---|---|
| Domain 与时间语义 | `docs/DATA.md`、storage/recorder schema | 分散在 `utils/trading.ts`、lifecycle types | 有 src/recv 双时间与研究字段经验 | 有 order/fill lifecycle 类型 | 两边都没有统一因果时间模型 | 新主项目自维护 | 重构后迁移 | P0 | 类型编译、时间不变量、乱序 replay | 第一批 Python 契约完成；实时 TS 待对齐 |
| 市场发现 | `market/feeds/polymarket.py` | `tracker/api-queue.ts`、`utils/slot.ts` | slug、标题、周期、流动性校验成熟 | slot/lifecycle 集成简洁 | engine 默认首元素；旧 override 风险 | 旧业务规则 + 新 domain | 重构后迁移 | P0 | 历史 Gamma fixtures、边界时刻、错系列负例 | 已盘点 |
| 市场生命周期 | `strategy/main.py` | `engine/market-lifecycle.ts` | 多档位和结算经验 | 明确 INIT/RUNNING/STOPPING/DONE | engine 耦合且依赖系统时钟 | 新主项目，参考 engine | 重构后迁移 | P0 | 虚拟时钟、状态转移、异常/重启 property tests | 已盘点 |
| CLOB transport | `order/trader.py` | `engine/client.ts` | 最小请求与旧失败经验 | v2、批量、撤单、查单、余额 | 无幂等/强错误模型 | 开源引擎适配层 | 需要进一步验证 | P0 | mock server contract、unknown-outcome retry、no-live tests | 已盘点 |
| 公共订单簿 | `market/feeds/polymarket.py` | `tracker/orderbook.ts` | REST 修复与深度业务规则 | 全档 PriceLevelMap 与 fixtures | 无 sequence/stale/gap | engine parser + 新连接监督 | 重构后迁移 | P0 | 抓包 golden、断线/gap/reorder、checksum | 已盘点 |
| 订单簿纯结构 | 自研 dict | `tracker/orderbook.ts::PriceLevelMap` | 旧测试说明 top-of-book 业务需求 | vendor-neutral、实现和 fixture 较集中 | 直接迁移仍需保留 MIT notice，并先验证精度/排序/重复 level | 开源引擎纯结构 | 直接迁移 | P1 | license 清单、property tests、与 golden book 对拍 | 待迁移批次后评估 |
| 用户订单流 | 基本缺失 | `engine/user-channel.ts` | — | maker/taker/MATCHED/MINED race 思路 | 提前 settle、重连和外部取消风险 | engine 思路，新项目重写 | 重构后迁移 | P0 | 事件排列组合、部分成交、重复事件、掉线对账 | 已盘点 |
| 幂等下单 | 无 | 无 | — | — | 重复下单 Critical | 新主项目自维护 | 需要进一步验证 | P0 | crash-point/injected timeout、唯一键、exchange 查询 | 第一批内存裁判完成；durable/reconcile 缺失 |
| 撤单/紧急退出 | 无真实撤单 | lifecycle/client | — | 有批量撤单与退出场景 | 非确定退出、无滑点上限 | engine adapter + 新 risk | 重构后迁移 | P0 | not_canceled、matched race、无流动性、最大滑点 | 已盘点 |
| Position/Balance ledger | Store 纸面池 | `WalletTracker` | 原子结算和分池 | 订单预留 | 都不是 exchange truth | 新主项目自维护 | 重构后迁移 | P0 | fill ledger 双录、REST/链上 reconcile、会计恒等式 | 第一批离线 fill ledger 完成；持久化/对账缺失 |
| PnL/fee | sizing/trader/settlement | lifecycle compute | 官方结算与 fee 业务知识较强 | 与订单生命周期联动 | engine 使用委托价、fee 不全 | 旧公式/测试 + 新 fill ledger | 重构后迁移 | P0 | 已知成交 golden、精度/舍入、官方账单对账 | 第一批手工 PnL golden 完成；动态 fee 待验证 |
| 风控 | trader/main/config | session loss/WalletTracker | Kelly、深度、临界带、预算 | 余额预留、session stop | 两边都可被执行路径绕过 | 新主项目中央 RiskEngine | 重构后迁移 | P0 | 每条规则边界、组合规则、fail-closed | 缺失 |
| 外部行情 | 多个 Python feeds | `tracker/ticker.ts` | 时间戳、Chainlink、研究积累 | 统一多 provider 连接 | 两边都有 stale/reconnect 缺口 | TypeScript adapter，参考双方 | 重构后迁移 | P1 | provider fixtures、stale/clock skew/failover | 已盘点 |
| 数据录制 | recorder/rawtap/quality | logger NDJSON | 双时间、质量检测、断点续读 | slot/orderbook 日志方便 | RawTap 退出丢数；engine 日志单时间且内存缓冲 | 旧知识 + 新 event journal | 重构后迁移 | P1 | kill -9、磁盘满、重放 hash、队列背压 | 已盘点 |
| 研究数据框/列式存储 | stdlib SQLite/JSONL | NDJSON | 依赖少、已有双时间经验 | fixture 简单 | 自研 join/as-of/列式读写会扩大泄漏和性能风险 | Polars + PyArrow + DuckDB | 使用成熟 Python 库替换 | P1 | point-in-time join、schema round-trip、dataset hash、性能基准 | 候选依赖，未安装 |
| 条件波动与概率 | `strategy/signal.py` 的 EWMA/GBM | late-entry indicators | 固定因果栅格、校准事故知识 | 有额外技术指标场景 | 固定 sigma/正态 GBM 不表达聚集、肥尾和 regime；GARCH 也不自动产生方向 edge | `arch` + NumPy/SciPy/statsmodels；市场/GBM/正则化逻辑回归为基线 | 使用成熟 Python 库替换 | P1 | purged walk-forward、horizon variance、Brier/log loss/calibration、净 PnL | 需要离线研究，未安装 |
| VaR/CVaR 与组合风险 | `strategy/sizing.py` 仅用“CVaR”名描述单笔上限 | 无完整实现 | 已有硬预算意识 | 有 session loss 场景 | 两边都没有真正置信水平、尾部条件损失、相关暴露和压力情景 | NumPy/SciPy/`arch` 研究 + 新 RiskEngine 硬门禁 | 使用成熟 Python 库替换 | P1 | 历史/Student-t/EVT 对拍、压力情景、coverage/backtesting | 需要离线研究，未安装 |
| 特征/概率策略契约 | signal/metrics | late-entry indicators | BTC 5m 业务特征和概率校准经验 | RSI/ATR/RTV 场景 | 需样本外验证，engine strategy 有 I/O；旧 prob_model 路由并不总生效 | 新主项目纯函数策略；旧模型保留基线 | 重构后迁移 | P1 | determinism、walk-forward、Brier、参数冻结、无前视 | 已盘点 |
| 策略 | decide/variant_signal | strategy callback API | BTC-5m 业务规则丰富 | 执行回调样例 | 两边策略边界都不纯 | 新主项目纯函数策略 | 重构后迁移 | P1 | determinism、golden decisions、shadow diff | 已盘点 |
| 回放/回测 | replay/sweep | fixture runner/sim tests | 真实录制与逐字段对账 | 执行生命周期 fixtures | 旧回放 tick/source-time 偏差；engine sim 过简 | 旧回放资产 + engine fixtures | 重构后迁移 | P1 | causality audit、延迟注入、walk-forward | 已盘点 |
| 状态持久化/恢复 | SQLite/anchors | state/recovery | 业务状态原子事务 | pending snapshot 与恢复流程 | engine crash gap/orphan；旧无实盘恢复 | 新 event journal + exchange reconcile | 重构后迁移 | P0 | 每个 crash point、损坏快照、孤儿单/仓位 | 缺失 |
| 配置与 live gate | config/watchdog/API | Env/index CLI | typed groups、参数快照 | 简单 env | 两边实盘门禁都不足；engine 有明确绕过 bug | 新主项目自维护 | 重构后迁移 | P0 | 默认关闭、负向矩阵、双人/TTL arming、不可热改 | 第一批结构性关闭完成；未来 arming 未设计 |
| 监控与审计 | quality/health/watchdog | logger/log | 数据与进程健康丰富 | slot 级结构日志 | 无统一 decision/order correlation | 新主项目自维护，迁移旧规则 | 重构后迁移 | P1 | 告警注入、审计链完整性、监控故障 | 已盘点 |
| 测试与样本 | `tests/`、knowledge | `test/`、fixtures | 研究、解析、存储覆盖广 | execution lifecycle 覆盖广 | 生产执行与恢复缺测 | 双方测试资产 | 仅迁移测试和脱敏样本 | P0 | provenance 清单、逐个移植、golden 固化 | 已盘点 |
| UI/API | api/web/dashboard | analysis dashboard | 本地可视化和实验台 | run 分析较聚焦 | 旧 API 有未鉴权写操作；不应控制 live | 新主项目后置建设 | 保留作对照 | P2 | 只读 API、auth/CSRF、契约测试 | 暂缓 |
| 临时/归档 | scratchpad、`_tmp`、archive、旧 Facade | scripts/chart/redeem/pusd/reset | 个别事故证据 | 运维样例 | 可能直接链上操作或破坏状态 | 不采用 | 废弃 | P3 | 不迁移；必要时人工取单个 fixture | 已分类 |

## 第一批完成后的新主项目状态

- `execution/src/storage`：等待事件日志、ledger 与恢复协议设计。
- `execution/src/monitoring`：等待统一审计事件和健康模型。
- `research/polymarket_money`：已建立第一批 Python domain、纯业务规则、安全门禁和离线
  fill ledger；它不是持久化或实盘实现。
- `tests/unit` 与 `tests/golden`：已有 30 项离线测试，且干净 venv 安装验证通过；
  integration/replay/shadow 仍为空。
- `data/golden/batch-1`：已有三个人工市场 PnL fixture；raw/processed/datasets 仍为空。
- research 的 notebooks/datasets/features/backtest/reports：仍等待只读数据契约和数据集
  provenance，不含策略或回测迁移。
- `scripts`：当前保持空，避免误引入会联网或链上执行的旧脚本。
