# 第二阶段审计问题清单

## 审计说明

本清单来自静态代码、离线定向测试、项目知识和官方协议审阅。没有读取 `.env`、数据库、
私钥、助记词、API Key 或钱包凭据；没有启动网络服务、运行交易入口或发送订单。旧项目
在禁止 `.pyc` 且强制纯 Python fallback 的条件下运行 108 项定向测试并全部通过；开源
引擎未安装依赖或运行测试，因为默认测试包含公网集成用例。

路径缩写：

- **旧**：`/mnt/c/Users/seeta/Desktop/hello-world/polymarket_paper`
- **引擎**：`/root/projects/olymarket-trade-engine`（源码位于仓库根目录的
  `engine/`、`tracker/`、`utils/` 等目录）

严重级别表示“若直接用于实盘”的潜在影响，不表示已经发生资金损失。

## 最严重的五个问题

| 排名 | 问题 | 直接证据与影响 |
|---|---|---|
| 1 | 旧项目实盘控制与提交没有安全/幂等边界 | C-02、C-03、C-10：未正确保护的 live-toggle/order API；真实 `post_order` 后本地落库可报 500；unknown outcome 无幂等，可能重复真实订单 |
| 2 | 开源引擎生产门禁存在双真相 | C-01：`--prod + FORCE_PROD=true` 构造真实 client，却未设置策略保护读取的 `PROD=true`，默认 simulation 策略可在错误模式认知下运行 |
| 3 | 开源引擎部分成交与恢复不能保持账户一致 | C-04、C-05：部分成交事件顺序可提前 settle；5 秒快照、静默 fresh start、不枚举全账户 open orders 会留下孤儿单/仓位 |
| 4 | 旧项目公共数据链可崩溃或丢弃当前盘口增量 | C-06、C-07：Binance bookTicker 四元组被按二元组解包；当前官方 `price_changes[]` 因旧顶层 asset/`changes` 假设被丢弃，旧 book 还可能持续暴露 |
| 5 | 旧回测和报表会制造不可实现的正收益 | C-08、H-16、H-19：best ask 立即全成、模拟行进入主绩效、动态费率未正确使用、point-in-time/同窗选参偏差；历史盈利必须用新回测重算 |

## Critical

### C-01 开源引擎存在生产模式门禁分叉

- **证据**：引擎 `index.ts` 只在交互确认分支设置 `process.env.PROD="true"`；
  `--prod` 配合 `FORCE_PROD=true` 会跳过该分支，但仍按 `opts.prod` 构造真实 client。
  内置 simulation/late-entry 策略却使用 `Env.get("PROD")` 判断是否允许执行。
- **影响**：真实执行 adapter 已启用，而策略层仍自认为非生产，生产保护可能失效。
- **处置**：禁止直接采用该 CLI；新项目使用单一、不可热改的 live gate，并增加完整
  负向组合测试。

### C-02 旧项目可通过未认证本地 API 打开实盘并下单

- **证据**：旧 `api/handler.py` 暴露 live-toggle 和 order 写接口；
  `order/service.py` 可将 `paper=false`、`auto_trade=true`，并走真实下单路径。
- **影响**：localhost 不是授权边界；浏览器、CSRF、恶意本机进程或错误脚本可触发
  模式变化和下单，且手工订单可绕过主策略风控。
- **处置**：该 API 和 live-toggle 不迁移；live 配置需重启、认证、短时 arming 和中央
  风控，且默认 `LIVE_TRADING_ENABLED=false`。

### C-03 两个项目都缺少端到端幂等下单协议

- **证据**：旧 orders schema 没有唯一 idempotency key；引擎 `client.ts` 和
  lifecycle 的 submit/retry 没有稳定 client order id，也没有“超时后先查单再重试”。
- **影响**：请求已被交易所接受但响应丢失时，本地无法安全判定结果；后续人工操作、
  重启恢复或外层重试可能重复下单。引擎当前 placement loop 的网络异常本身会退出，
  但这并不能解决 unknown outcome。
