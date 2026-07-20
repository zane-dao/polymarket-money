# 2026-07-17 K/J paper 主线收敛

## 目标

以 `polymarket-money` 为唯一主项目，重新核验旧 K/J 和现有资产，并贯通第一版可运行的
历史策略研究与 paper simulation MVP 闭环；公开网络仅在用户批准后用于官方协议核对和
有界实时验收，不读取凭据，不进入 shadow/live。

## 事实与证据

- 旧 K/J 不在两个独立文件中，而是 `config.toml` variant、`signal.py`、`main.py`、
  `trader.py`、`storage.py` 和 `settlement.py` 的公共执行链。
- J 是 fee-aware 单速波动率版本；K 在 J 上加入 Binance USD 信号与
  `max(fast, 0.4*slow, absolute floor)` 双速波动率。
- Batch 3B receipt 有 5,599 个有效市场、16,797 个决策样本、100% 官方标签和决策点
  Binance 覆盖。21 个官方 1 秒归档共 1,814,400 连续秒、0 gap，已构建 16,797 点规范化
  5 秒 EWMA artifact，hash `387201c1...6265da`。
- 新 `poly-lab paper-kj` 已在 Final Test 实跑：BASE 下 J/K 净 PnL分别 +4.89566986/
  -298.45735874；+1 tick 下分别 -85.90779747/-387.15306309。J/K 去最好三天均为负。
- 真实运行发现并修复“压力 tick 把非法 ask 变成成交”和“未来成交价反向重算 intent”两项
  模拟时序错误；最终 BASE/STRESS 成交数一致，执行只可缩减冻结 intent。
- 两个权威 artifact 各有 2,558 条事件；代码/数据/result hash、CSV/NDJSON 数量、现金/
  仓位/PnL 恒等式复核通过。
- TypeScript `kj-paper-engine-v2` 已在 public runtime `paper` 模式且显式提供 journal 时消费
  ready StrategyContext：
  J/K 独立钱包、最坏允许滑点预留、冻结 intent、1 秒延迟、partial/no-fill、真实 token
  position 和 `INIT -> RUNNING -> STOPPING -> DONE` 已有确定性测试。
- 实时 engine 只接受由 Gamma exact raw response 重建的 `OFFICIAL_RESOLUTION`；market、
  token、时间、closed/status 和唯一 1/0 winner 任一冲突均失败关闭。
- 共享 probability golden 覆盖代表/尾部 z-score，TypeScript 正态 CDF 近似相对 Python
  `erf` 的绝对误差门为 `0.0000002`；第二份共享 golden 已对拍 J 拒单与 K 从 EWMA、intent、
  fill 到官方结算/PnL 的代表路径，但不声称所有分支穷举等价。
- `kj-paper-input-journal-v2` 只有显式启用才允许实时 wallet mutation；每个 context 和原始
  Gamma 结算响应先 fsync、
  SHA-256 链、独立尾 checkpoint 和严格 replay 已恢复 EWMA、钱包、仓位、预留、pending
  intent 与事件。journal 领先 checkpoint 可自愈；篡改、半行、尾截断、symlink/DrvFS/Git
  内路径和倒序输入失败关闭。
- `paper:mvp` 已在提交 `476f21f` 上跑完一个公开实时完整市场并得到 `accepted=true`；唯一
  目标市场为 `btc-updown-5m-1784231100`，J 净 PnL `+434.16624480995488`，K 为
  `-51.81176196`，无 pending/终止错误/凭据/User Channel/真实订单。单场成绩不是盈利证据。
- 首轮暴露官方结果晚于 90 秒及尾部误纳下一市场；最终版使用半开目标窗口、600 秒默认
  宽限、`paper:settle` 冻结窗口恢复及全部结算后提前退出。
- 后续审计发现外部 `run-plan.json` 未进入 journal 哈希链，无法排除事后改窗口；`1202b07`
  新增首个 context 前的 `RUN_PLAN` 记录，并让未来 MVP 验收强制要求计划绑定。
- `paper:report` 现会重放核对 accepted result、runtime safety、snapshot、官方结算对和
  `payout-spent=gross`、`gross-fee=net`、累计 PnL=钱包变化，再导出带 source/CSV/artifact
  hash 的 JSON/CSV。现有旧单场报告被明确标成 `LEGACY_UNBOUND`。
- `ce1d819` 抽出运行/恢复共用验收器并新增 `paper:finalize`；计划绑定的超时运行可在
  `paper:settle` 后 no-overwrite 生成 `RECOVERED_FINAL`，报告器自动优先验证它。缺计划、
  unsafe runtime、仍 pending 或非 clean child exit 均不能被恢复“洗白”。
