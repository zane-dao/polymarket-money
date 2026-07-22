# Paper Session 后端

本目录承载 paper-only 会话、模拟执行和公开行情宿主边界。

## Web 运行证据

`runtime-evidence.ts` 是 Web 工作台专用的后端证据仓。Web 组合层观察公开 Paper host 的连接、
缺口、错误、快照时间和 Paper 结算失败；证据保存在数据根
`workbench/paper-runtime-evidence/state.json`，不进入代码仓，也不会把路径返回前端。
状态最多保留 500 条记录，使用逐条哈希链、整体状态哈希和原子替换；读取时发现篡改会拒绝
健康/异常查询，不能把损坏证据静默当成健康。

`get-system-health` 与 `list-system-incidents` 在 Web Server 组合层读取该仓。快照延迟以持久样本
的 p95 信息事件公开，连接中断、gap、host error 和结算失败作为真实 incident 公开；DTO 仍经过
`BackendQueryService` 的字段和路径泄漏校验。桌面 Tauri/Rust 生命周期不依赖该模块。

修改证据类型、上限或恢复规则时，必须同步恢复、篡改、分页测试。不得在证据中保存原始盘口、
认证数据、文件路径、异常堆栈或任意网络响应。

- `host.ts`：caller-managed 的内存行情宿主；只有调用方显式 `start()` 才会启动 feed。
- `public-clob-feed.ts`：单个 BTC 五分钟市场的无认证公开 feed。它只使用 Gamma 市场发现、
  CLOB REST order book 与 CLOB **market** WebSocket，不包含 user channel、认证、钱包、签名或下单。
- `public-binance-feed.ts`：无认证 Binance Spot `btcusdt@bookTicker` feed；构造无 I/O，断连立即
  清空最近值，旧连接帧不能复用。
- `public-btc-feed.ts`：组合 CLOB 与 Binance；只有两源均连接且 Binance 信号新鲜时才向 Paper host
  发布可执行盘口。公开工厂返回自动轮换包装层：从初始 `btc-updown-5m-<epoch>` 解析对齐的
  五分钟序列，在边界先失效旧 generation、停止旧 feed，再启动下一 slug。迟到的旧连接回调会被
  丢弃；启动失败把 host 标为 `DEGRADED`，仅按有限重试表重试，耗尽后等待下一市场边界。
- `service.ts`：Paper 会话生命周期与持久化接口。
- `kj-execution-coordinator.ts`：把 K/J 的显式、可审计 execution proposal 协调到通用
  Paper session；它不读取行情，也不启动网络。
- `official-settlement-coordinator.ts`：把现有 `gamma-resolution-adapter-v1` 验证通过的官方
  Gamma 终局证据应用到 J/K 两个 canonical Paper session。它严格绑定 market、condition、
  slug、五分钟窗口和 UP/DOWN token，使用独立的 hash-linked outbox 做幂等恢复；不会调用或伪装
  `MANUAL_PAPER_TEST`。

会话层接受兼容的 `PaperOrderRequestV1` 和证据绑定的 `PaperOrderRequestV2`，但新增自动策略
只能提交 V2。手续费模型、逐档费用、舍入和平局拒绝由 `backend/paper-simulation` 统一负责；
会话层不得自行重算费用。每次提交后，会话把完整模拟状态和幂等映射原子写入
`workbench/paper-sessions/<sessionId>.json`，进程恢复后重放相同的 V2 请求不会重复成交。

## K/J canonical 执行协调

`KJPaperExecutionCoordinator` 要求调用方为 `J_FEE_AWARE` 和 `K_DUAL_VOL` 提供两个不同且
已经创建的 Paper session。两种策略的现金、风险、订单和仓位因此完全隔离；协调器不会使用
旧 K/J 引擎的 shadow wallet 作为 canonical 余额。

