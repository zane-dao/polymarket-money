# 当前计划与状态

更新时间：2026-07-18

## 当前阶段

Batch 1、2、2.5、3A、3B、Batch 4B-R1 与产品批次 5P 已完成；Batch 4B-R2 以
`INCOMPLETE_EVIDENCE` 关闭且不重跑。最新目标已把 `polymarket-money` 定为未来唯一主项目，
旧 workbench 降为参考。Batch 06 已完成 K/J 历史 paper 闭环及规范化 5 秒 EWMA artifact。
J 只有 BASE 微正且压力转负、盈利集中；K 两种情景均负，不进入 shadow。公共 runtime 的
paper 模式现已有实时 K/J 决策、内存钱包、预留、延迟/部分/no-fill、token position 与市场
生命周期。只有显式 durable journal 才允许钱包变化，重启可严格 replay 恢复。Gamma
官方结算证据、目标窗口、延迟结算恢复和单命令 MVP 已接通；一场公开实时端到端运行通过
自动验收。该单场结果只证明产品闭环可运行，不改变 K/J 历史样本外结论。
随后第二个不重叠、计划绑定的三市场运行也完成 `accepted=true`，二运行 cohort 仍永久
`profitabilityClaimEligible=false`。新 Python-only `L_ADAPTIVE_EXECUTION` 采用动态相对
edge、波动拖累、平滑 30/60/120 秒波动混合、动态 opening-anchor band 与深度/延迟风险项；
它只允许 TRAIN/VALIDATION，V1 训练为 -20.66、冻结验证为 -1,287.05，故历史门失败，未打开
Final Test；它保留为独立研究候选，尚未自动混入当前 K/J 实时 paper/shadow/live 路径。`paper:finalize` 现也能处理外层 wrapper 在
写 `result.json` 前中断的情况，但只有 runtime summary 能独立证明正常时长结束、身份匹配及
零 private/live/order 计数时才可恢复；不完整采集仍不可验收。

2026-07-18 已完成一轮 Binance Spot 与 Polymarket RTDS Chainlink 的同窗口三市场配对
public paper 诊断：两腿都以同一计划 hash、同一窗口和同一 collector commit 运行，均
`accepted=true`，并已生成逐腿 replay report 与配对 hash report。该轮的 J Chainlink-Binance
净 PnL 差为 `+103.43693357`，K 为 `-83.453704855`，但只能作诊断：runtime 在目标首个
完整市场之前把一个预热市场登记进 engine（总 engine market=4、目标=3），所以不纳入正式
比较或盈利证据。`8320683` 已修复为显式 `--kj-market-start-at` 边界，早于首个目标市场
不得注册策略上下文或结算候选。

边界修复后的干净配对运行 `kj-compare-20260718-0530-clean` 已完成：计划 hash
`a081f03f21af323c334e170defc141cf0ba68b7b69a08cb2e9e5833fa9471a9e`，两腿均为
3 target/3 engine market、`accepted=true`、无 pending、无 private/live/order。配对报告 hash
`d3b68c5b27d872b3b355d5fb87a963e1b63a82ddef143eab11827acae465779d`；J 的
Chainlink-Binance net PnL 差为 `-505.6578659525010368`，K 为
`-613.21287683137571787009131215169552720247718341239780457777615391397498229624127`。
这仍只是极小样本、独立 receive clock 下的描述性 paper 比较，永久
`profitabilityClaimEligible=false`。该边界也意味着首个目标市场没有借用上一市场的 K
EWMA 预热。随后 `c6c86ac` 已把预热输入实现为独立 `WARMUP_SIGNAL` journal：它只重放 EWMA，
不能创建 market session、intent、钱包事件或 Gamma 结算候选；每次 MVP/paired plan 预留完整
180 秒，且 journal 拒绝 Binance/Chainlink source-family 混用；正式 v3 重跑状态见下文。

2026-07-18 已在 `c6c86ac` 启动采用该合同的 Binance/Chainlink 三市场配对运行
`kj-compare-20260718-0610-warmup`（06:10--06:25 UTC）；两腿在首个目标市场前只记录
`WARMUP_SIGNAL`，第一条 `CONTEXT` 同为 market `2956973`、06:10 UTC，未出现计划前 market
session。该运行后来已完成 Gamma 结算；其正式解释见下文。`2387b7c` 令后续 report 对声明
180 秒预热的计划强制核验 durable count、完整时长和 source family。另以当前树重新执行冻结
历史 FINAL_TEST BASE_1S，逐项复现 J `+4.8956698638498977551796894`（去最佳三天为
`-240.9092959911501022448203106`）与 K `-298.4573587392367656725813702`，故本轮公开
paper 不触发调参、shadow 或盈利宣称。