- `76131eb` 逐项审计总目标并修复 Batch 06 旧状态：审计当时工程 MVP 已完成，但新 HEAD 的
  计划绑定多市场公开运行、稳定策略 edge、真实 fill/交易所对账和 shadow/live 均未证明；
  其后首项缺口由下述已批准运行补齐。
- 用户批准后，`paper:mvp -- --markets 3` 在 `76131eb` 完成首个 plan-bound 公开运行：目标
  2026-07-16 23:00--23:15 UTC 的 3/3 市场均官方结算，`INITIAL accepted=true`、479 条
  journal、无 pending/凭据/私有频道/订单。重放报告为 `DESCRIPTIVE_PAPER_ONLY`，11 项
  safety/plan/snapshot/settlement/PnL 核验均通过，artifact hash 为
  `6fb04978225a1680c5e747d8b8b2544111e650fafc197e4b163525608d38d775`。
- `e6b2780` 在不联网条件下新增 `paper:cohort-report`，只接收 hash-chained、replay-verified
  描述性报告，重新核验 artifact hash，并拒绝 legacy、重复 run ID、重叠窗口和篡改输入。
  它只输出累计/分布统计且永久 `profitabilityClaimEligible=false`；首个一运行 cohort hash 为
  `2509e8cf5948ce355c852c70fff7208e2232aafb42c0ffeb20fb4fdd8305d865`。

## 修改

- AI 项目层：更新 INDEX、CURRENT、ROADMAP、DECISIONS 和会话索引；D-022 取代 D-021。
- 代码层：新增 `kj_paper.py`、`kj_ewma.py`、build/paper CLI、TypeScript K/J
  StrategyContext、实时 paper engine、专项测试、Batch 06 设计/结果与 README 入口。
- 代码层新增 durable input journal、runtime opt-in/replay、完整状态 snapshot 和离线
  `paper:inspect`。
- 代码层新增 Gamma resolution adapter、`paper:mvp`、`paper:settle`、`paper:finalize`、
  `paper:report`、目标截止线、计划哈希绑定和自动验收。
- 外部状态：仓外生成 content-addressed EWMA artifact 与 BASE/STRESS 两份 v4 权威结果。
- Git：独立分支 `batch/06-kj-paper-loop`，最新提交链增加 `07a2370`、`476f21f`、
  `74dd016`、`1202b07`、`ce1d819`、`76131eb`，未 push。

## 验证

- `.venv/bin/python -m pytest -q`：200 passed。
- `npm test`：122 passed，TypeScript build 通过。
- `.venv/bin/ruff check .`：通过。
- 两次真实 MVP CLI 运行（其中一次为 plan-bound 3 市场）和独立 artifact 恒等式检查：通过。

## 决定

- `polymarket-money` 成为唯一主项目；旧 UI/workbench 与两个代码参考只读。
- 当前 K/J 标 `CANONICAL_5S_EWMA_OFFICIAL_BINANCE_1S_CLOSE`；J 只在 BASE 微正且不稳，
  K 为负，不进入 shadow/live。

## 未决问题

- 缺旧逐笔流、legacy `vol_epoch` 与 K 的 Binance USD 换算，不能证明逐 tick legacy 等价。
- 历史 row 仍缺已验证 token ID 的 position、多批建仓和重叠市场 cash reservation。
- 首个计划绑定三市场 MVP 已通过，但尚无多次独立运行的分布；公开 CLOB continuity 仍为 `UNVERIFIED`，
  代表性跨语言 golden 也不等于穷举所有 no-fill/lifecycle 分支。
- 现有 accepted 单场发生在 `RUN_PLAN` 前，因此只能生成 `LEGACY_UNBOUND` 描述性报告；
  下一次多市场运行才会验证新的 hash-bound 计划路径。

## 下一步

在冻结配置下积累独立的多市场 paper 运行，以 `paper:cohort-report` 汇总结算延迟、连接稳定性、成交/未成交和逐策略 PnL；
不得用单场正收益或 Final Test 反向调参。

## 续办：两运行 cohort、L 历史门与恢复边界（2026-07-17）

### 事实与证据

- 第二个用户已批准的三市场公开 K/J paper 运行
  `kj-paper-20260717011239-edcb5933` 在 `e6b2780` 收集；01:15--01:30 UTC 的 3/3
  目标官方结算，`INITIAL accepted=true`、505 条 journal，所有九项 acceptance check 为 true。
  replay report artifact hash 为
  `15f776e2e972401cff33a3030889b728738018ac08232f0b3e260d307c061c30`。
- 两个不重叠、计划绑定运行的 cohort 位于
  `/root/polymarket-money-data/kj-paper-cohort-two-runs-20260717`，cohort hash
  `cba4f224237d0cd6a1c3984c1114920b101bc66a0e6cdd35e262c42417bc0410`。六市场中 J 20
  笔、K 18 笔；始终 `DESCRIPTIVE_PAPER_ONLY`、`profitabilityClaimEligible=false`。