输入可以是严格的 `KJExecutionProposalV1`，也可以用 `kjExecutionProposalFromEvents` 将同一
策略、市场和 `intentId` 的 K/J `INTENT` 与 `FILL` 事件转换成 proposal。旧 K/J 的 `FILL`
在这里仅表示候选执行 proposal，最终是否拒绝、成交多少以及扣除多少费用，全部由
`PaperSessionService` 决定。

每个 proposal 固定转换为：

- `PaperOrderRequestV2`，禁止使用 V1 或猜测费用；
- `FAK`，剩余数量不会伪装成持续挂单；
- `UP → YES`、`DOWN → NO`；
- 稳定幂等键 `kjexec:v1:<strategy>:<intentId>`；
- DOWN 的 `modelProbabilityYes` 使用 `1 - sideProbability`。

协调器在提交订单前先把 `PENDING` link 追加到 hash-linked outbox，Paper session 原子保存订单
后再追加 `SUBMITTED` link。文件实现位于
`workbench/paper-sessions/kj-execution-links.jsonl`，每条记录包含前一条 hash 并在 append 后
执行 `fsync`。如果进程在 Paper submit 成功、终态 link 落盘前退出，恢复会用完全相同的 V2
请求重放；Paper session 在查询行情前先检查持久化幂等映射，因此即使行情 adapter 暂时不可用，
也只会返回原订单，不会重复成交。

`SUBMITTED` 表示请求已经交给 canonical Paper 引擎，并不等于成交；必须继续检查
`paperOrderStatus` 与 `rejectionReason`。Kill Switch、edge、现金、敞口、费用证据和部分成交
都以 canonical Paper 结果为准。

## 官方 Gamma 自动结算

`OfficialGammaPaperSettlementCoordinator` 只接受公开、只读 Gamma source。调用
`settleFromPublicGamma` 必须逐次传入 `explicitNetworkApproval=true`；没有批准时在调用 source
之前拒绝，因此不会发生隐式联网。离线或已有调用方也可以把冻结的 `GammaResolutionInput`
交给 `applyGamma`，但仍必须通过现有 `createKJOfficialSettlementFromGamma` 的完整校验。

以下情况一律保持 canonical Paper 仓位未结算：市场尚未关闭、UMA 状态未 resolved、赢家不唯一、
价格不是精确 0/1、market/condition/slug/token/五分钟窗口冲突，或证据到达时间不在市场结束之后。
官方赢家仅按 `UP → YES`、`DOWN → NO` 映射，并分别调用 J/K canonical session 的既有 Paper
settlement。outbox 先持久化 `PENDING` 官方证据，再应用两个 session，最后持久化 `APPLIED`；若在
Paper 已保存而终态 acknowledgement 未保存时崩溃，恢复会重放同一个赢家，依靠 Paper settlement
幂等性避免重复派彩。任何相同市场的不同证据指纹或不同赢家都会 fail-closed。

文件 outbox 位于 `workbench/paper-sessions/kj-official-settlement-links.jsonl`，只保存严格市场绑定、
官方 settlement ID、Gamma payload SHA-256 引用和 canonical Paper 结果，不保存凭据。测试必须注入
`PublicGammaResolutionSource` 并使用冻结 Gamma fixture；不得在单元测试中访问公网。

## Desktop 自动账户默认值

`scripts/paper-market-host.ts` 只有在显式批准并成功启动公开只读 feed 后，才创建或恢复两个
固定 canonical 账户：

- J：`desktop-kj-j`
- K：`desktop-kj-k`

两者各自初始模拟资金为 `10000`，默认风险为：报价最大年龄 `15000 ms`、最小净 edge
`0.05`、单笔最大名义金额 `400`、单市场最大敞口 `400`、总敞口 `4000`。这些值定义在
`DESKTOP_KJ_INITIAL_CASH` 与 `DESKTOP_KJ_RISK` 常量中；修改常量时必须同步本节以及离线
host 恢复测试。已存在账户不会因常量修改而被重置或覆盖。

