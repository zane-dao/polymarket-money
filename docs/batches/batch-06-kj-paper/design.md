# Batch 06：K/J 历史 Paper 闭环设计

## 目的与安全边界

本批在不采用 legacy runtime 的前提下建立最短可用研究闭环：已验证历史数据 → J/K 概率 → 含费 intent → 延迟理论成交 → 仓位/现金 → 官方结算 → gross/fee/net PnL → 确定性 JSON/NDJSON/CSV 导出。

历史路径仅限离线 paper：没有网络、凭据、私有频道、签名、下单或撤单路径，并持续保持 `LIVE_TRADING_ENABLED=false`。

## 来源与重建原则

审查对象是只读 legacy commit `d08ba3e591617e45b2463777afc6ec64a3ad1a46`（`/mnt/c/Users/seeta/Desktop/hello-world`）：

- `config.toml`：J fee-aware 与 K dual-vol 参数；
- `strategy/signal.py`：零漂移 normal-CDF 概率和 dual-vol floor；
- `order/trader.py`：fee-aware edge、critical band、Kelly、stake/depth gate 与 PnL 规则；
- `strategy/main.py`：variant 路由和逐策略资金池；
- `strategy/settlement.py`、`core/storage.py`：官方 outcome 与资金池结算。

不复制或导入 legacy runtime。规则通过不可变 historical receipt 和 `Decimal` paper 会计边界重新表达。开源引擎仅提供 market lifecycle、StrategyContext、wallet reservation、recovery 和 NDJSON 的后续设计输入；其 `number` 会计、进程内幂等、token 数组位置映射、简化 fill 与恢复实现不采用。

## 输入与 EWMA 产物

runner 只接受 `ExternalHistoricalDatasetAdapter.load()` receipt。加载器验证 manifest 内容 hash、decision-sample hash、label-evidence hash、行数和版本目录。首个接受数据集为：

```text
dataset_hash = a27d9d1bf4dc5276c7ae5b11abd64250b6e6dc17f01fd432ab0dc10e4425cafc
valid markets = 5,599
decision samples = 16,797
official label coverage = 100%
Binance decision-point coverage = 100%
continuity = UNVERIFIED
```

paper 命令还将 split、horizon、execution scenario、初始现金和完整 K/J 参数映射固定进 result hash。

`poly-lab build-kj-ewma` 验证历史 receipt 固定的 21 个 Binance zip hash 和 checksum-file hash，连续读取 1,814,400 个一秒 close，在 canonical 五秒 phase 上应用审查后的 legacy 方程，并在 content-addressed 目录发布 16,797 条 decision-point。manifest 记录来源 gap、参数、builder code hash、output hash 和 fidelity 限制；本来源没有缺失秒。

```text
artifact_hash = 387201c1eacbbe54f81d4519407bdb4acf50c9f6ce9f46a2bdb6f924796265da
```

结果同时固定运行引擎 code digest，因此实现变更不能静默继承同一结果身份。

## J/K 重建

两个 variant 都使用 legacy normal-CDF、5 个百分点 base edge、官方 market-static fee、half-overround buffer、\$10 critical band、25% fractional Kelly、每笔现金 2% 上限、\$400 绝对上限、可见深度 50% participation 和 \$1 最小 stake。

- J：canonical 五秒 EWMA、100 秒 half-life、`0.00002` floor。
- K：同一流的 180 秒 fast 与 2,700 秒 slow EWMA，等待 180 秒后使用 `max(fast, 0.4 * slow, 0.000012)`。

每份事件和汇总均标记 `signal_fidelity=CANONICAL_5S_EWMA_OFFICIAL_BINANCE_1S_CLOSE`。这不等于 Strict legacy：一秒 kline close 不是 live trade tick，BTCUSDT 不是 K 的历史 `binance_usd` 换算，归档起点也只能固定 canonical phase，不能恢复旧进程 `vol_epoch`。