`kj-compare-20260718-0610-warmup` 使用启动时的 `c6c86ac`，其 v2 RUN_PLAN 尚未 hash-bind
`warmupSeconds`；故无论其 Gamma 结算如何，都只能验证运行期 warmup 行为。`9318a2f` 已升级
后续正式运行到 v3；只有 v3 + durable warmup report 才可成为 paired/campaign evidence。

该诊断运行已于 06:31 UTC 完成 Gamma 结算：两腿均 `accepted=true`、各 3/3 目标市场完成、
无真实订单和无 pending market。Binance 预热为 284 条/290.272 秒，Chainlink 为 251 条/
288.668 秒，均在 06:10 UTC 首个目标前结束且来源家族一致；这验证了运行期隔离，不能补回
缺失的 v3 预注册。其描述性净 PnL 分别为 Binance J `-365.5837662522724212482694532420489673614140226440857971894024161277475393047469`、
K `-225.704491905`；Chainlink J `+258.95099574`、K `+221.217665115`。当前 v3 正式配对运行
`kj-compare-20260718-v3-warmup-formal` 已在 06:35--06:50 UTC 窗口启动；它的 commit 为
`84c8d4a`，预热秒数在任何输入前写入 v3 RUN_PLAN。

该正式 v3 运行已在 Gamma 结算后由 replay 完整验收：两个子报告和 paired report 均
`accepted=true`、`evidenceStatus=DESCRIPTIVE_PAPER_ONLY`、`profitabilityClaimEligible=false`。
Binance 预热为 195 条/198.011 秒，Chainlink 为 163 条/194.424 秒；两者均满足 180 秒、同源
family 和首个目标前结束的核验。paired report hash 为
`f1782e47a6dcbce746084359b4f9b63a73eef1fee5a9b4c552874407beb0f071`：J 的 Binance/Chainlink
净 PnL 为 `-119.7409353918464`/`-142.931408445`（差 `-23.1904730531536`）；K 为
`+79.142582164967037284978315918153505835783100969234799313094856943272113397560909`/
`+78.026065729393277098573507582152108740576883895567133335273743341968157871758`
（差 `-1.116516435573760186404808336001397095206217073667665977821113601303955525802602`）。
三市场样本不足以支持策略、参数或信号源推广；保持冻结、不得进入 shadow/live。

`55cb52c` 已将单轮 paired runner 扩展为 `kj-signal-compare-campaign-artifact-v1` 和受限 launcher：
一份 artifact 同时绑定每来源 campaign 及逐轮 source mapping，launcher 只在固定预热时点启动，
错过窗口 fail closed。首个四轮（每轮三市场、间隔两市场）campaign 已预注册为
`paired-v3-20260718-0720`，hash `d3daa4ee40021cf597f8d7ba59c045f0516206d07290260be136728c34d30035`；
计划窗口为 07:20--07:35、07:45--08:00、08:10--08:25、08:35--08:50 UTC。该 launcher 已按
后述 MVP 优先决定中止；它没有形成完整 campaign，任何局部产物均不作 PnL 或质量结论。

2026-07-18 用户明确校正优先级：持续实时测试不是当前 MVP 的必需条件。已停止尚未开始的
接续 campaign、原始长采集和第一 campaign 的后续轮次；被中断的产物不得作为完整 campaign
或策略证据。当前先完成产品操作面、策略回测入口与受控实时 paper 能力，之后才针对明确假设
启动有限测试。主仓 `0965be5` 已增加仅监听 localhost 的 `mvp:console`：它汇总 K/J、L V1、
L V2 历史回测和有界 K/J paper 的规范命令，但不自动联网、启动 paper 或下单。

`08b80e5` 将控制台补成只读研究结果浏览：它仅扫描 `<data-root>/mvp-runs/*/summary.json`（单文件
上限 1 MB），不读取 raw/journal。已在该路径完成一次离线 `v2-midrange-train-selected` Validation
BASE 端到端回放；结果 hash `e36598e51ba4e4334c4ba6f65069f46557aec559f76635fe68d0068b7bccb4c0`，
net `+132.2576903286908614378503338`、46 fills，并由 localhost `/api/results` 重新读取。它仍存在
去最佳日转负、历史连续性未验证等限制，不能作为盈利或实时 paper 准入结论。

`141ac70` 让 console 在默认只读之外，只有操作者显式加 `--enable-local-history-runs` 才接受
localhost 的固定离线回测请求。API 不接受任意命令、参数、输出路径或网络模式，只允许 K/J、L V1、
L V2 三种固定研究配置、一次一个进程；realtime paper 继续没有网页启动入口。已实际通过该 API
启动 L V2 并得到 exit 0，随后 `/api/results` 读到相同 result hash；这是产品操作链路验证，不是
新的策略证据。

