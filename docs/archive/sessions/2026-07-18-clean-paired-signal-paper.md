# 2026-07-18 干净三市场双信号配对 Paper

## 目标

在用户明确联网授权下，以修复后的首市场边界，对 Binance Spot 与公开 RTDS Chainlink relay
分别运行冻结 K/J paper，并生成可复放的同窗口比较。

## 事实与证据

- compare run 为 `kj-compare-20260718-0530-clean`，计划固定 05:30--05:45 UTC、三个目标市场、
  600 秒结算宽限，collector commit `09ba7199182d04e075e71385b65dc2f4b46ed022`，plan hash 为
  `a081f03f21af323c334e170defc141cf0ba68b7b69a08cb2e9e5833fa9471a9e`。
- Binance 与 Chainlink child 均 exit 0、`accepted=true`、3 target/3 engine market、全部完成
  Gamma 官方结算、无 pending、无 private channel、凭据或真实订单。
- Binance replay report hash 为
  `2a4ef4db1aeaa2566151ec83b95a7e92c698a7ff5a8717ea8b0fafe1a4379dfb`；既有 Chainlink report
  hash 为 `7a97f4019f8bcac0c6b8226bb15ca518c4b3991526a45f72fc872ecd3342649a`；配对报告 hash 为
  `d3b68c5b27d872b3b355d5fb87a963e1b63a82ddef143eab11827acae465779d`。
- 配对输出：J Binance net PnL `505.6578659525010368`、Chainlink `0`；K Binance
  `443.20588627137571787009131215169552720247718341239780457777615391397498229624127`、Chainlink
  `-170.00699056`。这些只是三市场 paper 输出，始终为 `DESCRIPTIVE_PAPER_ONLY` 且
  `profitabilityClaimEligible=false`，不能外推为策略盈利或来源优劣。
- K Binance 的市场汇总与最终钱包出现 `-2.7e-77` 的有限 decimal 运算尾差；报告已原样导出
  `pnlReconciliationResidual`，在 `1e-60` 严格上限内。

## 修改

- 代码层：报告新增尾差字段与严格阈值校验；accepted result 与最终钱包仍须一致。随后
  `c6c86ac` 实现独立的 `WARMUP_SIGNAL`：预热只进入 EWMA，不产生市场/结算/钱包语义。
- 项目层：追加 D-029，并登记本次干净运行；诊断运行继续只作诊断。
- 外部状态：所有运行、journal 与 no-overwrite report 位于
  `/root/polymarket-money-data/signal-compare/kj-compare-20260718-0530-clean/`。

## 验证

- `npm run typecheck`：通过。
- `npm test`：Node 139/139 通过（包含 warmup replay/隔离与 v3 RUN_PLAN 绑定测试）。
- Binance `paper:report`：accepted，并导出 residual。
- `paper:signal-compare-report`：accepted，配对 hash 已写入本摘要。

## 决定

- D-029：尾差只能在极低阈值内显式披露，不得静默忽略或用它弱化会计校验。
- D-030：K 预热只能通过独立、可重放的 journal 信号输入，不得借用计划前市场 session。

## 未决问题

- 新 warmup 合同尚未在公开 paper 中运行；下次运行需单独核验其 journal record 数与 source
  family，并将结果与本次无预热干净样本区分。
- 两路 public stream 的 receive clock 独立；本次不能证实同一时点的事件可见性，更不能证明
  Chainlink relay 是结算边界的 canonical 值。

## 下一步

在不改变冻结 J/K 参数和不进入 shadow/live 的前提下，取得新的联网批准后，以完整预注册
campaign 积累采用独立 warmup 的 paired descriptive paper 样本。

## 后续更新

- `c6c86ac` 后的 `kj-compare-20260718-0610-warmup` 已于 06:10 UTC 启动。两腿在目标边界前
  的 journal 均为 `WARMUP_SIGNAL`，第一条 `CONTEXT` 同为 `2956973`/06:10 UTC；官方结算与
  replay report 仍待完成，不能预判。
- 当前树重算 frozen FINAL_TEST BASE_1S 的 J/K 数值与既有 artifact 完全一致；这只复核可重复性，
  不改变 J/K 均未达到策略盈利准入的结论。
