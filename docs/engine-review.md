# 开源引擎深度评估

## 1. 范围和结论

- 逻辑名称：`polymarket-trade-engine`
- 实际只读目录：`/root/projects/olymarket-trade-engine`（目录名缺开头的 `p`）
- 审计提交：`eda6759323b1b4cdb3559ca97876436c8fc231fd`
- 包名：`early-bird-engine`，TypeScript/Bun，依赖 `@polymarket/clob-client-v2`。
- 本阶段没有重命名目录、安装依赖、读取凭据、运行入口或访问实盘。

总评：该项目比旧项目更完整地表达了 market lifecycle、全档订单簿、用户订单频道、
撤单和部分成交场景，但运行时仍不适合实盘。可采用的是协议场景、脱敏 fixtures、少数
纯数据结构，以及在新项目 adapter 后调用官方 SDK 的思路；不能复制其主引擎、钱包
账本、PnL、恢复和生产门禁作为交易真相。

## 2. 当前官方协议兼容性

| 项目 | 当前实现 | 官方当前要求/语义 | 结论 |
|---|---|---|---|
| 公共 market WS | `tracker/orderbook.ts` 使用 `price_changes`，结构大致匹配 | 当前 market channel 使用 `price_changes[]`，并给出 timestamp/hash/market；连接需要心跳 | parser 比旧项目新，但缺时间、hash、PING、gap/resync 和 stale gate |
| 用户 WS endpoint | `engine/user-channel.ts:209-210` 使用 `ws-subscriptions-frontend-clob...` | 当前文档 endpoint 为 `wss://ws-subscriptions-clob.polymarket.com/ws/user` | 不是当前官方 endpoint，兼容性未证明，不得依赖 |
| 用户 trade 状态 | 只处理 MATCHED/MINED | 当前状态含 MATCHED、MINED、CONFIRMED、RETRYING、FAILED | MINED 后仍可能继续变化；FAILED/RETRYING 无处理，状态机不完整 |
| 订单类型 | domain 主要暴露 GTC/FOK | 当前支持 GTC、FOK、GTD、FAK | 功能不完整，需统一 domain 映射 |
| 签名 | `engine/client.ts:380-394` 永远 `signatureType=1` | EOA/proxy/Safe/POLY_1271 等账户类型必须匹配 | 非 proxy 账户可能签错，必须显式建模 |
| order version | 内部调用 builder，硬传 version 2 | 当前 SDK/市场可能使用新 order version/tick size；应查 market info | 对 V3/新市场不能证明兼容 |
| negRisk | `market-lifecycle.ts:711-717` 硬编码 false | 每个订单需使用该市场的实际 negRisk/tick size | 可能签名或订单参数错误 |
| fee | 生命周期局部硬编码/仅 FOK 计 fee | 当前 fee 按市场和实际 taker fill 计算 | 会漏掉 marketable GTC 等 taker fee |
| BTC 5m 结算 | `closePrice > openPrice` | 当前规则是 `close >= open` 为 Up，且使用 Chainlink BTC/USD | 平局标签错误 |

官方依据：