- 新提交 `5fa8d66` 增加 Python-only `L_ADAPTIVE_EXECUTION`：动态 relative edge、平滑
  30/60/120 秒 RMS+shock 波动、概率拖累、动态 anchor band、深度及延迟/reprice-risk 逐项
  审计。它与 J/K runtime/MVP 隔离，CLI/API/通用 runner 只允许 TRAIN/VALIDATION 并拒绝
  Final Test。
- L V1 未通过历史门：TRAIN（2,880 市场、807 fills）净 PnL
  `-20.6611192571958996264383882`；冻结 VALIDATION（1,440、338）为
  `-1287.046169895371064543169651`。R3 artifact hashes 分别为
  `7dde1a4fff3cb16414e71a6f90c3ea9d1693cf50dc5e66afa7459b2e03d05931` 与
  `9c5caea5b41707e6735983713cec1c2d6cd24234633787d0fe6592ceb08674d5`，按当前源码重算
  一致。
- 历史 receipt 没有连续 CLOB quote 序列或 point-in-time Chainlink boundary：L 只记录当前
  spread 的 1 Hz reprice-risk proxy 并标 `market_quote_velocity_available=false`，不从一秒后
  execution book 偷看速度，也不假装拥有 Binance--Chainlink basis。
- `paper:finalize` 现在可在外层 wrapper 没来得及写 `result.json` 时恢复，但必须从 runtime
  summary 独立证明正常时长结束、无 terminal failure、plan/commit/journal identity 匹配及零
  live/private/order 计数；缺 summary 的中断运行仍不可验收。
- Chainlink provisional 目前只形成设计合同：未经 canonical boundary 证明的 RTDS relay 名为
  `PRELIMINARY_RELAY_OBSERVED`，不得改变 wallet/PnL、释放 reservation 或调用 settle；Gamma/
  UMA final 仍唯一正式结算。
- Windows `D:\polypolycache\polymarket-kj-paper-dashboard.html` 是零依赖静态看板，已包含
  两运行 cohort、历史压力、ask depth、L V1 失败和结算边界；SHA-256 为
  `badf0e2c185a52c8bd8f54d902e7558fbe8d5f6070fa14c3721571041d441dac`。

### 验证

- Python `pytest -q`：205 passed；Ruff：passed。
- `npm test`：123 passed；`npm run typecheck`、`git diff --check`：passed。
- `paper-l-adaptive --help` 只列 TRAIN/VALIDATION；L 两份 R3 result hash 独立重算一致。

### 决定与下一步

- L V1 终止于离线研究，不启动 L public paper、shadow 或 live；不在同一短 TRAIN 样本上
  事后扫参数。若未来要做 L V2，先补齐连续 quote 与 canonical Chainlink boundary 输入，另行
  预注册候选网格、TRAIN 选一次、一次 Validation，Final Test 保持锁定。
- J/K 维持冻结配置。只有获得新的明确联网批准，才继续追加 plan-bound 多市场公开 paper；
  仍不得根据当前 cohort PnL 宣称盈利。

## 续办：运行质量 cohort 与离线可视化（2026-07-17）

### 事实与证据

- 新增离线 `paper:cohort-observability-report`。它先复用 PnL cohort 的 report/hash/窗口
  验证，再逐运行核对 runtime summary SHA-256、paper safety/identity、journal record count、
  journal tail hash 与 replay event count；只有全部一致才汇总公共数据流、Gamma 官方结算延迟
  及目标市场 J/K intent/fill/partial/no-fill/reason。
- 对两个已验收的 `HASH_CHAINED` 三市场报告执行后，仓外结果为
  `/root/polymarket-money-data/kj-paper-cohort-observability-two-runs-20260717`，report hash
  `e4cd5370760da77e75caccbf0e4ed308dbd619aa3f83deee41dbc1d391f46a4d`。六个目标市场的
  official settlement delay 为 234,443 ms 最小、378,462 ms P50、473,648 ms P95/最大。
- 同一结果中，J 为 22 intent、20 fill、12 partial、2 次 `SLIPPAGE_LIMIT` no-fill；K 为
  20 intent、18 fill、9 partial、2 次 `SLIPPAGE_LIMIT` no-fill。CLOB aggregate 为
  1,204,793 事件、1 次重连、248 次 quarantine；这些是运行质量计数，不是 fill 或 alpha。
- `D:\polypolycache\polymarket-kj-paper-observability-dashboard.html` 是新增的自包含、离线
  质量看板；它绑定上述报告快照、包含四张 KPI、两张图与两张表。portable artifact 验证、
  封装和结构校验通过；环境无 Chromium，故浏览器交互/像素级阶段为 `structural_only`。

### 修改

