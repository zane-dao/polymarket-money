# Batch 4A-MVP Reuse Gate

> Batch 4B update (read-only): this register remains the authoritative reuse decision for
> the multi-edge observers. No code or dependency was added by this update. The requested
> `~/projects/polymarket-paper` and `~/projects/polymarket-trade-engine` paths are absent
> in this WSL workspace; the engine was found at `/root/projects/olymarket-trade-engine`
> (directory name is missing the initial `p`). The old project was therefore not available
> for a fresh filesystem scan and prior findings are retained as unverified references.

状态：**通过，但附带整改条件**  
审计日期：2026-07-16  
主项目基线：`d00c12b250e836368a3153869a9488f1edbe684f`（`batch-3b-accepted`）  
4A 草稿审计点：`3361c07a9b50435c86e8e4a5dd1be35effa9c873`  
旧项目：`d08ba3e591617e45b2463777afc6ec64a3ad1a46`  
开源引擎：`eda6759323b1b4cdb3559ca97876436c8fc231fd`

## 结论

Batch 4A 不建立第二套回放、成交、PnL、订单簿、公共 WebSocket、raw writer 或
manifest 路径。`3361c07` 中独立实现的连续 WebSocket 循环必须整改为调用现有
`capturePublicSocket`；纸面模式不得建立另一套有状态账本或声称真实成交。旧项目和开源
引擎均不复制代码。官方 CLOB SDK 带有签名和下单能力，本批只作为协议参考，不安装、
不实例化。

## 逐项登记