## L_ADAPTIVE_EXECUTION：独立预注册研究

`L_ADAPTIVE_EXECUTION` 是独立的 offline Python 策略，不修改冻结 J/K enum、`paper-kj` CLI、TypeScript runtime 或公开 paper 配置：

```text
poly-lab paper-l-adaptive --split TRAIN|VALIDATION ...
```

CLI/API 不接受 `FINAL_TEST`。不可变配置为 `l-adaptive-execution-v1-preregistered`：先记录 `TRAIN_FIXED_CONFIGURATION_AUDIT`，再记录 `VALIDATION_PRE_REGISTERED_CONFIGURATION`；只有记录 train/validation 结果后，经明确决定才能打开 untouched final split。

L 没有绝对 base edge。选中 outcome 的 required edge 由以下逐项导出值相加：

```text
official taker fee per share
+ half overround
+ latency tick/slippage budget
+ Binance log-price speed × latency budget
+ current top-of-book spread reprice-risk proxy × latency budget
+ smoothed sigma × sqrt(remaining) uncertainty budget
+ visible-depth / permitted-participation pressure budget
```

订单规模仍受 fractional Kelly、现金、绝对上限和允许 visible ask depth 共同限制。L 对 30/60/120 秒 realised volatility 采用 50%/30%/20% 加权 RMS，加 variance-space floor，再施加连续 divergence shock multiplier；normal-CDF 概率也会按 `sigma * sqrt(remaining)` 的有界函数连续拉向 0.5，显式表示 volatility drag。

L 不使用固定 \$10 critical band，而在 dynamic opening-anchor ambiguity band 中 fail closed。历史 receipt 没有可用的先前 quote sequence，所以必须记录 `market_quote_velocity_available=false`，只使用 `CURRENT_TOP_OF_BOOK_SPREAD_PROXY_1HZ`，绝不利用后续 execution book 伪造速度。历史行也没有 point-in-time Chainlink price，不能推得 Binance--Chainlink basis；两者都是未来 realtime L context 的前提，而不是本研究假设的 alpha。

## Paper 成交与会计

- signal 和 intent 使用 point-in-time decision book；base execution 使用一秒后记录的 ask/visible ask size，stress execution 再加一个 \$0.01 不利 tick。
- intent quantity 在 decision time 由 fractional Kelly、现金/绝对上限和 decision ask size 的 50% 固定；后续 visible size 只能缩减它，未来价格不得创建或重算 intent。
- fee 为 `rate * price * (1-price) * quantity`，并与 gross/net PnL 分开保存。
- 每条 fill 保存稳定 intent/fill/settlement ID、fill 后现金、fill 前后与 settlement 后仓位、payout 和 settlement 后 bankroll。
- 各策略拥有独立现金路径；unknown fee、critical band、无效 book、无深度、最低 stake、现金不足、stale-quote edge 与 weak edge 都 fail closed。

输出目录 no-overwrite，包含 `summary.json`（hash、安全标记、总额、现金、gross/fee/net PnL、drawdown、原因计数）、`events.ndjson`（逐策略 decision audit）和 `trades.csv`（含 decision/fill 会计字段的平面导出）。同一 core mapping 必须产生同一 SHA-256 result hash。

## Public runtime、journal 与结算

TypeScript public runtime 输出 paper-only K/J StrategyContext，包含 market/token identity、top-of-book、fee evidence、signal source/receive time、connection/input hash 与 receive stamp。stale、crossed、missing-fee、mixed-clock、future-time 和非运行市场输入均 fail closed。详见 [live-context.md](live-context.md)。

提供显式 `--kj-paper-journal` 时，runtime 只将 ready context 交给 `kj-paper-engine-v2`；否则只输出 context evidence，禁用 K/J wallet mutation。engine 拥有独立 J/K wallet、五秒 EWMA、冻结 intent、worst-case reservation、一秒 fill latency、maximum-slippage/no-visible-size 拒绝、partial fill、position 与 `INIT -> RUNNING -> STOPPING -> DONE` market state。身份幂等，冲突重用 fail closed；后续 context 只能减少冻结 quantity。