- [Market Channel](https://docs.polymarket.com/market-data/websocket/market-channel)
- [User Channel](https://docs.polymarket.com/market-data/websocket/user-channel)
- [Order lifecycle](https://docs.polymarket.com/concepts/order-lifecycle)
- [Create Orders](https://docs.polymarket.com/trading/orders/create)
- [Fees](https://docs.polymarket.com/trading/fees)
- [BTC 5m 当前规则示例](https://polymarket.com/event/btc-updown-5m-1779220200)

仓库固定的 `clob-client-v2 1.0.2` 落后于审计时官方 release；新项目不应复制
`engine/client.ts` 的 SDK 内部调用，而应锁定经验证版本，通过官方公共 API 和 market
info 做 conformance tests。版本更新记录见
[clob-client-v2 releases](https://github.com/Polymarket/clob-client-v2/releases)。

## 3. 18 项能力评估

### 3.1 市场发现

路径：`tracker/api-queue.ts:52-58`、`utils/slot.ts:42-75`、
`engine/market-lifecycle.ts:264-276`。

- 直接取 `events[0].markets[0]`，没有验证空结果、slug、区间、重复结果或系列。
- 直接假设 `clobTokenIds[0]=UP`、`[1]=DOWN`，虽然 API 同时提供 outcomes，却没有按
  outcome 名称配对。
- negRisk 和完整规则快照没有进入生命周期。
- 旧项目的标题/周期/token/流动性校验更完整。

结论：不能直接复用。保留 slot 工具和失败场景作对照，市场身份规则由新项目按旧知识
重构。

### 3.2 市场生命周期

路径：`engine/market-lifecycle.ts`、`engine/early-bird.ts`。

INIT/RUNNING/STOPPING/DONE 和订单过期场景比旧项目完整，但一个类同时拥有网络、
系统时钟、策略、风控、订单、钱包、PnL 和日志，无法确定性回放。`963-975` 又用严格
`>` 判断 Up，平局错误。

结论：仅迁移状态转换测试和脱敏事件序列；状态机由新项目以显式时钟重写。

### 3.3 CLOB 客户端

路径：`engine/client.ts`。

优点是覆盖签单、批量提交、查询、撤单、余额、兑换/赎回，比旧单笔 GTC 强。缺陷：

- 无确定性 clientOrderId/idempotency key；
- 错误分类弱，`getOrderById` 在 `455-470` 吞掉错误并返回 null；
- `417-424` 绕过 SDK 的高级 public API，手工固定 order version；
- signature type 固定为 proxy，negRisk 又在上层固定 false；
- 官方 SDK 默认可能返回 `{error,status}` 而非抛出；client 未启用 `throwOnError:true`，
  `getOrderById` 把错误对象归为 null，`cancelOrders` 却强制 cast 后访问字段；
- `viem`/builder signing 依赖部分依靠 transitive dependency。

结论：只允许在新 `ExecutionEngine` vendor adapter 内调用经过锁定和契约测试的官方 SDK；
不得让其类型进入 domain，也不直接复制本 client。

### 3.4 WebSocket 订单簿

路径：`tracker/orderbook.ts`、`tracker/reconnecting-ws.ts`、`PriceLevelMap`。

`PriceLevelMap` 和全档 fixture 比旧项目完整，`price_changes` 字段也与当前官方相符；但
实现没有 10 秒 PING、官方 timestamp/hash/market、sequence/gap、staleness、clock 和
resync。断线固定 1 秒重连并继续暴露旧 book；`waitForReady` 没有超时；某 token 的
tick_size 会被写给两个 token。

结论：`PriceLevelMap` 纯结构可评估直接迁移；连接器只能通过 adapter 重构，fixtures
可迁入 golden。

### 3.5 用户订单频道

路径：`engine/user-channel.ts`。

它有 trade-id 去重、maker/taker 分流和 REST 对账意图，是旧项目完全缺少的业务场景，
但它使用的不是当前官方 endpoint，兼容性没有得到证明；发送认证后立即宣告 ready，
而不是等待认证确认；解析和 socket
错误被吞；重连无 backoff；REST reconciliation 是 fire-and-forget。

更严重的是只认 MATCHED/MINED，不认 CONFIRMED/RETRYING/FAILED。当前官方 user
channel 状态语义见上表链接。

结论：不能复用运行时；迁移事件排列测试和脱敏 fixtures，新项目重写持久化事件归并器。

### 3.6 下单

路径：`engine/client.ts::postMultipleOrders`、
`market-lifecycle.ts::_placeWithRetry`。

比旧项目支持更多批量场景，但提交是 fire-and-forget；网络结果 unknown 时没有先查
order 再决定是否重试，按错误字符串调整 shares。无 idempotency key、持久 intent 和
outbox。

结论：官方 SDK 可通过适配层使用，重试/幂等/unknown outcome 由新项目维护。

### 3.7 撤单

路径：`client.ts::cancelOrder/cancelOrders`、`market-lifecycle.ts::_cancelOrders`。

比旧项目有真实撤单能力；但本地先 untrack，再调用 API。API 失败或 `not_canceled` 时本地
可能失去后续事件路由，也没有强制查询最终状态。

结论：迁移撤单竞态测试，适配器实现必须先持久化 intent 并以交易所对账收敛。

### 3.8 部分成交

路径：`engine/user-channel.ts:94-198`。

确定性反例：trade1 MATCHED → trade1 MINED → trade2 MATCHED。`_trySettle` 在第一笔 MINED
时只看“当前已关联集合”，立即 delete tracked 和 `onFilled`，第二笔永久丢失。现有测试
只覆盖两笔先 MATCHED、后 MINED 的顺序。外部 CANCELLATION 也直接失败回调，忽略已成交
部分。

此外槽结束时 `market-lifecycle.ts:405-423,492-504` 会排除正在 MATCHED→MINED 的订单，
却随即停止 user channel；后到成交丢失。

结论：Critical，不适合实盘。只迁移失败排列为测试，由新状态机按 exchange event 和
CONFIRMED finality 重建。

### 3.9 GTC/FOK/FAK/GTD

GTC/FOK 映射比旧项目强，但缺统一 FAK/GTD 支持。FOK fee/net shares 又与 lifecycle
硬耦合，GTC 跨价成为 taker 时会漏 fee。

结论：domain 应表达四类订单及精确 time-in-force 语义，adapter 做官方映射和契约测试。

### 3.10 紧急退出

路径：`market-lifecycle.ts:516-594`。

所谓 emergency sell 只取消已知 pending SELL，再按可能陈旧的 best bid 挂 2 秒 GTC；
不是 FOK/FAK，没有最大滑点，`not_canceled` 后不收敛，也发现不了账外持仓。

结论：流程意图可作测试，运行时实现废弃。新 emergency exit 仍需幂等、限价/滑点、
持仓对账和失败升级，不承诺一定成交。

### 3.11 仓位管理

路径：`engine/wallet-tracker.ts`、`engine/early-bird.ts:113-130`。

`WalletTracker` 是进程内乐观账本；启动只取 collateral，不重建 conditional token
positions。sell 使用 `Math.max(0, ...)` 掩盖负仓，而不是报告账本不变量破坏。

结论：不可作为实盘真相。Position/Balance 必须由 fill ledger 加 exchange/chain
reconciliation 得出。

### 3.12 PnL 计算

路径：`market-lifecycle.ts:603-629,946-978`、`wallet-tracker.ts`。

user trade 消息包含实际 price、fee_rate_bps 和 maker_orders 信息，实现却只上送成交
数量。PnL 使用委托价而非逐 fill 实际价；fee 主要只在 FOK 计算；恢复 fill 的 fee=0。

结论：会产生假 PnL。只保留场景，计算由新 fill-level double-entry ledger 完成。

### 3.13 状态持久化

路径：`engine/state.ts:29-37`、`engine/early-bird.ts:20,268-327`。

`early-bird.ts` 每 5 秒调用 `state.ts` 写 JSON snapshot；其原子 rename 是可参考的小技巧，
但没有 WAL/event journal、schema
version、checksum、durability watermark 和 idempotency key。文件缺失、损坏或版本不符
一律返回 null，调用方直接 “Starting fresh”。

结论：不能作为订单真相；只参考快照加速方式。

### 3.14 崩溃恢复

路径：`engine/recovery.ts`。

- `client.getOpenOrderIds` 存在但全项目不调用，不能枚举交易所孤儿单；
- `getOrderById` 的网络错误被等同为不存在；
- 恢复成交用请求 shares/price 和 fee=0；
- 有 orderHistory/持仓但没有 pending sell 时可直接跳过；
- 生产启动不加载 outcome positions。

结论：Critical。必须重写为 event journal + 全量 open order/recent fill/position/balance
对账，恢复完成前禁止新单。

### 3.15 多交易所行情

路径：`tracker/ticker.ts`。

覆盖 Binance/Coinbase/OKX/Bybit/Polymarket/Chainlink，比旧项目接口集中；但 `validated`
是所有源共享且只验证全进程第一条，部分 provider 无 source timestamp，断线保留旧值，
stale 只查首条。`isKillswitch` 没接到中央执行路径。

结论：保留 provider/分歧场景作对照；旧项目的时间/Chainlink 历史更可取，新项目自己
实现统一 feed health。

### 3.16 风险控制

现有能力主要是内存余额预检和 session loss。缺单笔/市场/每日上限、最大未成交单、
最大滑点、数据/WS stale、持久化健康、unknown outcome、幂等和中央 fail-closed；
`MAX_SESSION_LOSS` 还没有 schema/NaN 检查。

结论：与旧项目一样不足。由新项目自建中央 RiskEngine，任何 adapter/API/恢复路径
不得绕过。

### 3.17 测试覆盖

优点：fixture runner、订单簿和生命周期场景比旧项目丰富。问题：

- sim 只看最优一档并整单成交，不模拟队列、多档、部分成交、冲击、拒单和真实延迟；
- fixture runner 把 sim/balance delay 设为零；
- `docs/GUIDE.md:512` 声称模拟能“精确处理部分成交”，与整单 fill 源码矛盾；
- 默认 `bun test` 含真实公网集成测试，当前阶段不能安全运行全套；
- CI 只跑 tests，不单独跑 `tsc --noEmit`；
- 生产 client、recovery、prod gate、V3、user WS 重连、tie、实际 fee role 无充分测试；
- 部分成交的危险事件排列没有覆盖。

本阶段没有安装 Bun/Node 依赖，因此没有运行 engine tests。结论基于静态代码、已有测试
和官方协议对照。

### 3.18 配置和密钥管理

`.gitignore` 忽略 `.env` 且 sample 没有秘密值是优点；但凭据仍来自平面进程环境，账户
签名类型硬编码，配置缺 schema 和版本。

`engine/client.ts:516-531` 的 relayer 路径还固定 `RelayerTxType.PROXY`；当前新 deposit
wallet/POLY_1271 账户需要按账户能力选择 WALLET 流程。builder credentials 虽在构造器
要求，初始化 CLOB client 时又没有以明确 builder config 传入，职责边界含混。

Critical 门禁错误：`index.ts:63-84` 只有 `--prod` 且 `FORCE_PROD!==true` 时才设置
`process.env.PROD=true`；`index.ts:87-93` 和 `engine/early-bird.ts:46-65` 却按
`opts.prod` 构造真实 client。因此 `FORCE_PROD=true --prod` 会真实连接，而
`strategy/simulation.ts:19-32` 和 `late-entry.ts:408-421` 依赖 `Env.PROD` 的内置保护会被
绕过。默认策略恰好是 simulation。项目也没有 `LIVE_TRADING_ENABLED`。

结论：该门禁不可复用。新项目默认 `LIVE_TRADING_ENABLED=false`，研究/CI 甚至不注入
真实 adapter。

## 4. 最高风险问题

### Critical

1. `FORCE_PROD`/`PROD` 双真相可构造真实 client 却绕过策略保护。
2. BTC 5m 平局判 Down，与官方规则相反，造成错标签、错 PnL 和错钱包。
3. 部分成交可因事件顺序提前 settle，后续 trade 永久丢失；槽结束又可能丢处理中的 fill。
4. 5 秒 snapshot、静默 fresh start 和不枚举 exchange open orders 会形成孤儿单/持仓。

### High

1. user WS 使用非当前官方 endpoint，状态语义不完整，并在 MINED 后过早完成本地订单。
2. 实际 fill price/fee role 被丢弃，PnL 用委托价且漏 marketable GTC taker fee。
3. SDK/order version/signature type/negRisk/tick size 硬编码，当前市场兼容性未获证明。
4. 下单无幂等；unknown response、撤单和外部取消无法可靠收敛。
5. 订单簿和多源价格缺连续性、新鲜度和时钟；断线继续暴露旧值。
6. emergency exit、WalletTracker、风险和日志均不足以保护实盘。

## 5. 采用建议

| 资产 | 建议 | 必须补的验证 |
|---|---|---|
| `PriceLevelMap` | 可评估直接迁移纯结构 | 精度、排序、重复 level、空 book property tests |
| 公共 WS parser/fixtures | 仅迁移测试和脱敏样本；运行时经 adapter 重写 | 当前官方 golden、PING、gap/resync、stale、四时钟 |
| CLOB SDK 能力 | 通过适配层使用，不复制内部 builder 调用 | 锁版本、账户类型、order version、tick/negRisk、错误矩阵 |
| user-channel fixtures | 仅迁移测试和脱敏样本 | 所有事件排列、CONFIRMED/FAILED、外部取消、重连对账 |
| lifecycle/GTC/FOK/撤单场景 | 保留作对照并迁移测试 | 虚拟时钟、unknown outcome、部分成交、槽边界 |
| state atomic rename | 保留作实现技巧 | journal/checksum/schema/crash-point 测试 |
| WalletTracker、PnL、recovery、emergency sell | 废弃运行时算法 | 由新 ledger/reconciliation/risk 重新实现 |
| market discovery | 不采用本实现 | 用旧规则重构，按 outcome/规则/时间/negRisk 验证 |
| prod/config gate | 废弃 | 双重显式门禁、结构性无 live adapter、负向测试 |

“通过适配层使用”不代表当前 engine 可直接实盘。它表示新项目拥有 domain、风控、
幂等、账本和恢复，只把经过 conformance test 的供应商调用封装在 adapter 内。
