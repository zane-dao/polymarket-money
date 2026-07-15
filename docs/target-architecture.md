# 目标架构建议

## 1. 结论与设计原则

`polymarket-money` 应当是业务真相和安全边界的唯一所有者。旧项目提供
BTC 5 分钟市场的业务经验与研究资产；开源引擎只通过适配层提供经过验证的
协议能力。不能把任一参考项目直接作为实盘主进程。

核心原则：

1. 默认且持续保持 `LIVE_TRADING_ENABLED=false`。
2. 领域模型、风控决定、订单意图、成交账本和恢复状态不依赖供应商 SDK。
3. 所有外部 I/O 只能出现在 adapter；策略是显式输入到显式输出的纯函数。
4. 每个交易决定都可由不可变输入、配置版本和策略版本确定性重放。
5. exchange truth 优先于本地快照；启动先恢复和对账，再允许产生新订单。
6. 下单、撤单和恢复必须以幂等键与持久事件日志为中心，不能以进程内回调为真相。
7. 行情、用户频道、系统时钟和持久化异常一律 fail closed。

### 1.1 新主项目当前状态（不是目标态）

| 当前文件/目录 | 已具备 | 仍缺失或不可信 |
|---|---|---|
| `execution/src/domain/index.ts` | 已有早期执行 domain；Batch 2 另有 versioned `raw-event.ts`，source/server 可空、raw decimal 保真；旧观察时钟和外部 price/size/fee 已收敛为明确时间及 decimal string | 仍缺货币/份额品牌类型、舍入政策与持久账本，现有接口不能冒充完成的交易 domain |
| `execution/src/adapters/execution-engine.ts` | 已定义 place/cancel/open orders/positions/emergency exit 边界 | 没有任何实现是当前安全优点；还缺 typed unknown outcome、order/fill event stream 和 reconciliation 契约 |
| `execution/src/strategy/index.ts` | Strategy 是显式输入到 SignalDecision 的函数类型，注释禁止 I/O/系统时间/全局状态 | 目前只有接口，尚无 lint/runtime sandbox、determinism/property test 或 artifact loader |
| `execution/src/risk/index.ts` | 已列带 USD/token/bps/ms 单位名的单笔、单市场、日亏、滑点、挂单、stale、WS 和幂等配置 | 数值仍是 placeholder；没有 RiskEngine 实现、配置 schema/invariant、cash reservation、VaR/CVaR 或 fail-closed 组合测试 |
| `execution/src/storage/`、`monitoring/` | Batch 2 已加入公共 raw JSONL writer、no-clobber segment、DatasetManifest 和 book health 基础 | 仍无订单 event journal、fill ledger、账户恢复或实盘健康状态机 |
| `research/polymarket_money/` | 第一批已建立 vendor-neutral Python domain、BTC 5m/Chainlink/tie/bid-ask 规则、fail-closed safety 和离线 fill ledger | 仅是内存黄金实现；尚无 point-in-time dataset、持久化、模型 artifact 或真实适配器 |
| `tests/`、`execution/tests/` | WSL Linux Node 下 TypeScript contract 可编译；30 项 Python unit/golden 测试覆盖安全、时间、Settlement 一致性、幂等与三个人工 PnL 市场；干净 venv 安装测试通过 | integration/replay/shadow 仍为空；不能证明协议、回测、恢复或实盘执行正确 |
| `package.json` / `pyproject.toml` | TypeScript 5.9 开发依赖；Python runtime dependencies 为空，第一批只用标准库；配置语法和包清单已有测试 | 尚未批准/锁定研究数据与统计库；没有供应链/license manifest |
| `.env.example` | 明确 live=false、dry-run=true、credential=none、authorization=false；Batch 1 live factory 永远拒绝 | 尚无持久授权、恢复、账户对账或真实 adapter；结构上不能下单 |

Batch 1 已固定为提交 `7f3c1c4` 和标签 `batch-1-accepted`；Batch 2 在独立分支
`batch/2-readonly-data` 实施。该基线不把离线模型误报成持久账本、回测或实盘能力。

## 2. 模块所有权

### 2.1 新主项目自行维护

以下能力必须由 `polymarket-money` 拥有：