每个应用的 context 或 Gamma resolution response 都先 fsync 到 append-only NDJSON input journal。record 带连续 sequence 与 SHA-256 chain，独立原子 checkpoint 锚定 tail；MVP journal 在任何 context 前写入 `RUN_PLAN`，绑定 target interval 与 collector commit。recovery 验证字段、context reconstruction、engine version/config、identity、精确 public settlement body、clock watermark、hash chain 与 checkpoint 后再确定性 replay。只有 closed Gamma market、`umaResolutionStatus=resolved` 和唯一精确 1/0 outcome 才转为 official settlement evidence；不完整行、被修改 record、缺 checkpoint 或 tail truncation 都 fail closed。journal 必须 Linux-native、非 symlink 且 Git 外；`paper:inspect` 可重放状态。

TypeScript normal-CDF 使用确定性 Abramowitz-Stegun approximation，Python 使用平台 `erf`；不宣称逐字节等价。shared probability golden 将代表性及 clamp-tail z-score 的绝对误差限制在 `0.0000002`。runtime 在 interval end 后轮询 public Gamma endpoint；`paper:mvp` 对齐完整 interval，`paper:settle` 只恢复冻结 half-open target window，`paper:finalize` 用推进 journal 重跑 acceptance contract 并写入 `RECOVERED_FINAL`，`paper:report` 复核 source/snapshot/safety/settlement/PnL identity 后导出带 hash 的描述性报告。

## Cohort、Campaign 与双信号比较

`paper:cohort-report` 仅离线聚合已完成 report：重验 artifact hash，只接受 `HASH_CHAINED` `DESCRIPTIVE_PAPER_ONLY` report，拒绝重复 run ID 和重叠 target window，并永久保持 `profitabilityClaimEligible=false`。它不改变参数，也不产生 fill、alpha、shadow 或 live 证据。

`paper:cohort-observability-report` 与 PnL cohort 分离：重算 runtime summary hash，重开 durable journal，核对 record/tail/event count，并报告 public-stream event/reconnect/quarantine、Gamma settlement delay 和 J/K intent/fill/partial/no-fill/reason 分布。它衡量 paper 执行质量，不把理论 fill 变成 exchange evidence。

`kj-paper-campaign-v1` 在 canonical SHA-256 下预注册完整窗口、market count、settlement grace、run ID 和 collector commit。campaign cohort 只在每个注册 run 恰好一次、每份 report 的 hash/index/window/count/commit 都匹配时接受；campaign observability 使用同一不可变 run 集。delayed-settlement 的 `paper:finalize` 也验证可选 campaign binding，恢复不得降级为 unbound plan。

`--kj-signal-source` 可选择 Binance spot 或单独标识的 public Chainlink relay，但不得混入同一 K/J engine；paired comparison 中每个来源必须有独立 EWMA/anchor/wallet。

`kj-signal-compare-v1` 固定 matched two-leg plan，并发启动两个既有 `paper:mvp` child，使用同一 half-open target window 与 commit。扩展版本 `kj-signal-compare-campaign-artifact-v1` 将两条 ordinary source campaign 和逐窗口 hash-bound compare plan 放进同一 artifact；漏窗不可平移、重试或替换。每条腿复用既有 wallet、journal、official Gamma settlement 和 recovery path。

计划绑定 run 前预留 180 秒，runtime 只记录 source-specific `WARMUP_SIGNAL`。replay 仅将它用于 volatility state；warmup 不含 market identity、order-book input、intent、wallet mutation 或 settlement candidate，且不得跨 source family。当前 Chainlink RTDS relay 仅用于 observability，不能结算 wallet 或替代 Gamma/UMA final evidence；详见 [chainlink-provisional-settlement.md](chainlink-provisional-settlement.md)。

