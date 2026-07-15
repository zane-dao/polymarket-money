# 前三个迁移批次

## 0. 执行边界

本计划定义前三个批次。批次 1 已于 2026-07-15 以 clean-room Python 模型、安全门禁和
离线黄金测试完成；批次 2 已获授权并按最新批次规范执行，批次 3 尚未开始。每批都必须保持：

- `LIVE_TRADING_ENABLED=false`；
- 不读取真实凭据，不连接私有用户频道，不发送订单；
- 不整体复制 `polymarket-paper` 或 `olymarket-trade-engine`；
- 只提炼经证据支持的规则、接口、测试和脱敏样本；
- 每个批次是独立提交，可用 `git revert` 回滚；
- 引入第三方库前单独审批、锁版本、记录 license/供应链清单。

前三批明确排除：实盘执行、真实 CLOB 签名、账户/钱包、部署、shadow-to-live、自动撤单/
紧急退出、复杂策略上线，以及“先迁旧代码再补测试”。执行 adapter、用户私有频道、账本
恢复和实盘审批必须在前三批全部验收之后另行规划。

## 批次 1：安全边界、领域/研究模型和 golden 基线

**状态：已完成。** 实际结果和保留缺口见 `docs/batch-1-result.md`；本节保留为原始验收
计划，不表示其中所有远期 TypeScript/manifest 扩展都已实现。

### 要处理的模块

- vendor-neutral 的 Market、OutcomeToken、OrderBook、Trade、Order、Fill、Position、
  Balance、SignalDecision、RiskDecision、Settlement；
- `marketEpoch`、市场规则/结算源、tick/size/negRisk、fee metadata、连接 epoch、book
  health/hash、order/fill finality；
- 带单位和 scale 的 fixed-point/decimal 契约，禁止无单位账本 `number`；
- `exchangeTimestamp`、`receiveTimestamp`、`processTimestamp`、`persistTimestamp` 加
  monotonic ingest sequence；
- 可选 `providerServerTimestamp`，以及 decision 的 `decisionTimestamp` 与
  `inputWatermarkReceiveTimestamp` 因果水位；
- 纯函数 StrategyInput/StrategyArtifactManifest/DatasetManifest；
- `LIVE_TRADING_ENABLED=false` 的结构性负向门禁；
- 当前官方 market channel、RTDS、fee、BTC 5m tie=Up 和用户订单状态的脱敏 golden；
- 旧项目和引擎已发现故障的 negative fixtures。

### 来源项目

- 旧项目：`market/feeds/polymarket.py` 的按 outcome 名配 token、五分钟边界与标题校验；
  `rtds_chainlink.py` 的源时间/15 秒 stale/平局 Up；`recorder` 的双时间经验；
  `signal/metrics` 的因果固定栅格和校准测试思想。
- 开源引擎：`PriceLevelMap`、orderbook/user-channel/lifecycle fixtures 和事件竞态场景；
  不迁移 WalletTracker、PnL、recovery 或 prod gate。
- 官方协议：当前 market/user channel、order type/fee 和 BTC 5m 规则。
- `polymarket-learn`：GBM 只作基线；GARCH/GJR/EGARCH/CGARCH、Student-t/skew-t、HMM、
  VaR/CVaR 的候选契约和适用限制，不在本批拟合或上线复杂模型。

### 目标目录

- `execution/src/domain/`
- `execution/src/strategy/`
- `execution/src/risk/`
- `data/fixtures/`、`data/golden/`
- `tests/unit/`、`tests/golden/`、`tests/replay/`
- `research/features/`、`research/reports/`（只放 schema/manifest，不放研究结论）

### 为什么优先

两个参考项目的根因都是语义分叉：token 顺序、平局规则、单一时间戳、委托价冒充成交价、
MINED 冒充 final、环境变量双真相和无单位浮点。先固定契约和反例，批次 2/3 才不会把
错误编码成另一套实现。

### 需要的测试

- TypeScript `tsc --noEmit` 和 Python 配置测试；
- schema round-trip、未知字段/版本拒绝、单位/精度/舍入边界；
- 四时钟排序、缺 source time、clock skew、重复/乱序/同毫秒 ingest sequence；
- Up/Down token 顺序颠倒、五分钟边界、平局 Up、错误结算源；
- 当前 `price_changes[]` 与旧 `changes` 失败 fixture；
- recorder 四元组/二元组契约冲突的负例；
- user trade 的 MATCHED/MINED/CONFIRMED/RETRYING/FAILED 和部分成交事件排列；
- 策略禁止网络、数据库、环境变量、系统当前时间和全局可变状态；
- 在所有 mode/env/CLI 组合下，缺真实 adapter 且 live submit 不可构造。