`4953375` 将既有 K/J paper 的小型验收 result 加入控制台只读视图：只读取
`paper-mvp/*/result.json` 或 `final-result.json` 的 accepted、plan binding、目标数和策略 wallet
PnL，不打开 journal/metrics，也不启动实时进程。已验证 `/api/paper-runs` 能重现计划绑定运行
`kj-paper-20260716225739-48ff7c99` 的 accepted 状态及 J `182.86189715`、K `205.272819795` 的
paper PnL；该展示仍是描述性、理论 paper 结果，不构成盈利或真实执行证据。

为验证 MVP 的 K/J 主路径，已通过 `141ac70` console 的显式离线 API 重跑冻结 FINAL_TEST BASE_1S，
并由 `/api/results` 读取：J net `+4.8956698638498977551796894`（135 fills）、K net
`-298.4573587392367656725813702`（137 fills），与既有冻结结论一致。它只证明当前产品入口可复现
已知结果，不能用于重新选择 J/K、宣称盈利或启动实时测试。

`9be8541` 消除 MVP console 内“显示命令”和“实际 API 参数”的双重定义：K/J frozen FINAL_TEST、
L V1 TRAIN、L V2 train-selected VALIDATION 均从同一个固定注册表生成。新增单测核对页面所示 L V2
命令与实际执行参数的 candidate/split/output 一致，避免 UI 文案和运行配置漂移。

`ca3fa67` 将 console 的历史与 paper JSON 输出替换为 DOM `textContent` 写入的表格视图：历史行显示
run/split/scenario/strategy/net PnL/fills，paper 行显示 accepted/plan binding/目标完成数/J-K PnL。
页面仍只调用既有只读 API；HTML 路由与关键渲染函数已在 localhost 验证，不新增任何网络、paper 或
真实订单行为。

`a911351` 在历史 Dashboard 追加最大回撤及“剔除最佳三天”压力列，避免单独展示正 net PnL。
已对 L V2 Validation 结果确认显示 max drawdown `232.756190068014095408173561` 和去最佳三天
`-168.2731937063091385621496662`；该负压力结果在界面中与正 net 并列，不得误读为稳定优势。

`3de6179` 已完成对本地研究与 paper MVP 的逐项验收，权威文档为代码仓
`docs/batches/batch-06-kj-paper/mvp-console-acceptance.md`。结论是产品闭环已满足“先做 MVP、后做
测试”的条件：固定历史研究、模拟账户/PnL/export、结果与既有 paper 验收浏览、localhost 安全门均有
实际证据；策略 profitability、real fill、连续性与任何 shadow/live 仍未证明。下一阶段若要重新启动
public realtime paper，必须以具体假设、有限窗口和用户的当次明确联网批准为前提。

`8f709f5` 已在代码仓写入下一轮未启动的受控 public-paper 协议：四轮、每轮三市场、两市场
间隔、180 秒独立预热、600 秒结算宽限，比较冻结 K/J 的 Binance/Chainlink 两个独立信号腿。
它禁止 L 接入 realtime、禁止参数/窗口事后调整与补跑，并把任何失败轮标为 incomplete evidence。
实际 campaign ID、时间、commit/hash 必须在用户当次联网批准后才生成，当前没有 artifact 或采集进程。
`e391916` 又补齐 launcher 的启动互斥：在任何等待或子进程启动前，以原子、fsync 的
`O_EXCL` claim 占用 campaign；已有 claim（包括 launcher 崩溃残留）会 fail-closed 拒绝第二次
启动，不能把漏窗伪装成补跑。该本地改动已通过 typecheck 与 Node 145/145；未启动网络任务。

`1edb2ab` 收紧本地 MVP 控制台的历史结果展示：`/api/results` 只接受能按 Python 的 sorted-key
canonical JSON 规则重新计算并匹配 `result_hash` 的 `summary.json`，页面明确显示 `VERIFIED`。当前
三个已发布本地摘要均通过；该检查不冒充对 event/trade/raw 输入的完整审计。Node 146/146 与
typecheck 通过，仍无网络任务。

`3c55816` 使新的 Python 历史 paper 导出具备逻辑发布提交：`summary.json`、`events.ndjson` 和
`trades.csv` 均 flush/fsync 后计算 bytes/SHA-256，最后才 fsync 写入包含 result hash 的
`publication.json`。中断残留没有该清单，不能作为完整新导出被接受；既有历史 artifact 不改写。
完整 Python 200/200 与 Ruff 通过，仍无网络任务。

`a7f6231` 将上述提交合同接入 MVP 控制台：带 `publication-intent.json` 的新目录必须通过
manifest 自身 hash、result hash 与三份 sidecar 的名字/size/SHA-256 的本地复核，任一不符即不显示；
无 intent 的旧目录仅标记 `LEGACY_SUMMARY_VERIFIED`，不会被误称完整发布。现有三份历史结果均属
旧格式且未改写。Node 146/146、Python 导出单测与 Ruff 通过；仍无网络任务。

