# 旧项目深度审计

## 1. 范围、基线与限制

- 旧项目 AI/知识工作区：`/mnt/d/polymarket-paper`
- VS Code 指向的真实 Git 仓库：`/mnt/c/Users/seeta/Desktop/hello-world`
- 本文相对路径所使用的 Python 代码根：
  `/mnt/c/Users/seeta/Desktop/hello-world/polymarket_paper`
- 审计提交：`d08ba3e591617e45b2463777afc6ec64a3ad1a46`
- 本次只读源码、测试、说明文档和脱敏 fixture；没有读取 `.env`、数据库、私钥、
  助记词、API Key 或钱包凭据，没有联网或下单。
- 旧仓库没有被修改。所有结论仅写入 `polymarket-money/docs`。

旧项目不是一个可直接迁移的实盘系统。它最有价值的资产是 BTC 5 分钟市场规则、
Chainlink 结算经验、数据质量经验、研究假设和部分纯函数测试；最不可信的部分是当前
WebSocket 解析、模拟成交、报表成绩、实盘接口、订单状态和恢复。

## 2. 代码结构和职责

| 领域 | 主要路径 | 当前职责 | 结论 |
|---|---|---|---|
| 配置/存储 | `core/config.py`、`core/storage.py` | TOML 配置、SQLite schema、records/orders/bankroll | 与业务高度耦合；只提炼规则和测试 |
| 市场数据 | `market/feeds/*.py`、`core/miniws.py` | Gamma、CLOB、Chainlink、Binance 及其他交易所 | 协议已漂移；需重写 adapter |
| 录制/质量 | `recorder/recorder.py`、`recorder/rawtap.py`、`recorder/quality.py` | 原始帧、归一化表、质量指标 | 双时间和质量知识值得保留；实现不直接迁移 |
| 模型/策略 | `strategy/signal.py`、`strategy/main.py`、`order/trader.py` | EWMA/GBM 概率、策略编排、纸面成交及少量实盘代码 | 模型需重做样本外验证；策略边界需纯函数化 |
| 回放/实验 | `strategy/replay.py`、`strategy/sweep.py`、`recorder/autosweep.py` | 事件回放、参数扫描、报告 | 有因果和选择偏差，不能用现有成绩证明盈利 |
| 结算/报表 | `strategy/settlement.py`、`strategy/report.py` | outcome、PnL、Brier、HTML/CSV | 结算经验有价值；汇总口径会混入模拟记录 |
| 下单/API/UI | `order/`、`api/`、`web/`、`dashboard.py` | GTC 买单、本地 API、面板 | 安全和状态完整性不足，执行代码建议废弃 |
| 运维 | `watchdog/`、`healthcheck.py`、`core/alerts.py` | 健康、备份、重启、配置写入 | 保留监控规则，不迁移会改进程/配置的实现 |
| 测试/历史 | `tests/`、`knowledge/`、`docs/`、`scratchpad/` | 回归、事故记录、临时验证 | 逐个提炼；禁止整体复制 |

## 3. 端到端数据流

```text
Gamma 市场发现
  market/feeds/polymarket.py
          |
          +--> CLOB market WS / REST book ----+
          |                                    |
Chainlink RTDS / Binance / 其他交易所 ----------+--> recorder/rawtap
                                                   |
                                                   v
                                     raw JSONL + market_data.db
                                                   |
                                      归一化、src_ts/recv_ts、质量检查
                                                   |
                                                   v
                          strategy/signal.py: EWMA/GBM 概率
                                                   |
                                                   v
                     strategy/main.py + order/trader.py: decide
                                                   |
                         +-------------------------+-------------------+
                         |                                             |
                    纸面立即全成                                  少量实盘 GTC buy
                         |                                             |
                         v                                             v
                 records / bankroll                                orders row
                         |
                         v
        Gamma winner -> Chainlink -> Binance fallback settlement
                         |
                         v
                 PnL/Brier/report/sweep
```

关键问题是同一条流中同时混合了采集、共享可变状态、系统当前时间、策略、理想成交、
实盘副作用和报表。这样既不能可靠回放，也不能证明实盘会得到相同结果。

## 4. 数据采集、时间和存储审计

### 4.1 确定性录制崩溃

`market/feeds/binance_bookticker.py:24-29` 的 `parse_book_ticker()` 返回
`(bid, ask, bid_qty, ask_qty)` 四个值；`recorder/recorder.py:542-549` 却用
`bid, ask = parsed` 解包两个值。`recorder.py:387-393` 的 tail callback 不捕获该
异常，`recorder.py:639-665` 又把任务放入 `asyncio.gather`。因此 Binance bookTicker
首条合法帧就可以让整个 recorder task 失败。这不是推测，而是静态契约冲突。