| 能力 | 建议位置 | 原因 |
|---|---|---|
| 供应商无关领域模型和四时钟 | `execution/src/domain/` | 保证研究、回放、shadow 和实盘使用同一语义 |
| 订单意图、幂等键与订单状态机 | `execution/src/domain/`、`storage/` | 防止网络结果不明和崩溃导致重复订单 |
| 中央 RiskEngine | `execution/src/risk/` | 所有执行路径，包括手工和恢复路径，都必须经过同一门禁 |
| 纯函数策略契约 | `execution/src/strategy/` | 禁止隐式网络、数据库、环境变量、当前时间和全局状态 |
| fill-level ledger、Position、Balance、PnL | `execution/src/storage/` | 委托价和进程内余额不能代表真实成交与真实持仓 |
| 事件日志、快照、恢复和交易所对账 | `execution/src/storage/` | 需要原子、可审计、可重放的恢复协议 |
| 四模式编排：replay/paper/shadow/live | execution service | 模式差异只能位于执行 adapter，策略和风险规则保持一致 |
| 配置 schema、版本和 live gate | execution bootstrap | 两个参考项目的实盘门禁都不足 |
| 审计、健康和告警模型 | `execution/src/monitoring/` | 为 decision/order/fill/recovery 建立统一 correlation id |
| 数据契约、实验登记与模型发布 | `research/` | 防止当前配置污染历史实验和模型来源不明 |

新 domain 还必须补充当前 scaffold 尚未表达的单位和身份：`marketEpoch`、condition/event/
token ID、起止边界、规则与结算源、tick/size/negRisk/fee metadata、connection epoch、book
hash/health、order/fill finality、fee role/currency。金额、价格、份额和 fee 禁止继续使用无
单位的 IEEE-754 `number` 作为账本真相；边界上使用带 scale/币种的定点整数或 decimal
字符串，并明确舍入方向。

### 2.2 通过适配层使用开源引擎

仅在许可证、依赖锁定、契约测试和故障测试通过后，考虑使用以下能力。目前没有任何
开源运行时模块适合不经适配直接用于实盘；“直接吸收”只适用于纯数据结构、fixtures
和测试场景。

| 开源能力 | 使用方式 | 使用前必须完成 |
|---|---|---|
| CLOB v2 签名、批量提交、查询、撤单 | 封装在 `ExecutionEngine` 的 Polymarket adapter 内，SDK 类型不得泄露到 domain | 幂等协议、错误分类、超时后查单、生产 client 契约测试 |
| `PriceLevelMap` 与订单簿解析样本 | 提取为公共行情 adapter 内部实现 | sequence/gap/checksum 策略、四时钟、stale gate、重连测试 |
| user-channel maker/taker 事件知识 | 作为新持久事件归并器的协议参考 | 修复提前 settle、外部取消、实际价/fee、认证确认、重连对账 |
| GTC/FOK 映射与撤单场景 | 通过 domain order type 映射 | 精度、舍入、not-canceled 与部分成交竞态测试 |
| 生命周期和 fixture runner | 主要迁移测试场景，不直接迁移耦合实现 | 虚拟时钟、纯状态转移、crash-point 测试 |
| slot/slug 工具 | 放入市场发现 adapter | 用旧项目的标题、周期、token 和流动性校验补强 |

不复用开源引擎的 `WalletTracker` 作为实盘账本，不复用其 PnL 作为财务真相，
不使用 5 秒 JSON 快照作为唯一恢复来源，也不直接采用 CLI 的 `--prod` 门禁。

### 2.3 使用成熟 Python 库

研究与数据工程不应重写已有数值、列式和验证基础设施。建议后续单独审批并锁版本：

| 能力 | 候选库 | 边界 |
|---|---|---|
| 数组、概率、优化 | NumPy、SciPy | 不自行实现分布函数、优化器和线性代数 |
| 条件波动/时间序列 | `arch`、statsmodels | GARCH/EGARCH/GJR/分布拟合；封装后做因果/版本测试 |
| 列式研究数据 | Polars、PyArrow、DuckDB | Parquet/schema/point-in-time 查询；原始事件仍不可变 |
| schema/config | Pydantic | dataset/model/config manifest；凭据 schema 与研究隔离 |
| 测试 | pytest、Hypothesis | 性质、状态机、时间排序和数值边界 |

本阶段不安装依赖。库只替换通用基础设施，不替代 BTC 5 分钟规则、时间可见性、成交
模型、风险政策和独立样本验证。

### 2.4 旧项目仅保留为参考

建议保留并逐项提炼测试/知识，而不是复制实现：

- 市场 slug、标题周期、Up/Down token、流动性和提前发现规则。
- Chainlink 结算口径、同源价格锚、Binance 数据经验和 stale 判定。
- `src_ts/recv_ts`、数据质量、缺口、积压和脏区间隔离方法。
- 固定采样 EWMA、双速波动率、概率校准和 Brier 指标。
- fee-aware edge、临界带、Kelly 上限、盘口深度参与率和分市场预算。
- replay/sweep 的逐字段对账、实验登记、模拟标记和原子结算测试。
- 历史故障、协议 fixture 与 golden 样本。

旧项目的实盘 `trader`、订单 API/实盘热切换、旧 dashboard、scratchpad、备份和
AI 临时产物不进入目标运行时。

## 3. Python 与 TypeScript 边界

### Python：研究与离线验证