Desktop 启动顺序为：启动调用方已批准的只读 feed、恢复全局 Kill Switch 和 canonical
sessions、恢复 execution outbox、恢复 K/J journal context 与手续费证据、重新协调尚未完成的
proposal，最后才对外报告 strategy runtime。每个新 context 严格串行执行 journal append 后再
扫描新增 `INTENT/FILL`；内存 cursor 只用于减少重复扫描，durable intent 幂等与 outbox 才是
重启后的去重权威。

`paper-strategy-runtime-v2` 明确返回 `executionAuthority=PAPER_SESSION`、两个 canonical session
状态和 execution links。旧 K/J snapshot/events 只位于 `shadow`，且
`nonAuthoritative=true`；前端不得把 shadow wallet 或 shadow FILL 用作余额、PnL 或成交统计。

桌面长期运行入口为 `scripts/paper-market-host.ts`，由 Rust/Tauri 持有唯一子进程，通过闭合的
逐行 JSON 协议调用。`start-paper-session` 不会隐式启动网络；只有
`start_public_paper_market_host_v1` 且 `explicitNetworkApproval=true` 才会执行公开 I/O。订单提交、
撤单、重新报价、到期、手工 Paper 测试结算和完整账本查询均在同一 host 进程中执行并持久化。

Web 长期 host 收到每个新的公开只读盘口快照后，会把同市场的开放 GTC/GTD 订单按创建顺序
重新撮合；同一快照的档位数量会逐笔扣减，不能被多个订单重复使用。开放订单的原始请求（包括
V2 手续费证据）随 session 一起持久化，因此重启后仍能继续撮合并保持 idempotency key 语义；
旧状态若缺少请求证据则以 `RECOVERY_REQUEST_MISSING` 撤单，不能猜测执行。独立的每秒本地时钟
负责在没有新快照时也将 GTD 标记为 `EXPIRED`。过期、陈旧/未来盘口、不合资格市场、无盘口、
Kill Switch 或当前时刻无法验证的 V2 手续费证据都不会产生模拟成交。以上行为仅更新 Paper
账本，不存在钱包、签名、私有用户通道或真实订单 adapter。

同一长期 host 会在已批准的 `start-public-feed` 会话内，根据每个严格 K/J context 的
`intervalEnd` 调度官方 Gamma 结算查询；市场结束前不会请求。未结束或暂未 resolved 的响应采用
有限退避，耗尽后保持未结算和 `DEGRADED`，不会无限重试。`stop-public-feed` 与 `close()` 会先
失效结算 generation、取消全部待执行 timer，再等待已开始的查询返回；迟到响应不能在停止后应用
到 canonical session。host 重启时先恢复 official settlement outbox 中的 `PENDING` 记录，恢复过程
只重放本地 Paper settlement，不会绕过新的联网批准发出 Gamma 请求。结算结果可通过既有
`get-paper-session-detail` 查看 J/K session 的 `settlements`，无需向前端暴露原始 Gamma payload。

`PublicClobPaperMarketFeed` 构造时不联网。调用方必须传入精确的
`btc-updown-5m-<epoch>` slug，并在已取得联网采集批准后显式调用 `start()`。测试应注入
`PublicClobFeedRuntime`，使用冻结 HTTP/WebSocket fixture，不访问公网。修改 feed 时必须保留
公开端点 allowlist、注入式网络边界、PING/PONG、abort/stop 和断连 fail-closed 测试；不得在本目录
加入凭据字段或真实交易方法。

自动轮换同样保持构造无 I/O，只有显式 `start()` 才会创建单市场 feed。测试轮换时应注入
`PublicBtcFeedFactory`、时钟和 timer，禁止等待真实五分钟或访问公网；任何显式 `stop()` 都必须
取消边界/重试 timer、停止当前 feed，并保证之后不再自动启动新市场。