- 代码层：新增可观测性 cohort product、CLI、单元测试、npm 入口以及 Batch 06/README 审计文档。
- AI 项目层：CURRENT、INDEX、DECISIONS（D-026）和会话索引已同步；PnL 与运行质量是不同的
  evidence 表面。
- 外部状态：写入 no-overwrite observability cohort 与 D 盘离线 HTML；没有联网、凭据、私有
  频道、签名、订单、shadow 或 live 行为。

### 验证

- `npm test`：125 passed；`npm run typecheck` 与 `git diff --check`：通过。
- `.venv/bin/python -m pytest -q`：205 passed；`.venv/bin/ruff check .`：通过。
- 新 CLI 在两个既有报告上成功生成上述 no-overwrite artifact；`--help` 通过。
- recovery integration test 现已延伸至 `paper:cohort-observability-report`：从 journal recovery
  生成 final result/report 后，必须能被该 CLI 重开并核对输出。
- 看板 artifact 的 validation/package 通过；无 Chromium，只完成 structural-only HTML 验证。

### 决定与下一步

- 后续获批的公开 paper 运行必须以冻结 J/K 配置继续；其 PnL 与运行质量分别由两条 cohort

## 续办：完整预注册 campaign 证据链（2026-07-18）

- 新增离线 `paper:campaign-plan`：将 campaign ID、当前 Git commit、完整五分钟窗口序列、每轮市场数、间隔和结算宽限 canonical-hash 为 `kj-paper-campaign-v1` artifact；不联网、不采集。
- `paper:mvp` 支持 `--campaign-plan` 与 `--campaign-run`。仅接受下一五分钟边界、相同 commit 和计划内精确窗口，并在首个 context 前写入包含 campaign hash/index 的 `kj-paper-run-plan-v2`。
- 新增 `paper:campaign-cohort-report`：只有完整计划内每轮各一次且 hash/index/window/count/commit 全部匹配，才能形成 campaign cohort；它仍为 `DESCRIPTIVE_PAPER_ONLY`，不能宣称盈利。
- 新增 campaign v2 journal/recovery、报告绑定、完整 cohort 与 MVP 时序拒绝测试；本地 `npm run typecheck`、`npm test` 通过，Node 131/131。
- 尚未创建或启动新的联网 campaign；旧两次运行早于该绑定，只保留原有描述性 cohort 身份。

## 续办：campaign 运行质量样本完整性（2026-07-18）

- 新增 `paper:campaign-cohort-observability-report`。它在重放 runtime/journal 前先强制完整 campaign 的 hash/index/window/count/commit 约束，因此收益与网络/结算/成交质量不能采用不同的事后子集。
- 既有一般 `paper:cohort-observability-report` 保留用于诊断；它不构成完整 campaign 证据。
- 本地 `npm run typecheck`、`npm test` 通过，Node 132/132；未联网、未启动新采集。

## 续办：campaign 延迟结算恢复保持绑定（2026-07-18）

- `paper:finalize` 不再将 `run-plan.json` 直接断言为计划类型；对可选 campaign binding 校验严格字段、ID、hash 和正 run index。
- 端到端恢复测试改为 v2 campaign journal：Gamma 官方结算追加后，`final-result.json` 与 `paper:report` 仍含相同 campaign binding；Node 132/132、typecheck 通过。

## 续办：Chainlink 结算边界官方复核（2026-07-18）

- 当前官方 BTC 5m 规则确认 resolution source 为 Chainlink BTC/USD；官方 RTDS 文档确认公开 `crypto_prices_chainlink` 可提供 `btc/usd` 值与毫秒 timestamp。
- 这支持保留 Chainlink relay 作低延迟 signal、preliminary direction 和最终一致性观测；但官方市场页也警告 live data 可能延迟，未定义 RTDS frame 为各市场精确开/收边界的 canonical record。
- 决定不变：不得作为 wallet/PnL/DONE 结算，也不能宣称 100% 准确；Gamma resolved 原始响应仍是唯一最终证据。详见代码仓 `chainlink-provisional-settlement.md`。

## 续办：双信号 paper 基础层（2026-07-18）

- 用户要求停止已启动的单 Binance campaign；进程已正常 TERM 退出，run-plan/journal 保留但标记为中止证据，绝不纳入 cohort。
- runtime 新增 `--kj-signal-source binance|chainlink`。Chainlink relay 作为独立 provider/receive stamp/connection/hash 进入严格 context/journal，不可伪装成 Binance。
- 这不是混合 EWMA：下一步为 Binance/Chainlink 各自 K/J 钱包、anchor、EWMA 与 journal 的并行比较模式。当前只完成 source-selector 基础，Node 133/133、typecheck 通过，未重新启动采集。
  命令汇总。两者都不产生 profitability/shadow/live 资格，且不得用于事后调参。