`cfb6f64` 以当前工作树重新完成 MVP 完成度审计：Node 146/146、Python 200/200、Ruff、typecheck
与 diff 检查均通过，工作树干净。审计结论不变：`MVP_ENGINEERING_COMPLETE`，但策略盈利、连续 CLOB、
真实成交、shadow/live 仍未证明；此后只应在明确研究问题或当次联网批准下运行有限 public paper。

2026-07-18 用户曾批准生成 `paired-20260718-0900` 的四轮 Binance/Chainlink public-paper plan
（hash `e50dba292eea9e9b3245ccc65b74119a2348004bb454b07e2e88ed0432b79145`），但随后要求立即停止。
launcher 于 08:53:57 UTC 退出，早于 08:56 UTC 预热启动；没有子运行、网络采集、市场、journal 或
PnL。计划与不可变 launcher claim 保留用于审计，该 campaign 永久中止、不得补跑或纳入任何证据。

`517a48a` 把 localhost MVP 从结果表升级为只读研究诊断看板：对已验证历史 summary/events 聚合
Brier、log loss、十档概率校准曲线、有效波动率/（L）拖累 P50/P95/max、成交/拒单原因、日度 PnL、
回撤与集中度压力；同一 result hash 去重。它不读 raw/journal、不联网、不启动策略。浏览器入口为
Windows 默认浏览器访问 `http://127.0.0.1:4173`（需运行 `npm run mvp:console ...`）；Node 147/147
通过。

## 已完成证据

- Batch 1 仍是安全/domain/golden 裁判，tag `batch-1-accepted`。
- Batch 2 以 `d353eca`、tag `batch-2-accepted` 固定；Batch 2.5 在
  `batch/2-5-point-in-time-data` 以 HEAD `88bfe8c`、annotated tag
  `batch-2-5-accepted` 固定；均未 push。
- `normalized-record-v1`、normalized manifest、direct/dependency lineage、
  `as_of(decision_time, market_id)`、六态 market-wide book gate、deterministic canonical
  JSONL、single-writer atomic no-overwrite publish 与 offline load 已落盘。
- PIT 只允许 `visible_at <= decision_time`；future source time 额外拒绝；晚到数据、Gamma
  future identity claim、跨 manifest 同毫秒冲突均不能反写历史。
- 公开 continuity 持续为 `UNVERIFIED`；空侧为 `UNTRADEABLE` 且 midpoint null；Binance 默认
  BTC-only，fallback 必须显式记录；DrvFS/Windows-backed mount 写入前拒绝。
- Batch 2.5 专项 Python 56/56；全量 Python 119/119；Node 40/40；TypeScript、Ruff、全新
  venv install、`pip check`、`npm ci` 与 0-vulnerability audit 均通过。
- Batch 3A 在 `batch/3a-causal-backtest-core` 以 HEAD `d560427`、annotated tag
  `batch-3a-accepted` 固定；fail-first `e66d3b2`，实现 `e01864a`，均未 push。
- ReplayEngine 只能打开 published/hash-pinned normalized dataset；准入分
  EXECUTION_ELIGIBLE/FEATURE_ONLY/EXCLUDED，未来可见性、失效盘口、重复幂等键和隔离结算
  失败关闭。四种执行模型、逐 Fill fee、Batch 1 ledger/settlement/PnL 已落盘。
- 三个人工市场全链路数值净 PnL 为 4.40、5.03、2.19；fixture fee 明确非历史证据，故
  `net_pnl_verified=false`。全量 Python 155/155、Node 40/40、Ruff、TypeScript 与 clean venv
  install 通过。
- 默认 live=false、dry-run=true、credential=none、authorization=false；仍没有可达 live
  adapter、User Channel、签名或订单路径。
- Batch 3B 在 `batch/3b-historical-baselines` 以 HEAD `d00c12b`、annotated tag
  `batch-3b-accepted` 固定，未 push。PRIMARY_V2 有效市场 5,599，官方标签与 Binance 决策点
  覆盖均为 100%，identity conflict、future data 和 split overlap 均为 0。
- 公开行情固定 revision `42d917dc8e3205dde8ac909792af0cce2d715c9f`；normalized dataset
  hash `a27d9d1bf4dc5276c7ae5b11abd64250b6e6dc17f01fd432ab0dc10e4425cafc`，frozen config
  hash `5258fb5c2f71a6a9c2d9e53d1fb18c92002cba7a3adf0e7cf5ca74a0a7b1a0b2`。
- B0/B1 没有正可交易净值；B2 全面差于市场；B3/30 BASE 为 +1.21615681，但 STRESS 为
  -0.07989914、95% CI 跨 0、删除最好三天后为负，结论为 `WEAK_RESEARCH_SIGNAL`。
- 3B 最终 clean venv：Ruff passed、Python 172/172；WSL Node/TypeScript 40/40 且 typecheck
  passed。没有凭据、User Channel、交易端点、shadow 或实盘操作。