Python 负责原始数据导入、质量检查、特征研究、概率校准、walk-forward、回测、
报告和候选策略产物生成。Python 进程不得读取交易凭据，不得构造签名订单，也
不得调用 live execution adapter。

策略研究输出应为版本化、不可变的产物，例如：

- 特征/策略版本和代码提交；
- 参数、训练窗口和数据集 hash；
- 输入 schema 与决策 schema 版本；
- 样本外指标、已知适用范围和失效条件。

### TypeScript：实时数据与执行控制面

TypeScript 负责市场发现、实时行情归一化、策略纯函数执行、中央风控、shadow
与实盘 adapter、订单状态机、用户订单流、账本、恢复、健康检查和审计事件。

Python 与 TypeScript 之间只交换版本化文件/消息契约，不共享进程内状态，也不
让 Python 直接写实时订单数据库。推荐使用 JSON Schema 或等价 IDL 固化：

- `MarketSnapshot`
- `FeatureSnapshot`
- `SignalDecision`
- `RiskDecision`
- `OrderIntent`
- `OrderEvent` / `FillEvent`
- `StrategyArtifactManifest`

实时 TypeScript 不在线拟合复杂模型。Python 发布的 artifact 必须含数据集 hash、训练/
验证窗口、代码提交、特征 schema、模型族与参数、数值库版本、样本外指标、适用范围和
失效条件；TypeScript 只加载已批准、schema 兼容且可确定性推理的 artifact。加载失败或
drift/health 超阈值时退化为 no-trade，不能临时重训。

### 3.1 研究与模型流

```text
immutable raw events + market/rule/fee snapshots
                    |
                    v
      point-in-time normalized dataset + manifest/hash
                    |
                    v
         purged walk-forward / embargo splits
                    |
          +---------+------------------------------+
          |                                        |
   0.5/market/GBM/EWMA/logistic     GARCH/GJR/EGARCH/CGARCH,
   baseline                         Student-t/skew-t,HMM/drift
          |                                        |
          +-------------------+--------------------+
                              v
      calibration + log loss/Brier + net-PnL after fee/fill/latency
                              |
                   independent untouched holdout
                              |
                              v
              versioned StrategyArtifactManifest
```

GBM 只保留为可解释基线。GARCH 系列解决条件方差、聚集和非对称性，但 BTC 5 分钟 ATM
方向 edge 仍取决于经证实的漂移、偏度、微观结构或市场误定价；不能把更复杂的 sigma
模型等同于盈利。GARCH 推理应使用剩余 horizon 的累计条件方差，而不是把 one-step
sigma 直接乘 `sqrt(τ)`。

VaR/CVaR 位于组合风险与 sizing：同时评估重叠市场、策略相关性、未成交订单、流动性和
压力情景。它们不替代单笔 worst-case、每日亏损、滑点、stale 和未成交单硬限制，也不
产生方向信号。

## 4. 时间模型

所有外部事件和派生事件统一包含：

| 字段 | 含义 |
|---|---|
| `source_time` | 数据源声明的观察/事件时间；没有或语义未证明时为空 |
| `server_time` | provider/relay 声明的发送时间；没有时为空 |
| `receive_time` | 本进程收到完整消息、解析前的 UTC 时间 |
| `process_time` | 完成解析和合同校验的时间 |
| `persist_time` | writer 拥有的逻辑 durability commit 时间；fsync 成功后才承认 |

禁止用一个 `ts` 混合五种采集语义。策略的“当前时间”必须作为输入传入；过期保护以
`receive_time` 与显式决策时间计算，并同时监控 source/receive clock skew。

不同 provider 的额外时刻不能硬塞进一个字段：例如 Chainlink RTDS 的
`payload.timestamp` 映射为价格源的 `source_time`，顶层消息发送时间映射为
`server_time`；本地接收是 `receive_time`。派生的 SignalDecision
应另带独立 `decision_time` 和 `input_receive_time`，证明决定只看到了哪个接收水位；
这些业务时刻不能塞回 raw envelope。

## 5. 数据流

```text
Gamma/CLOB WS/外部交易所
        |
        v
vendor adapters --解析/四时钟/来源ID--> append-only raw events
        |                                  |
        v                                  v
market catalog + normalized books     replay/golden datasets
        |
        v
FeatureSnapshot --> pure strategy --> SignalDecision
                                      |
                                      v
                                 central RiskEngine
```

原始事件先持久化再用于可恢复的关键状态转移；高频热路径可批量提交，但必须有明确
的 durability watermark 和背压策略。数据过期、消息 gap、时钟倒退或持久化失效
都会产生不可忽略的健康事件并阻止新单。