| 功能 | polymarket-money 现有实现 | polymarket-paper 对应文件 | polymarket-trade-engine 对应文件 | 可用成熟库或官方 SDK | 最终决定 | 决定理由 | 风险 | 验证测试 | 来源 commit | 许可证注意事项 |
|---|---|---|---|---|---|---|---|---|---|---|
| CLI | `research/polymarket_money/cli.py` 的 `poly-lab` 草稿；已有各批脚本使用 `argparse` | `dashboard.py`、`strategy/replay.py`、`strategy/report.py` | `index.ts`；依赖 `commander` | Python `argparse` 标准库；Click 8.1.8 已装但项目未依赖 | USE_MATURE_LIBRARY | `argparse` 已满足固定子命令和无额外运行依赖；不引入第二个 CLI 框架 | 参数在 Python/Node 边界漂移 | CLI help、每个子命令的离线调用、未知参数失败 | current `3361c07`; CPython 3.14.4 | CPython PSF License；不复制参考项目 CLI |
| 历史 replay | `backtest.py::ReplayEngine`、`ReplayClock`、`Strategy`、`ExecutionModel`；仅接受已发布 normalized dataset | `strategy/replay.py`（与旧配置、SQLite、旧策略强耦合） | 无等价因果回放；`scripts/chart.ts` 只解析日志 | 无库能替代本项目 point-in-time 合同 | REUSE_CURRENT | Batch 3A 回放是后续研究唯一裁判，已固定 dataset hash、因果时间和 acceptance policy | CLI 包装可能绕过 clean/hash gate | 同输入 replay hash 一致；与 Batch 3A fixture 结果一致；脏数据拒绝 | current `d00c12b` | 主项目一方代码；旧项目无许可证文件，禁止复制 |
| 实时 monitor | `public-sources.ts::capturePublicSocket`、`book-state.ts`、`raw-segment.ts`；4A 草稿另有循环，尚未接受 | `market/service.py`、`market/feeds/*`、`dashboard.py` | `tracker/orderbook.ts`、`tracker/ticker.ts`、`utils/terminal.ts` | Node 24 WHATWG `WebSocket`/`fetch`；Rich 可做终端渲染 | REUSE_CURRENT | 连接、时间戳、审计、字节上限已经在当前适配器；只扩展协调与展示 | 草稿第二套 socket 路径；公开端点协议变化 | monitor 默认不写 raw；断线/stale/snapshot/continuity 展示；无凭据测试 | current `d00c12b`, draft `3361c07` | Node.js MIT；Rich MIT；不复制旧/开源代码 |
| paper simulation | `ExecutionModel`、`FeeModel`、`FillLedger`、领域 `Decision/OrderIntent/Fill`；4A 观察器草稿 | `order/trader.py`、`strategy/main.py`、`strategy/settlement.py` | `engine/strategy/simulation.ts`、`engine/user-channel.ts`、`engine/wallet-tracker.ts` | Python `decimal.Decimal` 可做确定性金额计算 | REUSE_CURRENT | 成交、费用、部分成交和 PnL 只能由 Batch 3A/1 组件计算；新增代码仅产生观察或理论 intent/audit | 把盘口触达误称真实 fill；maker 伪造 queue | maker 零 fill；taker 标为 `THEORETICAL_FILL`；无法创建 live client；账本测试全过 | current `d00c12b`, draft `3361c07` | 旧项目无许可证；开源引擎虽为 MIT，但其模拟与生产上下文混合，禁止复制 |
| 市场发现和五分钟轮换 | `market_identity.py`、`normalized.py`；TS `fetchPublicGammaMarket` | `market/feeds/polymarket.py`、`market/service.py` | `utils/slot.ts`、`engine/market-lifecycle.ts` | Polymarket Gamma API/官方市场文档 | REUSE_CURRENT | 当前实现已强制 BTC 5m 身份、Up/Down 映射和时间窗；轮换只做薄协调层 | Gamma 返回异常；本地时钟边界；错绑下一市场 | 当前/下一市场；整 5 分钟 UTC；错误 slug/token 拒绝；轮换不跨窗 | current `d00c12b` | 官方文档可引用；API 响应不是可复制源码 |
| CLOB/RTDS 连接 | `public-sources.ts` 的 credential-free capture plans 与 payload 校验 | `market/feeds/polymarket.py`、`market/feeds/rtds_chainlink.py` | `tracker/orderbook.ts` 只有 CLOB；无 RTDS 等价实现 | 官方 `real-time-data-client`; `clob-client-v2`; `py-clob-client-v2` | REUSE_CURRENT | 当前路径有边界、四时钟落盘和凭据扫描；官方交易 SDK 能力过宽且不提供本项目因果合同 | 端点/消息 schema 漂移；误引入签名/下单能力 | subscription 精确匹配；凭据字段拒绝；帧/字节/时间上限；离线 fake socket | current `d00c12b` | 官方三个客户端均 MIT；本批不复制、不安装、不实例化 CLOB 交易客户端 |
| WebSocket 重连与 heartbeat | `capturePublicSocket` 已有 heartbeat、timeout、frame/byte bounds、close/audit；需在同一路径增加有限重连协调 | `core/miniws.py` 自写 RFC6455 | `utils/reconnecting-ws.ts` | Node 24 WebSocket；官方 RTDS 客户端可参考协议 | REUSE_CURRENT | 不接受草稿自建 socket manager；扩展当前 bounded capture，保持一个活跃路径 | 重连风暴、重复订阅、heartbeat 语义因端点不同 | fake socket 重连、退避上限、单订阅、heartbeat、有界优雅退出 | current `d00c12b`, draft `3361c07` | Node MIT；旧项目无许可证；开源引擎 MIT 但仅参考行为 |
| 订单簿状态 | `book-state.ts::PublicOrderBook`，含 snapshot/delta、sequence、stale、quarantine、top depth | `market/feeds/polymarket.py::apply_book_message` | `tracker/orderbook.ts`、`utils/price-level-map.ts` | 无通用库能替代 Polymarket 消息语义 | REUSE_CURRENT | Batch 2 已把连续性保留为 `UNVERIFIED` 并实现空侧不可交易，不能旁路 | 丢增量、乱序、空侧 midpoint、价格精度 | snapshot 前 delta 隔离；空侧无 midpoint/fill；sequence gap/stale 测试 | current `d00c12b` | 主项目一方代码；开源实现 MIT 仅对照 |
| 原始数据 writer | `storage/raw-segment.ts::RawSegmentWriter`，单写者、Linux FS、段关闭统计 | `recorder.py`、`core/storage.py` | `engine/logger.ts` 仅 NDJSON 日志 | Node `fs`/streams；`zlib` gzip | REUSE_CURRENT | 已有 append-only、限制和时间字段；只增加运行时协调、压缩统计和 exact reserve | 崩溃留下 open segment；压缩后双份占空间；跨进程写入 | duration/max-bytes/10GiB reserve；`/mnt/d` 拒绝；closed segment hash/count | current `d00c12b`, draft `3361c07` | Node MIT；不复制旧 writer |
| manifest/checksum | `raw-segment.ts::DatasetManifestWriter`、SHA-256、canonical JSON；Python `replay.py` 验证 | 无统一 manifest；部分文件自定义 | 无 dataset manifest | Node `crypto`、Python `hashlib` 标准库 | REUSE_CURRENT | Batch 2/2.5 已定义发布和校验合同；扩展 source allowlist 也必须沿用同一 writer/verifier | 新 stream 未在 allowlist；压缩文件与 manifest 不一致 | tamper、未知 source/config、空段、SHA/事件数、重放验证 | current `d00c12b` | 标准库许可证随运行时；manifest schema 属主项目 |
| storage report | 4A `runtime.py` 草稿使用 `statvfs`、`df`、`findmnt` 并保持只读 | 无独立可信存储评估 | 无 | Python `os.statvfs`、Linux `df/findmnt`、PowerShell 只读查询 | USE_MATURE_LIBRARY | OS/标准库是文件系统类型和容量的权威来源，无需自造探测库 | WSL ext4 虚拟容量掩盖 D 盘物理上限；DrvFS 不可信 | fixture mount 表；D/WSL 只读；物理盘映射；安全容量计算 | draft `3361c07`; CPython 3.14.4 | PSF License；Linux 工具按发行版许可证，仅执行不分发 |
| terminal dashboard | 4A 草稿当前为自写 ANSI/JSON 输出，尚未接受 | `dashboard.py` 是浏览器 HTTP UI | `utils/terminal.ts`、`utils/orderbook-table.ts` 自写 ANSI | Rich 13.9.4（MIT） | USE_MATURE_LIBRARY | 需求是简单可靠的终端面板，Rich 已安装且提供 Live/Table；不建浏览器前端 | 未写入项目依赖会破坏干净安装；高刷新率闪烁 | 非 TTY fallback；固定快照渲染；30 分钟内存稳定；clean install | Rich audit HEAD `9d8f9a372cc5916fd4781fec207ced7ddac2f08f` | Rich MIT；加入依赖时锁定兼容版本并保留 NOTICE 信息 |
| 日志和配置 | 安全配置/CLI 参数；`LIVE_TRADING_ENABLED=false`；4A 尚无统一结构日志 | `core/config.py`、`strategy/strategylog.py` | `utils/config.ts`、`engine/log.ts`、`engine/logger.ts` | Python `logging`/`tomllib`/`argparse`; Node `console`/JSON | USE_MATURE_LIBRARY | 标准库足够；敏感配置不得进入 monitor/paper；不引入 dotenv 或 PROD/FORCE_PROD | 配置漂移；日志误带环境变量；Python/Node 参数不一致 | 默认值快照；冲突开关拒绝；日志脱敏；metrics schema 测试 | current `d00c12b`; CPython 3.14.4/Node 24.18.0 | PSF/Node MIT；旧/开源配置仅参考，不复制生产开关 |
| 策略插件接口 | `backtest.py::Strategy` Protocol 与 `StrategyOutput`；4A CLI 插件加载草稿 | `strategy/signal.py`、`strategy/main.py` 与全局配置/服务耦合 | `engine/strategy/types.ts` 上下文可下单并用系统时间 | Python `importlib` 标准库 | REUSE_CURRENT | 当前纯策略接口已受 point-in-time view 和统一 OrderIntent 约束；插件只是加载该接口 | 任意插件模块导入时执行副作用；版本不兼容 | 恶意/错误插件拒绝；纯函数边界；NO_TRADE hash 固定 | current `d00c12b`, draft `3361c07` | 主项目一方代码；第三方插件许可证另审 |
| simulated fill/PnL | `ExecutionModel`、`FeeModel`、`FillLedger`、settlement/PnL 黄金测试 | `order/trader.py::trade_pnl`、`strategy/replay.py` | `engine/market-lifecycle.ts`、`engine/wallet-tracker.ts`、`engine/user-channel.ts` | Python `decimal.Decimal` 标准库 | REUSE_CURRENT | 已覆盖 bid/ask、延迟、深度、部分成交、费用、去重和结算；任何第二套计算都会造成口径漂移 | 观察 edge 被误记为 PnL；理论 fill 污染真实 ledger | Batch 1 黄金测试；Batch 3A replay；fees/partial/no-fill/dedup；标记 theoretical | current `d00c12b` | 主项目一方代码；开源引擎 MIT 但明确禁止复制其部分成交/恢复实现 |