- Batch 4B-R1 在 `batch/4b-critical-remediation` 完成；代码复验点 `e4d638e`，最终报告提交
  `6f46b79`。原 `REJECT_AND_STOP` 审查保留，第二次 Sol 唯一结论为
  `PASS_WITH_NONBLOCKING_EVIDENCE_DEBT`。
- R1 已建立 raw-event-v2/ReceiveStamp、双连接 identity、严格 baseline/fixed-horizon as-of、
  252-cell grid、500ms episode、RuntimeIncident emergency terminal path、decimal.js 私有 clone、
  单一 FeeEdgeCalculator、immutable OpportunityObservation 与独立 RouteEvaluation。
- R1 最终 Python 190/190、Node 89/89、Ruff、TypeScript、clean venv、pip check、npm ci 与
  0-vulnerability audit 均通过。没有启动 150 分钟观测、创建 4A/4B tag、训练、shadow/live、
  User Channel、凭据、签名或订单。
- Batch 4B-R2 在 `batch/4b-r2-24-market-observation` 收口于 HEAD `f150e08`，未 push、未创建
  R2/4B/4A 验收 tag。冻结配置 SHA-256 为 `074324aa...9127c`。
- 有效 metrics-only run 运行 7,262.862 秒，raw=false，24 observed、15 complete、34 incidents，
  最终因市场窗口外 fee evidence terminal fail closed；continuity 始终 `UNVERIFIED`。
- Complete-set 2,340 audits、正 edge 0；lead-lag 252 格、71 triggers、51 episodes、11 markets，
  但全部 trigger 来自 Chainlink；maker 无 markout/queue/fill。判断为 `LOCAL_SHORT_CAPTURE_ONLY`。
- 运行后补齐 Gamma fee 原始词法、市场窗口拒绝、working-history 清理、共享 AbortSignal socket
  收口和低开销 metrics snapshot；不追认旧观测。最终 Python 190/190、Node 95/95、Ruff、
  TypeScript、clean venv、pip check、npm ci 与 0-vulnerability audit 全部通过。
- Batch 5P 在 Linux-native 工作副本 `/root/projects/polymarket-paper-workbench`、分支
  `integration/research-workbench` 完成。产品主体沿用旧 Tauri/React/Python API；来源 commit
  `d08ba3e`、tree `b00786a`、archive SHA-256 `63d2a8b0...169e`。
- Research Workbench 支持 D 盘 Legacy SQLite、K/J/已有变体、Historical Replay、公开
  Live Monitor、Paper Simulation、只读参数、Start/Pause/Stop/Reset、状态/交易/PnL/日志及
  JSON/CSV 导出；Strict 接口预留但未迁移。
- React production build 与 Tauri release build 均通过，WSLg 窗口实际打开；公开 smoke 在
  1 秒内取得当前 BTC 5m 市场、Up/Down top 与公开 BTC，随后 Stop。关键 Python 71/71，
  npm audit 0 vulnerabilities。
- Batch 5P API 强制 workbench safe mode：auth/account/order/watchdog/config-write 均 403；
  无凭据、签名、User Channel、真实订单或常驻进程。单命令入口为工作副本
  `./scripts/run-workbench.sh`，`--offline` 禁用全部公开行情线程。
- Batch 06 在新主仓增加 `poly-lab paper-kj`：只接受 hash 验证通过的 Batch 3B receipt，
  纯函数重建 J fee-aware 与 K dual-vol proxy，按 1 秒延迟/额外 1 tick 两种情景模拟，维护
  独立现金、成交后仓位、官方标签结算和 gross/fee/net PnL，并 no-overwrite 导出
  `summary.json`、`events.ndjson`、`trades.csv`。
- 规范化 EWMA artifact 校验 21 个官方 Binance zip/checksum，连续读取 1,814,400 秒、0 gap，
  产出 16,797/16,797 决策点；hash 为 `387201c1...6265da`。忠实度为
  `CANONICAL_5S_EWMA_OFFICIAL_BINANCE_1S_CLOSE`，不是 legacy tick/source/phase 等价。
- Batch 06 Final Test、30 秒 horizon、每策略 10,000 初始现金：BASE 下 J 为 +4.89566986、
  K 为 -298.45735874；+1 tick 下 J 为 -85.90779747、K 为 -387.15306309。J 去最好三天后
  BASE 为 -240.90929599，K 为 -468.14814271；均不是 research candidate。
- 权威 K/J artifacts 位于仓外
  `/root/polymarket-money-data/paper-runs/kj-ewma-v4-final-test-30s-{base,stress}`；结果 hash
  分别为 `3df7f5ba...283a29` 与 `f990a72b...1d0c8`。逐项复核 hash、2,558 条事件、CSV
  行数、冻结 intent、现金/仓位和 PnL 恒等式通过。
- Batch 06 当前验证：Python 205/205、Node 132/132、Ruff、typecheck 与 diff check 通过；
  两份 L artifact 以当前源码重算 hash 一致。只使用已批准的公开网络核对/运行与本次离线
  历史重放，没有凭据、私有频道、签名、订单、shadow 或 live。