- **处置**：先持久化确定性 OrderIntent/idempotency key；未知结果进入 reconciliation，
  未确认前禁止盲重发。

### C-04 开源引擎恢复流程可能遗失订单或持仓

- **证据**：引擎 `early-bird.ts:268-327` 约每 5 秒调用 `state.ts` 保存 JSON；读取异常
  静默返回 null；
  `recovery.ts` 不枚举账户全部 open orders，REST null 会丢弃本地订单；只有历史买入/
  持仓而没有 pending sell 时可能被当作“全部完成”。恢复代码对过期单或恢复后的买单
  发出撤单后不检查 `canceled/not_canceled`，随后即返回或丢弃本地跟踪。
- **影响**：崩溃窗口、损坏快照或 REST 暂时失败可产生孤儿单、孤儿仓位，并在错误的
  空状态上继续交易。
- **处置**：事件日志 + 校验快照 + 全账户订单/成交/余额/仓位对账；任何未解释差异
  阻止 READY/live。

### C-05 用户订单频道可能过早完成部分成交订单

- **证据**：引擎 `engine/user-channel.ts::_trySettle` 以当前已观察到的 associated
  trades 数量判断 mined 完成。如果第一笔 MATCHED/MINED 先到、第二笔 MATCHED 后到，
  第一笔即可触发完成；现有多成交测试没有覆盖该事件排列。若 `UPDATE/MATCHED` 的
  `associate_trades` 缺失或为空，当前比较还可能立即触发 `onFilled(0)` 并删除跟踪。
  `market-lifecycle.ts:405-423,492-504` 在槽结束时又排除 MATCHED 但尚未 MINED 的订单，
  随即进入 DONE 并销毁 user channel，后到成交会丢失。
- **影响**：漏记后续成交，导致订单状态、可用余额、持仓和 PnL 全部不一致。
- **处置**：以 exchange order 状态/remaining size 和可持久化 fill ledger 为准，增加
  事件全排列、重复、迟到和外部取消测试。

### C-06 旧 recorder 可被首条合法 Binance bookTicker 确定性击穿

- **证据**：旧 `market/feeds/binance_bookticker.py:24-29` 返回
  `(bid, ask, bid_qty, ask_qty)` 四元组；`recorder/recorder.py:542-549` 却以
  `bid, ask = parsed` 解包。`recorder.py:387-393` 的 callback 不捕获该异常，
  `639-665` 又将任务置于 `asyncio.gather`。
- **影响**：首条合法 bookTicker 即可终止录制任务，导致多源数据缺口和无法复现的回测。
- **处置**：旧实现不迁移；统一 typed event 契约，并把此反例加入批次 1 golden/negative
  tests。

### C-07 旧 Polymarket 增量解析与当前官方 schema 不兼容