## 来源与许可证核对

- `polymarket-paper` 在审计范围内未发现 LICENSE/COPYING 文件，因此其代码按许可证未知处理：
  只读、只提炼业务问题和测试思想，不复制。
- `polymarket-trade-engine` 的 `LICENSE` 为 MIT；即便许可证允许，生产开关、订单恢复、
  User Channel、部分成交和模拟策略仍因领域合同不兼容而只作对照。
- Polymarket 官方仓库审计 HEAD：
  - `py-clob-client-v2`: `fdb2590dc85e600ad98f1f668ea62a0627554d73`（MIT）
  - `clob-client-v2`: `ff5913f83132a141e01d403e505b6ccc003aa0f7`（MIT）
  - `real-time-data-client`: `c937d9c11cdd2b771aa4818392a1b6dda65c25de`（MIT）
- 官方 SDK 只用于确认公开端点、订阅格式和消息含义。本批没有依赖它们，也没有创建
  CLOB client、签名器、User Channel 或凭据对象。
- Rich 当前环境版本为 13.9.4、MIT；如用于交付，必须加入项目声明并通过干净环境安装。
- Python 标准库按 PSF License；Node.js 标准能力按 Node.js 许可证（MIT）使用。

## 4A 实施约束

1. `scripts/live-runtime.ts` 不得保留独立的 WebSocket 建连、订阅、heartbeat 实现；它只能
   编排 `capturePublicSocket` 与现有适配器。