- TypeScript public runtime 已输出 `kjStrategyContextReady/reason/context`，绑定 market/token、
  fee、盘口、signal source/receive/connection/hash 和 ReceiveStamp；stale、crossed、future、
  mixed-clock、缺 fee 或非运行市场均失败关闭。
- `kj-paper-engine-v2` 只在 runtime `paper` 模式且显式提供 journal 时消费 ready context；
  独立 J/K 钱包以最坏允许
  滑点预留现金，冻结 intent，经 1 秒后按真实后续盘口 partial/no-fill，市场结束停止扩仓，
  只有显式 `OFFICIAL_RESOLUTION` 可进入 DONE。冲突 context/input/settlement 失败关闭；
  `monitor` 不改钱包。
- `kj-paper-input-journal-v2` 对每个接受 context 或原始 Gamma 结算响应先 fsync，再应用到
  engine；连续序号、SHA-256
  链与独立 atomic checkpoint 检测修改、半行和整行尾截断。重启严格重建 EWMA、市场、
  钱包、仓位、预留、pending intent 与事件；journal 领先 checkpoint 的崩溃窗口可自愈，
  symlink、DrvFS 和 Git 内路径拒绝。`paper:inspect` 可离线导出恢复后全状态。
- Batch 06 独立分支 `batch/06-kj-paper-loop` 在原提交链后新增 `07a2370`、`476f21f`、
  `74dd016`、`1202b07`、`ce1d819`、`76131eb`，工作树干净，未 push。
- `paper:mvp -- --markets 1` 在固定提交 `476f21f` 上完成公开实时验收：目标市场
  `btc-updown-5m-1784231100` 唯一纳入目标，官方 Down 结算后 `accepted=true`；J 4 笔、
  净 PnL `+434.16624480995488`，K 1 笔、净 PnL `-51.81176196`，无 pending、终止错误、
  凭据、User Channel 或真实订单。artifact 在
  `/root/polymarket-money-data/paper-mvp/kj-paper-20260716194322-59e2d360`。
- 首轮 90 秒结算窗口暴露 Gamma/CDN 延迟和下一市场泄漏；最终版改为半开目标窗口、默认
  600 秒宽限、完成后提前退出，并提供 `paper:settle` 对冻结窗口恢复。首轮目标随后通过
  recovery 完成，不伪造 winner。
- `1202b07` 增加 journal `RUN_PLAN`：未来 MVP 在首个 context 前 hash-bind run ID、目标
  数量/窗口和 collector commit；`paper:report` 必须重放 journal 并核对 accepted result、
  runtime safety、snapshot、结算对、逐市场与钱包 PnL 恒等式，no-overwrite 导出带 source/
  CSV/artifact SHA-256 的 `summary.json` 与 `markets.csv`。
- 已对现有 accepted 单场生成报告
  `/root/polymarket-money-data/kj-paper-report-20260716194322-v2`，artifact hash
  `ae1e8df6...c8725`；因该运行早于 `RUN_PLAN`，明确标为
  `DESCRIPTIVE_PAPER_ONLY_LEGACY_UNBOUND_PLAN`，不得冒充预绑定样本。二次同路径运行以
  `EEXIST` 失败且两个文件 hash 不变。
- `ce1d819` 抽出 `paper:mvp` 与恢复共用的唯一验收器，并新增 `paper:finalize`：只有原始
  result 证明 child clean exit、runtime identity/safety 通过、计划已 hash-bind、全部市场
  官方结算且无 pending 时，才 no-overwrite 写 `final-result.json`，kind 为
  `RECOVERED_FINAL`；`paper:report` 自动优先验证该结果。离线端到端测试覆盖初始 pending、
  settle 后 accepted、缺计划仍拒绝、报告选 final result 和重复 finalize `EEXIST`。
- `76131eb` 新增逐要求完成度审计并修复旧文档漂移。随后在同一提交完成已批准的三市场
  公开 paper：`kj-paper-20260716225739-48ff7c99` 的 `RUN_PLAN` 在 context 前 hash-bind，
  3/3 目标均官方结算，`accepted=true`，479 条 journal 重放及报告 11 项核验通过；报告为
  `DESCRIPTIVE_PAPER_ONLY`、`profitabilityClaimEligible=false`、artifact hash
  `6fb04978225a1680c5e747d8b8b2544111e650fafc197e4b163525608d38d775`。策略稳定正 edge、
  真实 fill 等价、exchange reconciliation、shadow/live 仍未完成或未授权。纯
  `ExecutionEngine` 接口不是可下单实现。