- `kj-compare-20260718-0610-warmup` 已在 Gamma 结算后完成：两腿均通过运行验收、3/3 目标市场
  完成、无真实订单/待结算市场。Binance 的独立 warmup 为 284 条、290.272 秒，Chainlink 为 251
  条、288.668 秒；均在 06:10 UTC 前结束。但启动时 v2 RUN_PLAN 未 hash-bind `warmupSeconds`，
  所以 HEAD 的 v3 replay report 按预期拒绝它（`hash-chained run plan conflicts with run-plan.json`）；
  本样本永久仅为诊断。描述性净 PnL 为 Binance J `-365.5837662522724212482694532420489673614140226440857971894024161277475393047469`、
  K `-225.704491905`，Chainlink J `+258.95099574`、K `+221.217665115`，不得解读为优势或盈利。
- `kj-compare-20260718-v3-warmup-formal` 已排队并在 06:35--06:50 UTC 窗口开始；使用 commit
  `84c8d4a`，将在第一条 warmup 输入前以 v3 RUN_PLAN 绑定 warmupSeconds。
- v3 正式运行已完成 Gamma 结算、两条腿 replay 与 paired report：均 `accepted=true`，但永久
  `DESCRIPTIVE_PAPER_ONLY`。预热核验为 Binance 195 条/198.011 秒、Chainlink 163 条/194.424 秒；
  目标市场准确为 `2957057/2957069/2957089`，没有额外 session。paired report hash 为
  `f1782e47a6dcbce746084359b4f9b63a73eef1fee5a9b4c552874407beb0f071`。J 的两源净 PnL 分别为
  `-119.7409353918464`、`-142.931408445`，K 为
  `+79.142582164967037284978315918153505835783100969234799313094856943272113397560909`、
  `+78.026065729393277098573507582152108740576883895567133335273743341968157871758`。三市场既不能
  证明盈利，也不能支持选择 Binance 或 Chainlink，K/J 继续冻结且不得 shadow/live。
- `8dd0832`/`55cb52c` 新增不可变的 paired campaign artifact 与固定时点 launcher。它将两份
  source campaign、每轮 compare plan 与 source run mapping 一起 hash-bind；launcher 在目标边界前
  210 秒启动，错过则 fail closed。首个 `paired-v3-20260718-0720` 四轮 × 三市场计划 hash 为
  `d3daa4ee40021cf597f8d7ba59c045f0516206d07290260be136728c34d30035`，计划从 07:20 UTC 开始；
  当前只完成预注册并已启动 launcher，尚无该 campaign 的运行或 PnL 结论。
- 用户随后校正优先级：测试应在 MVP 完成后进行，而不是不断实时运行。故已停止第二个尚未开始的
  09:00 接续 campaign、L 原始长采集和首 campaign 后续轮次；任何中断输出均不得验收或聚合。
  主仓 `0965be5` 新增 `npm run mvp:console -- --data-root /root/polymarket-money-data`，仅在
  `127.0.0.1` 提供回测/paper 命令与安全状态，不自动启动网络或 paper。
- `08b80e5` 进一步增加 `<data-root>/mvp-runs/*/summary.json` 的小型只读列表；已用 L V2
  Validation BASE 完成“策略候选--离线回放--结果 API”端到端验证。此运行的 net 为
  `+132.2576903286908614378503338`、46 fills，但不改变其集中度/数据连续性限制或实时准入状态。
- `141ac70` 增加显式 `--enable-local-history-runs` 门：只有启用后 console 才能启动固定的 K/J、
  L V1、L V2 离线回测，拒绝任意参数/路径/网络模式并且只允许一个本地进程。实际 API 启动 L V2
  得到 exit 0，运行产物随后被 `/api/results` 读取；realtime paper 仍没有网页启动入口。
- `4953375` 将现有 `paper-mvp` 的 compact acceptance result 读入 console，不读取 journal/metrics
  或启动网络。`/api/paper-runs` 已重现一个 hash-chained 三市场运行的 accepted 及 J/K paper PnL；
  它仅使既有证据可见，不改变描述性 paper 或策略准入结论。
- 通过 console 的离线 K/J 入口重跑了冻结 FINAL_TEST BASE_1S：J `+4.8956698638498977551796894`
  （135 fills），K `-298.4573587392367656725813702`（137 fills），并由 `/api/results` 读回。
  这确认 K/J 的产品入口可复现已知结果；不作为重新调参、盈利或启动实时测试的依据。
- `9be8541` 统一 console 显示与实际运行的固定研究定义，避免双处参数漂移；新增测试绑定
  L V2 candidate、Validation split 与输出路径至同一参数生成器。