### 完成标准

- vendor SDK 类型不进入 domain；所有货币/价格/份额字段有单位与 scale；
- 同一输入、artifact、配置和显式时钟产生字节级稳定决定；
- 每个 fixture 有来源、脱敏说明、schema version 和 hash；
- 上述已知 Critical 的最小反例均能在新契约层失败或 fail closed；
- 仓库、示例、测试和 CI 默认仍为 `LIVE_TRADING_ENABLED=false`。

### 回滚方式

整批作为独立提交 `git revert`；只包含类型、schema、文档和离线 fixture，没有数据库迁移、
网络接线或外部状态。回滚时保留审计文档和参考项目不变。

## 批次 2：只读数据合同、市场身份和不可变原始存储

### 要处理的模块

- BTC 5 分钟市场发现和规则快照；
- Polymarket 公共 market WS/orderbook、Chainlink RTDS、Binance 只读行情；
- snapshot/delta、PING、connection epoch、stale/clock health 和断线后重新快照；
- versioned RawEventEnvelope、append-only JSONL、partial/crash 识别和 DatasetManifest；
- TypeScript 公共实时边界与落盘；Python 合同验证、质量报告和 manifest-gated replay；
- 数据质量只产生日志/标志，不用事后信息静默删除样本。

最新批次命令明确排除 Parquet、DuckDB、特征表、回测表和 point-in-time join；这些留给后续
处理层，不能把 raw event 提前压扁。

### 来源项目

- 旧项目：市场周期/title/token/Chainlink 规则、RawTap envelope、`src_ts/recv_ts`、quality
  检测和多源 fixture；废弃其 recorder 崩溃路径、无界 queue、Z-score 锁死和 stale book。
- 开源引擎：`PriceLevelMap`、当前 `price_changes` parser/fixtures 和 provider 场景；不采用
  其缺 PING/freshness 的连接监督或共享 `validated` 状态。
- Python/Node 标准库；本批只增加 Node 类型定义，不引入运行时 vendor SDK。

### 目标目录

- `execution/src/adapters/market-data/`
- `execution/src/storage/`（只存公共不可变事件，不含订单账本）
- `execution/src/monitoring/`
- 仓库外 `POLY_DATA_ROOT`、`data/fixtures/`
- `research/polymarket_money/` 的合同验证、市场映射、quality 和 replay
- `tests/integration/`、`tests/replay/`、`tests/golden/`

### 为什么优先

模型和回测的可信上限就是原始数据的可见性与耐久性。当前旧 parser 会丢官方增量，
recorder 会崩溃，两个项目都可能继续暴露陈旧价格；先建立无凭据的可信输入，风险低且
能够为后续研究提供真实证据。

### 需要的测试

- 官方/历史/合成 snapshot、`price_changes`、`tick_size_change` golden；
- 错 market/token、重复、乱序、缺失 source time、hash 变化和重连；
- 每 provider 的 source/server/receive/process/persist 时间和 clock skew；
- 断线、stale、重连无 snapshot 时 fail closed；
- segment 已存在、partial、中断写入、checksum/count/manifest/path traversal；
- market epoch、五分钟边界、错误 outcome 顺序、错误 oracle 和缺 orderbook；
- 网络层 contract 使用本地 mock/fixture，测试不得访问私有频道或订单 endpoint。

### 完成标准

- 同一 manifest 可验证相同 segment bytes/hash/count，并按原接收顺序回放；
- 市场身份能证明 slug/eventStart/end、Chainlink BTC/USD、Up/Down token 和 orderbook；
- 重连后无新 snapshot 时 delta 不能应用；任何公开流 continuity 都标为 UNVERIFIED；
- 正常关闭产生 no-clobber segment/checksum/manifest，异常关闭留下可识别 partial；
- DatasetManifest 能追到每个源分区/hash/排除标志，保留策略与文档一致；
- 运行过程仍不需要账户、签名、私钥或 API Key。

### 回滚方式

停止只读 collector，切回 fixture-only adapter，`git revert` 该批代码；新 raw 分区保持
不可变，不删除、不改写，仅在 manifest 标记由已回滚版本产生。没有账户或链上状态需要
撤销。