- `e6b2780` 增加离线 `paper:cohort-report`：只接受 hash-chained、replay-verified 的描述性
  单次报告，重算 artifact hash，并拒绝 legacy、重复 run ID、重叠目标窗口或篡改输入；输出
  no-overwrite cohort hash 和逐策略累计/每运行正负分布，但恒为
  `profitabilityClaimEligible=false`。首个一运行 cohort 位于
  `/root/polymarket-money-data/kj-paper-cohort-20260716225739-48ff7c99`，hash 为
  `2509e8cf5948ce355c852c70fff7208e2232aafb42c0ffeb20fb4fdd8305d865`。
- 第二个 plan-bound 三市场运行
  `/root/polymarket-money-data/paper-mvp/kj-paper-20260717011239-edcb5933` 在 `e6b2780`
  收集，3/3 官方结算，`INITIAL accepted=true`、505 条 journal、九项 acceptance check 均
  true；其 replay report hash 为
  `15f776e2e972401cff33a3030889b728738018ac08232f0b3e260d307c061c30`。两运行、六市场
  cohort 位于 `/root/polymarket-money-data/kj-paper-cohort-two-runs-20260717`，hash 为
  `cba4f224237d0cd6a1c3984c1114920b101bc66a0e6cdd35e262c42417bc0410`，仍只是描述性
  paper evidence。
- `5fa8d66` 新增离线 `paper-l-adaptive` 与 `L_ADAPTIVE_EXECUTION`：只有 TRAIN/VALIDATION
  被 CLI/API/通用 runner 接受，L 不可与 J/K 混跑且 Final Test 被硬拒绝。V1 按冻结配置
  运行的 TRAIN（2,880 市场、807 fills）净 PnL -20.6611192571958996264383882；独立
  VALIDATION（1,440 市场、338 fills）为 -1287.046169895371064543169651，故明确 rejected。
  运行产物为 `.../l-adaptive-execution-v1-{train,validation}-20260717-r3`，hash 分别
  `7dde1a4f...d05931`、`9c5caea5...674d5`。历史 receipt 缺连续 CLOB quote sequence 与
  point-in-time Chainlink boundary，速度仅标 current spread proxy、basis 不假装存在。
- 同一提交补充 wrapper 恢复 hardening 和 Chainlink provisional 设计合同：没有 canonical
  boundary 证明的 RTDS relay 只能叫 `PRELIMINARY_RELAY_OBSERVED`；它绝不释放仓位、改变
  wallet/PnL 或调用 settle，Gamma/UMA final 仍是唯一正式结算路径。Windows D 盘只交付零依赖
  静态看板，不承载 journal。
- 新离线 `paper:cohort-observability-report` 在两份已验收报告上重新核验 runtime summary
  SHA-256、journal record/tail/event count、runtime safety/identity，再输出六个公共流的
  events/reconnects/quarantines、六个目标市场的 Gamma official settlement delay，以及目标市场
  J/K intent/fill/partial/no-fill distribution。artifact 位于
  `/root/polymarket-money-data/kj-paper-cohort-observability-two-runs-20260717`，report hash 为
  `e4cd5370760da77e75caccbf0e4ed308dbd619aa3f83deee41dbc1d391f46a4d`：settlement delay
  P50 378,462 ms，J 20/22、K 18/20 paper fill，双方各有两次 `SLIPPAGE_LIMIT` no-fill。
  新的零依赖质量看板位于
  `D:\polypolycache\polymarket-kj-paper-observability-dashboard.html`；它结构验证通过，当前
  环境无 Chromium，浏览器级验收为 `structural_only`。所有结果仍为 `DESCRIPTIVE_PAPER_ONLY`。

权威结果：

- 研究：`/root/projects/polymarket-money/reports/batches/batch-03b/BATCH-3B-RESULT.md`；
- 整改：`/root/projects/polymarket-money/reports/batches/batch-04b-r1/BATCH-4B-R1-RESULT.md`。
- R2 观测：`/root/projects/polymarket-money/reports/batches/batch-04b-r2/BATCH-4B-R2-RESULT.md`。

## 当前未完成

- 公共源没有可靠 sequence/cursor，continuity 只能是 `UNVERIFIED`。
- Binance 精确单符号 filter 的有限 probe 未观察到目标 update；全符号后备必须显式开启并
  写入 manifest，非 BTC 只能 quarantine。
- 没有长期 reconnect supervisor；该项暂放 Batch 2B。
- Normalized 存储当前只支持 Linux-native filesystem 与 single writer；没有分布式锁、
  crash lease、NFS/多容器验收或 content signature。
- 跨 manifest exact-millisecond 冲突没有已证明全序，当前选择 `RESET_REQUIRED`。
- 没有逐时点 token fee-rate 或 Chainlink 开收盘价证据；只有官方静态 feeSchedule 与官方最终
  resolution。没有队列/隐藏流动性模型、durable order ledger、unknown-outcome reconciliation、
  GARCH/VaR/CVaR 独立实验、shadow 或 live。