2. paper observer 可计算 Polymarket 特有机会、理论 intent、spread、markout、adverse
   selection 和成交上下界，但不得维护第二本账或计算另一套已实现的成交/PnL。
3. raw capture 必须继续由 `RawSegmentWriter` 和 `DatasetManifestWriter` 发布；不得写另一种
   无法由当前 verifier 校验的“临时 manifest”。
4. terminal dashboard 使用 Rich；非 TTY 和机器消费场景保留同一 snapshot 的 JSON 输出，
   这只是展示差异，不是第二条数据路径。
5. Reuse Gate 只允许以上表格中的最终决定；后续若改变决定，必须先更新本登记表和测试。

## Batch 4B-R1 收口（2026-07-16）

R1 不改变 replay、point-in-time dataset、order-book state、manifest、FillLedger 或 safety
config 的 `REUSE_CURRENT` 决定。以下是 Critical 整改后的唯一活跃路径：

| 能力 | 唯一活跃实现 | 决定 | 被停用/只读路径 | 保护证据 |
|---|---|---|---|---|
| receive time | `ReceiveClock` / `ReceiveStamp` | REUSE_CURRENT | wall/provider time 不参与亚秒排序 | `receive-time-r1.test.ts` |
| raw writer | `RawSegmentWriter` 写 raw-event-v2 | REUSE_CURRENT | raw-event-v1 只读、禁亚秒 | `runtime-wiring-r1.test.ts` |
| TS Decimal | 私有 `MoneyDecimal` wrapper，decimal.js 10.6.0 | USE_MATURE_LIBRARY | 手写 BigInt decimal 已移除 | `fee-edge-r1.test.ts` |
| fee/edge | TS `FeeEdgeCalculator` + Python `FeeModel` 的同一合同/fixture | REUSE_CURRENT | paper/opportunity 重复公式已停用 | TS/Python fee fixture |
| opportunity fact | `OpportunityObservationV1` | REUSE_CURRENT | 旧 `OpportunityRecord` 不作为 route verdict | `opportunity-observation-r1.test.ts` |
| route verdict | `RouteEvaluationV1` | REUSE_CURRENT | 单条 observation 无 candidate 字段 | decision 固定 DATA_INSUFFICIENT |
| cross-venue | 一个 `LeadLagEngine`，runtime/replay 共用 as-of | REUSE_CURRENT | adjacent spot / fixed 5bp observer 不在 live runtime | `lead-lag-r1.test.ts` |
| incident | `RuntimeIncidentV1` + `FailClosedRuntime` | REUSE_CURRENT | 空 catch/递归 writer retry 被禁止 | `runtime-incidents-r1.test.ts` |

参考项目仍只读；R1 没有复制交易引擎、安装 CLOB 交易 SDK、建立 User Channel、签名器、订单
恢复、第二 monitor、第二 replay、第二 order book、第二 raw writer 或第二 ledger。

## 参考入口

- [Polymarket 官方仓库列表](https://github.com/orgs/Polymarket/repositories)
- [Polymarket RTDS 文档](https://docs.polymarket.com/market-data/websocket/rtds)
- [Polymarket Market Channel 文档](https://docs.polymarket.com/market-data/websocket/market-channel)
- [Rich 官方文档](https://rich.readthedocs.io/)