## 批次 3：可信事件回测、动态手续费和成交模拟

### 要处理的模块

- 以 receive/ingest 可见性驱动的 event replay 和虚拟时钟；
- train/selection/validation/final holdout 的 purged walk-forward 与 embargo；
- 版本化配置、特征和 model artifact；
- no-skill/市场概率/旧 GBM/EWMA/正则化逻辑回归基线；GARCH 系列只作为离线候选评估；
- 动态逐市场 fee metadata、maker/taker、官方舍入和费用币种；
- 多档 VWAP、队列位置/参与率、延迟分布、部分成交、未成交、拒单、撤单竞态、市场关闭；
- cash/position capacity 预留、逐 fill ledger、gross/fee/slippage/net PnL；
- simulated/backfill/live-equivalent segment 严格隔离；
- 组合压力、worst-case、VaR/CVaR 和最大回撤的离线风险报告。

### 来源项目

- 旧项目：replay/sweep 对账思想、EWMA/GBM 基线、fee/结算测试、错误标签和 simulated
  污染事故；不采用现有 tick 选择、未来 USD 常量、当前 config、同窗选参或立即全成。
- 开源引擎：GTC/FOK/撤单/部分成交 lifecycle fixtures；不采用 sim client 的一档整单成交、
  委托价 PnL、FOK-only fee 或 WalletTracker。
- `polymarket-learn`：GARCH/GJR/EGARCH/CGARCH、Student-t/skew-t、HMM、漂移和 VaR/CVaR
  的候选与验证框架。
- 成熟 Python 库：NumPy、SciPy、`arch`、statsmodels、Polars/PyArrow/DuckDB、pytest/
  Hypothesis（经批准锁定）。

### 目标目录

- `research/backtest/`、`research/features/`、`research/reports/`
- `data/processed/`、`data/golden/`
- `execution/src/domain/`（只补 fill/fee 仿真契约）
- `tests/unit/`、`tests/replay/`、`tests/golden/`、`tests/integration/`

### 为什么优先

在证明“数据当时可见”和“订单可能真正成交”之前，任何复杂策略收益都没有决策价值。
该批先消除旧系统最主要的假盈利来源，给后续是否投入执行/恢复工程提供可信 go/no-go
证据。

### 需要的测试

- causality audit：篡改未来事件不能改变更早决定；参数/artifact 只能在生效后可见；
- 同市场/相邻重叠市场的 purged split、embargo 和 untouched final holdout；
- fixed seed/虚拟时钟确定性；simulated/backfill segment 永不进入主绩效；
- 每个市场 fee snapshot、maker/taker、marketable GTC、舍入最小单位和 fee 变更；
- 一档不足、多档穿透、队列未轮到、部分成交、零成交、拒单、取消与成交交错；
- BUY 只可按 ask 或更差价格、SELL 只可按 bid 或更差价格；midpoint/last-trade/signal
  price 冒充 fill price 的负向测试；
- latency/stale/market close 导致 no-fill；cash 预留禁止相邻市场重复使用；
- fill-level 会计恒等式、Up/Down 0/1 payout、部分成交 realized PnL、重复 settlement、
  official 改判和资金释放幂等的 golden PnL；
- GBM/EWMA/GARCH 候选的 Brier、log loss、calibration/coverage、样本外净 PnL；
- VaR exceedance、CVaR tail mean、肥尾/相关/流动性压力情景，NaN/样本不足 fail closed。

### 完成标准

- 每笔回测交易都能追到当时可见的 raw event、配置/artifact、fee snapshot、订单模拟事件和
  fill；没有这些证据就不能进入绩效；
- 报告同时展示 gross、fee、slippage、unfilled opportunity 和 net PnL，且模拟/回填严格
  分段；
- train/validation/final holdout 完全不重叠，模型选择过程可复现；
- 复杂模型只有在独立 holdout 上稳定优于市场/简单基线且扣除成本后仍为正，才可标为
  “研究候选”，不能标为“可实盘”；
- 整批仍无真实 ExecutionEngine、私有用户频道、签名或下单路径。

### 回滚方式

回退该批代码和实验注册；保留 immutable raw、manifest 和失败报告，不删除数据。将候选
artifact 标记为 `REVOKED`/不可加载，恢复到批次 2 的只读采集和批次 1 的 fixture replay。
不存在真实订单、账户或链上回滚。