- **证据**：旧 `market/feeds/polymarket.py:289-335` 在判断事件前要求顶层
  `asset_id`，并读取 `changes`。当前官方 `price_change` 的 token 在
  `price_changes[]` 内，顶层没有该 asset_id。官方定义见
  [Market Channel](https://docs.polymarket.com/market-data/websocket/market-channel)。
- **影响**：当前增量在入口直接被丢弃；断线/旧值又没有 freshness gate，策略可能用
  陈旧盘口制造 edge 和理想成交。
- **处置**：旧 parser 仅保留失败 fixture；新 adapter 按当前 schema 实现并验证
  timestamp/hash/gap/resync。

### C-08 旧模拟成交与报表口径会制造不可实现利润

- **证据**：`order/trader.py:103-132` 只读当前卖一；`strategy/main.py:340-359,
  405-436` 立即记为全部成交，没有延迟、排队、多档、部分成交、拒单和取消竞态。
  `core/storage.py:490-530` 与 `strategy/report.py:35-70,1947-1960,2298-2331` 又会把
  `simulated=1` 计入主 PnL/Brier/CSV。实际资金池虽在 `storage.py:334-338` 排除模拟行，
  但绩效口径没有排除。
- **影响**：历史正收益可能来自假成交和模拟数据污染，不能作为实盘盈利证据。
- **处置**：现有成绩全部标为“不可信待重算”；批次 3 重建逐事件 fill simulator 和严格
  provenance/segment 过滤。

### C-09 开源引擎把 BTC 5 分钟平局错误判为 Down

- **证据**：引擎 `engine/market-lifecycle.ts:963-975` 使用
  `closePrice > openPrice`；当前官方规则是 `close >= open` 为 Up，且结算源是 Chainlink
  BTC/USD，见[市场规则](https://polymarket.com/event/btc-updown-5m-1779220200)。
- **影响**：本地结算标签、预期 payout、PnL、钱包账和恢复状态可能错误；链上 redeem
  本身不依赖这一本地方向判断，不能据此断言链上实际兑付会被改写。
- **处置**：本地推导只能用于 provisional signal；最终 settlement 必须按版本化规则和
  official winner 对账，并固化 tie golden case。

### C-10 旧手工真实订单可能“交易所成功、本地返回 500”并被重复提交

- **证据**：旧 `order/service.py:150-160` 先调用真实 `post_order`，随后构造的 intent
  没有 `stake/fee`；`core/storage.py:268-272` 访问缺失字段可异常，`service.py:211-214`
  把它返回为 500。没有幂等键和成功订单恢复。
- **影响**：操作者重试同一请求会形成重复真实订单。
- **处置**：该实盘路径废弃；事故序列转为 unknown-outcome/idempotency crash test。

## High

### H-01 两套订单簿都缺少可实盘的连续性与过期保护

- **证据**：旧 `BookFeed` 和引擎 `tracker/orderbook.ts` 都没有可靠 sequence/checksum、
  gap 处理和统一四时钟；断线期间内存旧价仍可读取。旧实现仅在 bid/ask 为空时 REST
  修复，引擎重连后延迟清空。
- **影响**：策略可能在失真或陈旧盘口上定价、判断滑点并下单。
- **处置**：连接健康、snapshot watermark、gap 检测和数据 TTL 必须由 adapter 输出，
  中央风控强制 fail closed。

### H-02 开源引擎 PnL 和手续费不能作为实盘账本

- **证据**：lifecycle PnL 使用委托价而非 fill price；fee 主要围绕 FOK 计算；恢复
  成交 fee=0；user channel 只提交 size，未保留实际价格/fee。
- **影响**：成本、仓位价值、每日亏损和策略表现被系统性误算。
- **处置**：建立逐 fill、定点数、含 fee/rebate 的双录账本，并与官方账户记录对账。

### H-03 旧项目实盘订单生命周期不完整

- **证据**：旧 `order/trader.py` 主要支持 GTC 买入；没有撤单、部分成交、重启恢复和
  状态机；响应即使没有可靠 order id 也可能返回 `ok`。
- **影响**：无法证明订单是否存在、成交多少或何时可安全重试。
- **处置**：不迁移实盘实现；只保留字段/失败样本，执行协议经新 adapter 重建。

### H-04 主 Binance 信号可能在断流或剧烈行情中冻结

- **证据**：旧主 Binance feed 明确没有 stall watchdog；短窗口 Z-score 会拒绝超过阈值
  的新价格，真实快速行情可能连续被当成异常。
- **影响**：内部价格看似存在但实际陈旧，尤其在 BTC 快速波动时产生错误概率和 edge。
- **处置**：用源/接收时间、heartbeat、跨源偏差和连续拒绝计数判定 unhealthy；陈旧
  状态不能沿用最后价格产生新单。

### H-05 RawTap 关闭与背压存在数据丢失窗口

- **证据**：旧 `recorder/rawtap.py` 使用无界队列与 daemon writer；flush 只等待队列
  为空，不确认写入/fsync；关闭时 writer 取出元素后可能因 stop 标志退出。
- **影响**：高负载内存膨胀，关机/崩溃时尾部数据缺失，回放因果链不完整。
- **处置**：有界队列、明确 backpressure、task completion、批次 durability watermark、
  磁盘错误告警与 kill -9 测试。

### H-06 时间戳语义不统一

- **证据**：旧 recorder 有 `src_ts/recv_ts`，交易 DB 多数只用 `ts`；引擎价格、订单簿
  和订单状态也没有统一的 exchange/receive/process/persist 时间。
- **影响**：无法可靠判断数据新鲜度、网络延迟、事件顺序和回测因果性。
- **处置**：全事件统一四时钟；缺源时间必须为空而非伪造，策略时间作为显式输入。

### H-07 风控分散且可绕过

- **证据**：旧项目风控散在 trader/main/config，API 手工单不走相同决策；引擎风险散
  在 WalletTracker、session loss 与策略，缺统一 RiskDecision。
- **影响**：单笔、市场、每日亏损、滑点、未成交单、断线、stale 和重复订单限制无法
  对所有路径强制。
- **处置**：新建中央 RiskEngine，任何 adapter 提交前都必须持久化通过的 RiskDecision。

### H-08 配置漂移和运行时热改会改变安全语义

- **证据**：旧 config 的 fee 默认值与文档/其他口径存在差异，策略、路径和可能的凭据
  共用 TOML，网页可改模式；引擎主要依赖无 schema 的环境变量和 CLI flags。
- **影响**：相同代码和数据在不同机器产生不同订单，审计难以重建当时配置。
- **处置**：版本化 typed schema、配置 hash、单位校验；live 配置不可通过网页热改。

### H-09 旧回测存在选择与延迟建模偏差，前视风险尚需隔离验证

- **证据**：旧 replay 可用实际 records 决定决策 tick；下载的 Binance 数据按交易所
  时间而没有真实接收延迟；历史窗口可能使用当前 config；缺失 outcome 可由已知结果
  回退结算。已知 outcome 只用于结算 PnL，没有发现它直接进入交易决策，因而这里不把
  该回退单独定性为决策前视。
- **影响**：决策时点被实际 records 条件化、信号可得延迟被低估、当前配置污染历史，
  都可能使样本选择与可交易性偏乐观；结算来源也可能影响绩效口径。
- **处置**：以录制 receive-time 驱动，参数/配置冻结，延迟注入，walk-forward，缺失
  数据必须显式标记；另外用 causality audit 证明任一决策都只依赖当时可见数据。

### H-10 用户 WebSocket 的认证、重连和对账不足

- **证据**：引擎 user channel 在 socket open 时即 ready，而不是收到认证确认；立即重连
  无指数退避；REST reconciliation 错误和 getOrder null 被弱化或静默处理。
- **影响**：系统可能在未订阅成功或未知账户状态下认为已就绪，且掉线风暴放大风险。
- **处置**：明确 AUTHENTICATED/SYNCING/READY 状态，带抖动退避，失败计数和强制停单。

### H-11 外部取消可能覆盖已发生的部分成交

- **证据**：引擎 user channel 处理外部取消时会移除 tracked order 并走 failed 回调，
  但未保证已 MINED fills 先完整入账。
- **影响**：账本漏记已成交数量，恢复后余额/仓位不一致。
- **处置**：取消只是订单终态事件，成交是独立不可逆事件；两者都进入持久 ledger。

### H-12 市场切换可能沿用旧 token 或交叠交易两个周期

- **证据**：旧市场服务失败时可保留上一市场快照，且 market override 可绕过正常发现；
  该 service 主要服务 API/手工路径，旧主策略循环使用显式 `MarketInfo`，未发现它通过
  此 service 切盘。引擎市场发现偏向响应中的首个 event/market，且可并行生命周期。
- **影响**：旧 API/手工路径可能沿用陈旧市场快照；引擎在 BTC 5 分钟边界可能把新周期
  价格用于旧 token，或在预发现/重连竞态中同时交易相邻周期。
- **处置**：引入 `marketEpoch` 和原子 rollover 状态机；停止旧周期新单、处理/撤销旧单、
  验证新 token/快照/时间窗口后才发布新市场；覆盖边界秒、双市场交叠和重连测试。

### H-13 开源引擎的市场身份、token 方向和订单签名参数存在硬编码

- **证据**：引擎 lifecycle 忽略 API 的 `outcomes`，直接假定 token 数组
  `[0]=UP/[1]=DOWN`；API queue 已读取 `negRisk`，但下单路径硬编码 `negRisk:false`。
  生产 client 还固定使用 `signatureType:1`，没有与实际账户/钱包类型做显式校验。
- **影响**：响应排序、negative-risk 市场或账户类型不符合假设时，可能交易错误 outcome、
  构造错误订单或产生难以分类的签名失败。
- **处置**：市场发现必须按 outcome 文本映射 token，保留并校验 market/condition/
  `negRisk`；账户签名类型是受审配置，并在无下单 contract 环境验证。

### H-14 开源引擎结算与 PnL 缺少官方 winner 对账

- **证据**：引擎 lifecycle 主要以本地 open/close price 推导方向和 PnL，没有像旧项目
  settlement 那样用官方 winner 结果复核；并使用 `closePrice > openPrice`，相等时落入
  DOWN，而旧项目明确把平局归为 Up。
- **影响**：边界盘、价格源差异、改判或本地数据缺失时，本地标签、预期 payout 和 PnL
  可能与官方结算不一致。
- **处置**：交易期信号方向与最终 settlement 分离；PnL 只有在官方 winner/兑付状态经
  独立来源确认后才 final，平局规则在采用前以官方规则和 golden case 验证。

### H-15 固定正态 GBM、漂移口径和模型路由不足以支持实盘概率

- **证据**：旧 `strategy/signal.py:190-210` 的 `prob_up` 与
  `269-300` 的 `prob_up_drift` 对 Ito 项口径不同；`strategy/main.py:83-84,255-256` 的
  路由又会让部分 variant 忽略配置的 probability model。固定 sigma/正态 GBM 不表达
  波动聚集、肥尾、非对称冲击和 regime shift。
- **影响**：概率可能失准，并被错误解释为可交易 edge。对 ATM BTC 5m，换用 GARCH
  主要改进条件方差，不会自动生成方向 alpha。
- **处置**：GBM 只保留基线；在离线模型 tournament 中比较 EWMA、GARCH、GJR/EGARCH、
  Student-t/skew-t、HMM/regime 和经验漂移。以 purged walk-forward、calibration、
  log loss/Brier 及费用/成交后的样本外净 PnL 决定是否采用。

### H-16 旧回放存在多种已确认的非 DataFrame 型前视/选择偏差

- **证据**：`strategy/replay.py:441-449` 的 USD 常量来自后续窗口校准；`488-499` 用
  真实 records 选择候选决策 tick；`524-537` 使用当前 config；`570-587` 预装 anchors
  而未按可用时刻 gate；`590-615` 用整窗事后质量标记筛盘；`743-758` 在毫秒 tie 时让
  行情先于 tick。`strategy/sweep.py:592-668,813-860` 同窗选优并报告，没有独立 holdout。
- **影响**：即使没有 pandas `shift/bfill`，回测仍可能看到当时不可见信息或只评估有利
  样本，显著夸大 edge。
- **处置**：point-in-time event store、纳秒/ingest sequence、参数生效版本、purged
  walk-forward/embargo、独立 holdout 和 multiple-testing correction。

### H-17 开源引擎把 MINED 当最终成交并忽略当前用户频道状态

- **证据**：`engine/user-channel.ts:114-198` 只处理 MATCHED/MINED；当前官方状态机还
  定义 CONFIRMED、RETRYING、FAILED，MINED 后状态仍可能继续变化，见
  [User Channel](https://docs.polymarket.com/market-data/websocket/user-channel)。引擎还使用
  已漂移的 `ws-subscriptions-frontend-clob` endpoint。
- **影响**：链上失败/重试可能被提前计入持仓和 PnL，或永久卡住。
- **处置**：用户流 adapter 必须保存原始事件和状态 finality，重连后用 REST/exchange
  truth 对账。

### H-18 开源引擎 SDK、账户类型与错误返回处理不兼容当前生产要求

- **证据**：`package.json` 锁定旧 `clob-client-v2 1.0.2`；`engine/client.ts:380-424`
  固定 signatureType 1、order version 2，上层固定 negRisk false。官方 SDK 默认可能返回
  `{error,status}` 而不是抛异常；该 client 未启用 `throwOnError`，却把 getOrder 错误当
  null、把 cancel 结果强制 cast。wrap/redeem 又固定 PROXY relayer。
- **影响**：新 deposit-wallet/POLY_1271、V3/tick/negRisk 市场会签错；API 错误可被误认成
  “订单不存在”或在后续访问时异常。
- **处置**：不得复制内部 builder 调用；通过锁版本的官方 SDK adapter，显式账户能力、
  market info 和 typed error/unknown outcome contract。

### H-19 动态手续费与实际 fill role 在两个项目中都不可靠

- **证据**：旧主循环忽略发现到的市场 fee，改用互相矛盾的全局 bps；引擎主要只给 FOK
  计 fee，并丢弃 user trade 的实际 price/fee role。marketable GTC 也可能成为 taker。
  当前官方按市场和实际成交身份计费，见
  [Fees](https://docs.polymarket.com/trading/fees)。
- **影响**：净 edge、PnL、日损失和 VaR/CVaR 输入都会系统性错误。
- **处置**：动态 market fee metadata 随数据集版本化；逐 fill 记录 maker/taker、实际价、
  费率、费用币种和官方舍入。

### H-20 旧代码所谓“CVaR”不是组合尾部风险模型

- **证据**：旧 `strategy/sizing.py:1-12` 把“单笔最大损失不超过资金 2%”称为 CVaR，
  但没有置信水平、损失分布、超过分位数的条件均值、相关暴露或重叠市场组合。
- **影响**：名称会给人错误安全感；相邻五分钟市场、多个策略和未结订单的联合尾部损失
  没有被衡量。
- **处置**：保留单笔硬上限但正确命名；在研究层评估历史、Student-t/偏态和 EVT 压力
  下的 VaR/CVaR，在中央风控中把它作为组合 sizing 的补充，不能取代 worst-case、日亏、
  市场集中度和流动性硬限制。

## Medium

### M-01 市场选择校验不足

引擎 `tracker/api-queue.ts` 倾向使用响应中的第一个 event/market；旧 override 也可能绕过
正常发现规则。必须校验系列、起止时间、token/outcome、可交易状态和流动性。

### M-02 多交易所 ticker 缺少逐源新鲜度

引擎 ticker 暴露价格但没有可靠逐值 timestamp；初始验证是共享状态，重连后旧值可能
继续存在。每个 provider 应独立输出 source/receive time、连接 epoch 和 health。

### M-03 开源引擎撤单先解除本地跟踪

引擎 lifecycle 在 API 撤单成功前 untrack；API 异常会让后续成交失去路由。应先记录
CancelIntent，收到交易所终态或对账结果后再结束跟踪。

### M-04 紧急退出不保证退出

引擎以 best bid 挂 GTC 卖单并循环，没有中央最大滑点、成交期限和明确的
not-canceled 处理。紧急退出应是受限状态机，不应被命名掩盖其非确定性。

### M-05 SQLite schema 与运行时迁移耦合

旧 `core/storage.py` 缺 FK、明确单位、order id 唯一约束和 fill 表，并在应用运行时做
迁移。研究数据知识可保留，但实盘 ledger 需要独立 schema/version/migration 流程。

### M-06 开源依赖声明和错误分类较弱

引擎源码使用 `viem`、builder signing 等依赖，但部分依靠传递依赖；生产 client 缺
直接测试，且 `getOrderById` 将多类异常压成 null、未知状态压成 cancelled。应锁定直接
依赖并定义 typed/transient/permanent/unknown 错误模型。

### M-07 大型模块提高变更风险

旧 `strategy/report.py`、`replay.py`、API handler、strategy main 以及引擎 lifecycle
承担过多职责。迁移应提炼契约和测试，不能整体复制。

### M-08 测试偏向正常路径，关键故障注入不足

旧项目在解析、策略、存储和报表方面测试较多，引擎在 sim 生命周期和已知 WS race
方面较强；但两边都缺少 submit unknown outcome、持久化各 crash point、磁盘满、认证
失败、长时间断线、订单事件全排列、孤儿单/持仓、live gate 负向矩阵等系统测试。
迁移时先将这些场景固化为 adapter contract、replay 和 shadow 验收门槛，不能用现有
happy-path 通过率推断适合实盘。

## Low

### L-01 旧 UI、Facade 和 dashboard 重复

多套 dashboard/API/Facade 增加配置和行为漂移，不属于交易核心。保持对照，不迁移。

### L-02 日志缺少统一关联标识

两边日志都没有贯穿 market/decision/risk/intent/order/fill/recovery 的 correlation id，
事故分析成本高。新审计事件应原生携带这些 ID。

### L-03 临时脚本和归档边界不清

旧 scratchpad、备份、AI `_tmp` 和 archive，以及引擎链上运维脚本，不应进入默认构建、
测试或部署路径。

## Unknown

### U-01 CLOB WebSocket 真实边界行为

当前官方 schema 已确认字段是 `price_changes`，所以旧 parser 的不兼容是确定问题，不再
属于 Unknown。仍未知的是线上乱序、重复、断线恢复、hash 变化、tick size change 和
大消息边界在目标账户/目标市场的真实分布；需在无凭据只读录制中形成脱敏 golden。

### U-02 当前手续费、最小 tick/size 和舍入规则

代码中存在多种 fee 口径。需通过官方接口、SDK 版本和真实但只读的市场元数据验证，
并固化按 market/token/version 的 golden cases。

### U-03 凭据暴露的实际状态

本阶段按要求没有打开 `.env`、配置值、数据库或钱包文件，因此只能确认“代码允许从
环境/TOML 读取凭据”的设计风险，不能也不应判断现有凭据是否有效或已泄露。

### U-04 参考项目完整测试的当前运行结果

旧项目强制 pure-Python fallback 的 108 项定向离线测试全部通过，但直接导入会因空
`rust_vol` namespace 触发 `AttributeError`。其余完整测试含外部数据依赖。开源引擎默认
套件含公网 API/WS 测试，本阶段没有安装依赖或运行；因此完整通过率、平台差异和 flaky
状态仍未知。

### U-05 SDK、链和交易所行为是否仍与代码一致

两项目锁定版本和协议实现可能已过时；生产评估前需在无凭据、无下单的 contract
环境核对官方 SDK/API、签名模式、状态枚举和 rate limits。尤其要验证引擎硬编码的
`signatureType:1` 与目标账户类型是否一致。

### U-06 法律、账户和运营约束

代码审计不能替代所在司法辖区、账户资格、税务和平台条款评估；这些条件会影响是否
允许部署实盘，但不改变默认关闭和技术风控要求。

### U-07 Chainlink/Polymarket 价格在网络与结算中的实际可得延迟

官方 RTDS 已说明顶层 `timestamp` 是消息发送时刻、`payload.timestamp` 是源价格时刻；
旧实现保留 payload source time 的方向正确，引擎仅用顶层时刻不够。仍未知的是目标机器、
网络和五分钟边界的 receive latency 分布。需同时保存两个官方时刻与本地 receive/process/
persist 时刻，再以历史延迟分布做压力测试。

## 阻断实盘的最低条件

在以下事项全部关闭前，不应把任何 adapter 切换到真实提交：

1. C-01 至 C-10 有回归测试并修复。
2. 幂等 OrderIntent、fill ledger、事件日志和全账户恢复对账完成。
3. 四时钟、订单簿 gap/stale 和用户 WS health 被中央风控强制。
4. PnL/fee 与官方只读账户数据完成逐 fill 对账。
5. live gate 的负向组合、崩溃点、部分成交全排列和 emergency-exit 测试通过。
6. shadow 运行达到预定观察期且没有未解释状态差异。
7. `LIVE_TRADING_ENABLED=false` 仍是仓库、示例、测试和部署模板的默认值。