- `ca3fa67` 将 console 的两种结果从开发者 JSON 改为可读表格（历史 split/scenario/PnL/fills 与
  paper accepted/plan binding/目标/J-K PnL），数据仍由只读 API 供给且用 DOM `textContent` 渲染。
- `a911351` 进一步在历史表加入最大回撤与剔除最佳三天的压力结果，L V2 的正 net 与
  `-168.2731937063091385621496662` 压力 net 同时呈现，避免 Dashboard 暗示稳定优势。
- `3de6179` 写入可审计的本地研究/paper MVP 验收：固定历史运行、账户/PnL/export、控制台权限和
  既有 paper 可见性均已走通；它明确区分产品闭环完成与策略盈利、连续性、真实成交、shadow/live
  未完成。后续 public realtime 测试需新的具体假设、有限窗口及当次联网批准。
- `8f709f5` 冻结了下一轮尚未启动的 public-paper 协议：4×3 paired K/J、Binance/Chainlink
  独立腿、180 秒预热、600 秒宽限，不调整参数/窗口、不补跑失败轮，L 不进入 realtime。实际
  artifact 和采集必须等用户当次批准后才生成；目前没有运行进程。
- `e391916` 为 campaign launcher 加入 atomic durable claim：在等待固定启动时点前使用
  `O_EXCL` 写入并 fsync campaign claim；重复启动或崩溃后的重启均 fail-closed，不能造成并发或
  未登记补跑。Node 145/145 与 typecheck 已通过；未发生联网采集。
- `1edb2ab` 收紧 localhost MVP 控制台的历史结果信任边界：只有按 Python canonical JSON 复算
  SHA-256 后仍匹配 `result_hash` 的 `summary.json` 才会被列出，并显示 `VERIFIED`；篡改或缺 hash
  的摘要 fail closed。当前三份已发布本地摘要都验证通过。此核验不替代 events/trades/raw 审计；
  Node 146/146 与 typecheck 通过，未发生联网采集。
- `3c55816` 把新的历史 paper 导出从“逐个写文件”收紧为“最后提交 publication”：三份 sidecar
  均 flush/fsync 且被记录 bytes/SHA-256 后，才 fsync 写入 `publication.json` 和自身 hash。崩溃
  残留永远缺少该 manifest；旧 artifact 不被改写或追认。Python 200/200、Ruff 通过，未发生联网采集。
- `a7f6231` 让 MVP 控制台消费完整发布合同：新目录先有 `publication-intent.json`，控制台只在
  最终 manifest hash、result hash、三份 sidecar 名称/size/SHA-256 全部匹配时显示
  `COMPLETE_PUBLICATION_VERIFIED`；意图存在而无完整 manifest 的中断目录 fail closed。旧目录保持
  `LEGACY_SUMMARY_VERIFIED`，不伪造新 evidence。Node 146/146、Python 导出单测和 Ruff 通过，未发生联网采集。
- `cfb6f64` 基于当前 HEAD 重新审计 MVP：全量 Node 146/146、Python 200/200、Ruff、typecheck 与
  diff check 通过，工作树干净；`completion-audit.md` 更新基线与本地结果发布证据。结论仍是工程 MVP
  完成，不是策略盈利、连续性、shadow 或 live 准入；未发生联网采集。
- 用户批准后生成了 `paired-20260718-0900` 四轮 Binance/Chainlink campaign artifact，hash 为
  `e50dba292eea9e9b3245ccc65b74119a2348004bb454b07e2e88ed0432b79145`，原计划 09:00 UTC 首轮。
  但用户随后在 08:53:57 UTC 明确要求停止；launcher 与本地 console 已退出，停止早于 08:56 UTC
  预热。只留下 plan/claim，没有子运行、采集、journal、市场或 PnL。此 campaign 永久中止，不得补跑
  或作为 evidence。
- `517a48a` 回应用户对“空界面”的反馈：MVP console 新增只读研究诊断看板，实际 API 已显示 L/J/K
  的 Brier、十档 calibration、有效波动率，L 还显示 volatility drag，并列出 reason counts/daily PnL
  和既有风险字段。结果按 result hash 去重，输入仍仅为已验证 summary 与有大小上限的派生 events，
  不读 raw/journal、不开网络或 paper。Node 147/147 通过；Windows 默认浏览器已打开 localhost 页面。