每个规范化数据集必须带 `DatasetManifest`：源文件/分区 hash、schema、市场规则版本、
fee snapshot、时区、单位、接收时间范围、缺口/延迟统计、排除规则及其“当时是否可见”。
禁止用事后全窗质量结论静默删样本；排除必须作为可审计实验变量。

## 6. 交易流与风控流

```text
SignalDecision
      |
      v
pre-trade RiskEngine --> RiskDecision（持久化）
      |                         |
      | reject                  | approve / resize
      v                         v
终止并审计              OrderIntent + deterministic idempotencyKey（先持久化）
                                |
                                v
                    ExecutionEngine adapter
                                |
                                v
                     exchange ack / unknown outcome
                                |
              +-----------------+------------------+
              |                                    |
              v                                    v
       user channel events                query-by-id/reconcile
              \____________________________________/
                                |
                                v
                    order state machine + fill ledger
                                |
                                v
             Position/Balance/PnL + post-trade risk + monitoring
```

`unknown outcome` 分支必须先对账，禁止盲目重发。

中央风控至少强制：单笔最大金额、单市场最大仓位、每日最大亏损、最大滑点、最大
未成交订单数、数据过期、WebSocket 断线、重复订单幂等保护。它还应检查市场生命
周期、余额保留、持久化健康、恢复状态和 live gate。任何 API 或运维命令都不得
绕过该层。

组合风险在上述硬门禁之后计算：worst-case loss、压力情景、VaR/CVaR、集中度、相关性
和 drawdown 可以进一步缩量或拒绝；任何估计失败、NaN 或样本不足都 fail closed。所有
approved risk budget 要先冻结对应 cash/position capacity，直到 order terminal 并完成
fill/cancel reconciliation。

## 7. 状态恢复流程

1. 进程启动为 `RECOVERING`，live adapter 不接受新订单。
2. 校验配置/schema 版本、事件日志完整性、快照 hash 和 durability watermark。
3. 从最新可信快照重放后续事件，重建订单、成交、持仓、余额和风控计数器。
4. 通过交易所 REST/用户频道枚举全部 open orders、近期 fills、balances/positions。
5. 将本地与交易所状态分类为一致、可自动修复、孤儿单、未知成交或账本差异。
6. 自动修复只产生新的审计事件，不改写历史；孤儿或未知结果默认阻止新单。
7. 重订阅公共和用户 WS，等待认证、快照、连续性和新鲜度全部健康。
8. 重新运行中央风险检查；只有零未决差异且 live gate 有效时才进入 `READY`。

快照只加速恢复，append-only event journal 和 exchange reconciliation 才共同构成
恢复真相。损坏快照不得静默退化成“全新启动”。

## 8. 实盘开关机制

环境示例和代码默认值都必须是：

```text
LIVE_TRADING_ENABLED=false
```

建议使用分层门禁：

1. 显式运行模式为 `replay`、`paper`、`shadow` 或 `live`；默认 `paper`。
2. 只有 `mode=live` 且 `LIVE_TRADING_ENABLED=true` 才允许构造真实 adapter。
3. live 配置必须绑定 chain、账户、公钥、市场系列、金额硬上限和配置 hash。
4. 使用短时有效的 arming token/人工确认；确认内容展示账户和硬上限，不展示密钥。
5. live 开关不能由未认证本地网页热改，配置变化需要重启并重新恢复/对账。
6. 数据、用户 WS、事件日志、风险或恢复任一 unhealthy，自动撤销 arming 并停止新单。
7. emergency exit 是单独受限操作：仍经过滑点、幂等、审计和成交对账。

研究、测试和 CI 环境应在依赖注入层完全没有真实 adapter，实现“即使误设环境变量
也无法发送订单”的结构性保护。

## 9. 前三个迁移批次边界

1. **安全、领域模型与 golden（第一批已完成）**：已固定 Python 研究层市场身份/规则、
   显式因果时间、Decimal、live 负向门禁、fill 会计与 settlement/PnL golden。跨语言
   manifest、官方 WS/动态 fee fixtures 仍属于后续经批准扩展。
2. **只读数据采集、时间和存储**：实现无凭据的市场发现、公共订单簿、Chainlink/
   Binance、不可变 raw event、质量检查和数据集 provenance；不建立 point-in-time 特征层。
3. **可信回测、手续费和成交模拟**：最后重建事件驱动回测、独立 walk-forward/holdout、
   动态 fee、队列/延迟/多档/部分成交/拒单、现金冻结和逐 fill PnL。

详细来源、目标目录、测试、完成标准和回滚方式见 `docs/migration-plan.md`。前三批明确不含
实盘执行、私有用户频道、部署、shadow-to-live、真实凭据、复杂策略上线或历史代码整体
复制。GARCH/EGARCH/GJR、HMM、漂移和 VaR/CVaR 在此阶段只能作为离线研究候选与风险
验证，不得越过独立样本和可信成交模型直接进入运行时。