- 第三方 1 Hz top-of-book 的 Final Test 只有五天；不能模拟 250ms，B3/30 的弱正值集中在
  UTC 06-11 和低波动组，对压力不稳。
- fee 精确半 quantum 的官方 tie-breaking 仍未验证，R1 以
  `ROUNDING_TIE_UNVERIFIED` 拒绝 verified edge。
- 公共 CLOB 仍无可证明 gap-free cursor，continuity 保持 `UNVERIFIED`；R1 route 结论保持
  `DATA_INSUFFICIENT`。
- R2 暴露网络重连、长期 working-history/metrics 开销与市场轮换退化；代码已整改但未经新
  长期观测验证。Polymarket Binance relay 本次没有有效 trigger。
- R2 maker 缺少固定 horizon markout、quote lifetime、可靠 churn/trade-arrival 与私有
  fill/queue 证据；不得把 spread envelope 当收益。
- 规范化 point-in-time 单速/fast/slow EWMA 已完成；Strict legacy equivalence 仍缺旧逐笔
  trade stream、K 的 BTCUSDT/USDCUSDT 换算和历史 `vol_epoch`。规范化相位不能冒充旧进程。
- Batch 06 历史路径每市场只做一个决策，历史 row 不暴露已验证 Up/Down token ID；重叠
  市场现金预留、多批建仓和 historical outcome-token position 仍未完成。
- Public runtime 到统一 StrategyContext、实时 K/J paper engine、durable replay 与官方
  Gamma resolution 已接通；共享 probability golden 已把 TypeScript 近似对
  Python `erf` 的代表点误差限制到 `0.0000002`。第二份共享 golden 已对拍 J fee-threshold
  拒单与 K 从 EWMA/intent/fill 到官方结算/PnL 的代表路径；所有分支穷举等价仍未声称。
- L V1 的 historical gate 已失败；当前历史样本无法验证真正 quote velocity 或
  Binance--Chainlink basis，故不可用更激进调参掩盖输入缺口。未来 L V2 需要先补齐这些连续、
  point-in-time 输入，再预注册固定候选网格，只在 TRAIN 选一次并执行一次 Validation；Final
  Test 继续保持关闭。
- 独立 warmup journal 的正式 v3 三市场 paired 样本已通过公开 paper/replay；但仅有一轮、三
  个市场，必须保持与无预热诊断样本分开解释，且不足以推断稳定性、收益或信号源优劣。

## 当前停点

后续只在 `polymarket-money` 收敛研究和产品主线；后续策略也在主仓统一研究，不再建立独立研究工作副本；旧 `polymarket-paper-workbench`、
`hello-world` 与开源引擎只作只读参考，不再扩展为并行主产品。当前不进入 shadow/live，
不重跑 R2。MVP 工程闭环、两次计划绑定三市场 gate、PnL cohort 和独立运行质量 cohort 汇总能力已完成。J/K
下一停点是在当前持续联网批准范围内，用同一冻结配置继续积累独立的多市场 paper 证据，并由
两个 cohort 分别汇总稳定性、网络延迟、成交/未成交/部分成交、官方结算延迟和逐策略 PnL 分布；后续正式证据 campaign 必须先离线 hash 预注册全部窗口，并由 campaign cohort 拒绝任意事后子集；不得用单场正收益反向调参或
进入 shadow/live。L V1 保留为独立候选：先完成亏损分层归因与新输入准备，再决定并预注册下一版
研究/实时 paper 契约；不删除策略，也不以 Final Test 反向调参。

## 下次开始时

1. 读取 `docs/INDEX.md` 的标准必读包。
2. 读取代码仓 `docs/batches/batch-06-kj-paper/{design,result}.md`，从现有 CLI、测试和
   artifacts 继续，不再回到 workbench 扩产品。
3. 从已验证 EWMA artifact 和 v4 results 继续，不使用被修复执行时序取代的旧中间产物；
   禁止用 Final Test 反向选参。
4. 保留 J/K 当前冻结配置；如获新的明确联网批准，从已提交的独立、可 replay 的 K warmup 输入流和现有 `paper:mvp`、`paper:settle`、
   `paper:finalize`、`paper:report`、journal/replay 与跨语言代表 golden 继续积累独立预绑定
   多市场 paper 验证。正式样本先执行 `paper:campaign-plan`，每轮用 `paper:mvp -- --campaign-plan ... --campaign-run N`，完整计划只能由 `paper:campaign-cohort-report` 与 `paper:campaign-cohort-observability-report` 对同一全部轮次汇总；仍可用一般 cohort 作描述性诊断，不重跑 R2，不把单次或 Legacy PnL 当收益证据。
5. 保留 L V1 并完成亏损分层归因；后继 L 研究先取得连续 CLOB quote 与可验证 Chainlink boundary
   evidence，再单独预注册并建立独立 runtime/journal/report 契约。
6. 保持无凭据、不可下单；不进入 shadow/live trading。