### 4.2 当前 Polymarket market channel 不兼容

`market/feeds/polymarket.py:289-335` 在判断事件类型前要求顶层
`msg.asset_id`，然后从 `changes` 取增量。当前官方 `price_change` 的 token ID 在
`price_changes[]` 项内，并非顶层字段；顶层有 `market/timestamp/event_type`。因此当前
增量会在入口被丢弃，即使越过入口也读错字段。现有测试使用的是旧/人工消息结构，
所以测试通过不能证明线上协议兼容。当前官方 schema 见
[Market Channel](https://docs.polymarket.com/market-data/websocket/market-channel)。

### 4.3 陈旧盘口和消息连续性

`market/feeds/polymarket.py:370-411` 重连时不清空旧 bid/ask；只要两个值非空，REST
兜底就不刷新。实现没有 sequence、hash、gap、exchange/receive timestamp 或 book
freshness。断线后策略可能继续用旧 ask 制造不存在的 edge 和假成交。

Binance 主信号也没有 stall watchdog（`market/feeds/binance.py:73-78`）。其基于最近
20 个价格的 3σ 过滤（`binance.py:43-65`）可能在快速单边变化时连续拒绝新价格，
把真实行情误判为离群值并冻结信号。

### 4.4 时间语义不统一

- recorder 部分路径区分 `src_ts/recv_ts`，这是值得保留的设计知识。
- records/orders 只存本机单一 `ts`（`core/storage.py:34,57`），无法区分交易所、
  接收、处理、持久化时刻。
- `parse_when` 的部分路径使用本地时区 `time.mktime`，跨 WSL/Windows/部署主机可能
  得到不同 UTC 结果。
- Binance aggTrades 回放直接使用交易所时间并近似零接收延迟
  （`strategy/replay.py:334-374,719-740`），不能模拟真实信号可见时间。
- Chainlink RTDS 的 `payload.timestamp` 是源价格时间，顶层 `timestamp` 是消息发送
  时间；旧 `rtds_chainlink.py:73-108` 选择源时间的思路正确。当前协议说明见
  [RTDS](https://docs.polymarket.com/market-data/websocket/rtds)。新系统应同时保存两者，
  再补 receive/process/persist 时间。

### 4.5 原始数据和存储真相

RawTap 的原始帧和断点思路有价值，但队列无界；flush 只观察队列而没有明确写入确认/
fsync，daemon 退出窗口会丢尾部数据。文档把 raw capture 称为真相来源，保留任务却会
清理七天前数据，二者冲突，旧实验不可完整复现。

`core/storage.py` 在运行时迁移 SQLite schema，缺少 schema version、FK、订单唯一键、
client order id、fill 表和显式单位。它适合提炼测试，不适合作为新实盘账本。

## 5. 特征、GBM、GARCH、漂移和尾部风险

### 5.1 旧 GBM 实际做了什么

`strategy/signal.py:190-210` 不是生成价格路径，而是把当前价、开盘价、剩余时间和
EWMA sigma 映射为上涨概率，并直接驱动交易决定。默认 `normal` 版本的公式与其“零
漂移价格过程”命名不一致：它漏掉了 Ito 项；`prob_up_drift`（`269-300`）反而包含
`-0.5σ²τ`。到期且价格相等时 `prob_up()` 返回 Down，而结算逻辑规定平局 Up。

参数单位本身在源码中是明确的：`strategy/signal.py:20-73` 以秒为时间轴，
`var_obs=log_return²/dt`，输出 sigma 的单位是“每 √秒”，`remaining_s` 是秒，所以
`sigma*sqrt(remaining_s)` 量纲一致。它不是年化 sigma。当前代码没有估计可预测的
经验 drift；名为 `prob_up_drift` 的实现只加入 GBM 的 Ito 项，不能被解释为已经发现
方向漂移。若以后引入 GARCH，必须把固定采样周期、收益单位、forecast horizon 和累计
条件方差一并写入 artifact，禁止混用年化、每秒和 one-step sigma。

### 5.1.1 交易 EV 和 NO_TRADE 行为

`order/trader.py:41-99` 对 Up 使用 `q_up-ask_up`，对 Down 使用
`(1-q_up)-ask_down`，选择 edge 较大的一侧；二元 token 每股、忽略费用时的期望净收益
正是 `q-可成交买价`。fee-aware 模式再把每股 taker fee 和启发式 spread buffer 加入阈值。
这是“是否值得提交买单”的筛选，不是 fill 证明。

旧策略并不强制下注：盘口缺失/非法、价格超上限、临界带、edge 不足、edge 异常过大、
资金或深度不足时都返回 `None`，即明确 NO_TRADE。它也没有真实 sell/平仓策略；所谓
换向主要是买另一个 outcome。因此目标架构必须把 `BUY_UP`、`BUY_DOWN`、`SELL_UP`、
`SELL_DOWN` 和 `NO_TRADE` 的 EV、价格侧和费用分别定义，不能把旧 buy-only 逻辑泛化。

更重要的是，固定 sigma 的 GBM 假定独立同分布收益和常波动，不能表达波动聚集、
肥尾、非对称冲击和 regime shift。`/mnt/d/polymarket-learn/lesson-02-garch.html`
已正确指出这一缺陷，并给出 GARCH(1,1)、EGARCH、GJR-GARCH、CGARCH、APARCH 等
候选演进模型；`lesson-03-hmm.html` 进一步把连续波动状态与离散 regime 分开。

### 5.2 不能把“换成 GARCH”当成盈利结论

当前 BTC 5 分钟 Up/Down 合约是“结束价大于或等于开始价则 Up，否则 Down”，价格源
是 Chainlink BTC/USD，见当前市场的
[规则页](https://polymarket.com/event/btc-updown-5m-1784051400)。在接近平值且阈值就是
开盘价时，单纯改变 sigma 对方向概率的作用很有限；真正需要验证的是可预测漂移、
偏度、跳跃、微观结构和市场报价是否存在可交易偏差。GARCH 更适合改进条件波动率和
仓位/风险估计，但不会自动产生方向 alpha。

建议建立模型 tournament，而不是提前指定赢家：

1. no-skill 基线：0.5、历史条件频率、Polymarket 中间价；
2. 零漂移 GBM 与旧公式复现基线；
3. EWMA、GARCH(1,1)；
4. Student-t/skew-t 的 EGARCH、GJR-GARCH、CGARCH/APARCH；
5. 带正则化、固定特征清单的逻辑回归和经过 shrinkage 的经验漂移；
6. HMM/regime，以及必要时的 jump diffusion、EVT/GPD 尾部模型和微观结构特征。

每个模型都必须按市场时间 walk-forward，训练/选择/最终 holdout 不重叠，并使用
embargo 防止相邻窗口污染。比较指标至少包括 log loss、Brier、calibration、相对市场
报价的增量信息，以及扣除动态手续费、滑点、未成交和延迟后的净 PnL。复杂度只有在
样本外稳定优于更简单基线时才被接受。

### 5.3 VaR/CVaR 的正确位置

`lesson-06-var-cvar.html` 说明 VaR 是损失分位数，CVaR/Expected Shortfall 是超过该
分位数后的平均尾损。正态 VaR 会低估加密资产肥尾；历史模拟、Cornish-Fisher、
Student-t 或 EVT 需要在独立数据上比较。

VaR/CVaR 属于组合级 sizing 和风险预算，不是预测上涨概率的 alpha 模型。对单个有界
二元头寸，最大损失仍需以 `stake + fees + slippage` 硬上限控制；对跨时间重叠市场、
多策略和未结订单，再用压力情景、VaR/CVaR、最大回撤和集中度共同限制。任何
CVaR/Kelly 规则都不能替代单笔、单市场、每日亏损、未成交单和数据新鲜度硬门禁。

## 6. 回测可信度和前视/选择偏差

现有回测不能作为预期实盘盈利证据，主要原因如下：

1. `strategy/replay.py:488-499` 使用历史 records 生成决策 tick。新参数只在旧系统当时
   成功记录过的时刻运行，形成样本选择偏差。
2. 同时间戳排序让行情事件先于 tick（`replay.py:737-758`），又缺真实 receive latency，
   容易使用当时尚不可见的信息。
3. 历史窗口使用当前配置，模型/fee/阈值配置会漂移；`replay.py:515-523` 重建资金时
   还没有过滤 simulated 数据。
4. `strategy/sweep.py:592-668,813-860` 在同一两日窗口选择并报告最好参数；所谓 day1、
   day2 又是 full-2d 的子集，不是独立 holdout。
5. 多参数比较后使用配对 t 检验，没有多重比较和序列相关修正。
6. 每个策略的 Brier 只在它自己开仓的样本上计算（`sweep.py:132-158`），样本集合不同，
   无法公平比较概率质量。
7. golden 测试依赖外部 `D:\polymarket-data` 数据，不是自包含、不可在当前环境稳定运行。

### 6.1 常见未来泄漏 API 的专项检索

对生产 Python 精确检索了 `merge_asof/.asof`、`rolling/shift/resample`、
`interpolate/fillna/ffill/bfill`、各类 `Scaler/fit_transform`、`train_test_split/
TimeSeriesSplit/shuffle` 以及 pandas/numpy/sklearn/scipy/statsmodels/arch 导入；没有发现
用于建模的数据框 join、填充、全样本 scaler 或随机拆分实现。发现的 `merge` 是
`strategy/replay.py:743-758` 的 `heapq.merge` 事件合流，SQL JOIN 主要用于 records 与
markets/资金查询。

“未发现这些 API”不等于没有泄漏。当前已确认的是更底层的 point-in-time 缺陷：未来
窗口校准常量、当前 config 覆盖历史、anchor 未按可用时刻 gate、真实 records 决定 tick、
整窗质量事后筛选、同窗网格选优和毫秒 tie 排序。这些必须先修复。

项目没有完整的监督训练 pipeline，因此不存在典型的 scaler fit-on-all-data 代码；这不
代表没有 leakage。当前最严重的泄漏风险是时间可见性、重叠窗口、事后 tick 选择、
当前配置污染历史和同窗挑参。

## 7. 假成交和假盈利来源

### 7.1 理想化全部成交

`order/trader.py:103-132` 只根据当前卖一价和可见量生成 intent；
`strategy/main.py:340-359,405-436` 随即把全部数量记为成交。没有：

- 网络/处理延迟和排队位置；
- 盘口在请求到达前变化；
- 多档冲击和价格改善；
- 部分成交、未成交、拒单、市场关闭；
- 撤单与成交竞态；
- 实际 maker/taker 归属和舍入。

所以旧 PnL 至多是理想上界，不能称为可实现收益。

### 7.1.1 可成交价格和 PnL 验收不变量

旧 buy intent 确实使用对应 outcome 的 best ask，而不是 mid；这一点由
`order/trader.py:1-6,41-87` 支持。但它只证明“报价侧选对”，不证明该 ask 在订单到达时
仍存在或能全部成交。新回测必须机器强制：

- 买入只能按当时可见且经过延迟后的 ask 或更差价格成交；
- 卖出只能按当时可见且经过延迟后的 bid 或更差价格成交；
- midpoint、last trade、signal price 不能冒充可成交价；
- 每个 partial fill 按自己的价格、数量、maker/taker fee 入账；未成交数量不产生头寸；
- Up/Down 每股 payout 只能是版本化规则下的 0/1（或明确的 disputed 状态）；
- realized PnL、资金释放、重复 settlement 和 official outcome 改判必须幂等，且逐 fill
  会计恒等式可由 golden 重算。

### 7.2 手续费漂移

`market/feeds/polymarket.py:180-182,251-259` 虽发现市场 fee 字段，
`strategy/main.py:163-166` 却使用全局配置；配置默认 200 bps，注释/README 又出现 700/
1000 bps。当前官方要求按市场查询 fee 信息，Crypto 费率和启用时间也会变化；不能硬
编码旧值。当前公式、舍入和按市场查询方式见
[Fees](https://docs.polymarket.com/trading/fees)。动态 fee 元数据必须与数据集一起版本化。

### 7.3 simulated 数据污染报表

资金池查询排除了 `simulated=1`（`core/storage.py:334-338`），但 settled records、trades
和主报表查询没有过滤（`storage.py:490-530`、`strategy/report.py:35-70,1947-1960,
2298-2331`）。因此离线回填/模拟行仍会进入 PnL、Brier、策略比较和 CSV。项目知识记录
过 625 条模拟记录制造巨额“盈利”的事故；当前代码只显示警告，未从统计口径剔除。

### 7.4 标签和资金约束

历史结算曾用错误 Binance 标签和冻结的 Chainlink 价，后续虽增加 official reconcile，
旧报告仍可能被错标签污染。官方改判先提交 records，再逐策略修改 bankroll
（`core/storage.py:448-475`、`strategy/settlement.py:186-193`），崩溃可造成账本漂移；
settle 也没有数据库级幂等键。

入场不冻结 `stake + fee`，只有结算时才向 bankroll 加净 PnL。相邻五分钟市场在前一盘
未结算时可重复使用同一现金，`hedge_topup()` 还绕过普通单笔/市场预算
（`order/trader.py:135-161`）。这会高估可投入资本和收益率。

## 8. 实盘失败位置

### Critical

- `api/handler.py:929-968` 的 live-toggle 和下单端点没有经过 `156-157` 的 Bearer 守卫，
  普通响应又允许 `Access-Control-Allow-Origin: *`（`335-359`）；前端请求也不带 token。
  本机恶意页面/进程可切换实盘并请求下单。
- `order/service.py:150-160` 先调用真实 `post_order`，随后临时 intent 缺 `stake/fee`，
  `core/storage.py:268-272` 访问字段时可报错并返回 HTTP 500。真实订单可能已成功，但用户
  看到失败并重试；没有 idempotency key，会重复下单。
- 没有独立且结构性强制的 `LIVE_TRADING_ENABLED=false`。旧系统主要依赖可热改的
  `paper`，没有 dry-run、幂等、中央熔断和恢复门禁。

### High

- 自动实盘把 `cfg.polymarket` 传给 `place_order`，后者读取不存在的
  `token_id_up/down`（`strategy/main.py:372-373,442-443`、`order/trader.py:202-203`）。
- 只有 GTC buy；没有可靠撤单、订单状态、部分成交、真实 fee、持仓对账或重启恢复。
  `order_id=None` 仍可能返回 `ok=True`。
- 纸面 records 在真实下单确认前已经按理想全成写入，实盘 fill 与账面 PnL 完全脱节。
- 凭据模块允许明文兼容（`order/creds.py:1-15,87-107`），API session 又在内存保存完整
  key/secret/passphrase 且无 TTL（`api/handler.py:80-100`）。本次未读取任何值。
- `watchdog/config_edit.py` 直接覆盖配置文件，没有锁或原子 rename；并发/崩溃可能损坏
  live gate 与策略配置。

这些代码不应该“修补后马上实盘”，而应当废弃其执行实现，仅把事故场景转成新系统的
负向测试。

## 9. 测试证据

当前 WSL 中，仓库的空 `rust_vol/` 会被识别为 namespace package；
`strategy/signal.py:179-187` 只捕获 `ImportError`，随后访问不存在的 `EwmaVol` 会触发
`AttributeError`。这是测试可移植性缺陷。

为保持只读，审计时设置 `PYTHONDONTWRITEBYTECODE=1` 并在进程内禁用该可选模块，运行
两组离线测试：

- signal/sizing/Polymarket parser：51 项通过；
- storage/replay/trader/phase2：57 项通过；
- 合计 108 项通过，未联网、未下单、未写参考项目。

这些测试证明部分纯函数和旧 fixture 内部一致，不证明当前 market channel、动态 fee、
真实成交、部分成交、幂等和恢复正确。缺失的关键测试应转成迁移前的 golden/negative
suite。

## 10. 保留、替换和废弃

### 保留业务知识并重构

- 5 分钟 slug/区间/标题校验和按 outcome 名称映射 Up/Down token；
- Chainlink 同源开收盘、平局 Up、陈旧保护、official reconcile 场景；
- `src_ts/recv_ts`、固定采样 EWMA、数据质量和脏区间思想；
- edge/fee/深度/Kelly 的业务含义，但所有公式需重新验证；
- 结算、模拟标记、对账、错误标签等事故样本；
- 独立、脱敏、自包含的纯函数测试和协议 fixture。

### 用成熟 Python 库或新模块替换

- 研究数据：Polars、PyArrow、DuckDB；
- 统计/优化：NumPy、SciPy、statsmodels、`arch`；
- schema/config：Pydantic；
- 研究测试：pytest、Hypothesis；
- 数据集/模型 manifest、事件驱动回测和 fill simulator 由新项目维护。

这里只是目标依赖建议，本阶段未安装任何包。

### 废弃运行时实现

- 旧 live toggle、manual order service、`order/trader.py` 的实盘提交；
- 旧 orders 表作为订单真相、纸面立即全成和无现金冻结的账本；
- 未过滤 simulated 的绩效查询；
- `dashboard.py` 与 `api/legacy_dashboard.py` 的重复副本；
- `scratchpad/`、`_tmp/`、备份压缩包、旧数据库及一次性脚本。

废弃不代表删除参考项目；这些文件继续只读保留，用于事故追溯和构造测试。
