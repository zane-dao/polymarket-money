# 2026-07-18 双信号配对 Paper 诊断与首市场边界修复

## 目标

在用户已批准的公开三市场 Paper 范围内，让冻结的 J/K 同时以 Binance Spot 和公开
Polymarket RTDS Chainlink relay 运行，保持独立钱包、journal 与官方 Gamma 结算。

## 事实与证据

- 配对计划 `kj-compare-20260718-0505` 固定 05:05--05:20 UTC、三个目标市场、600 秒结算宽限与
  commit `85b46a0fc6b325371d1cbd691fd18113bbce340d`；plan hash 为
  `67c9ae74765f0431666e06524009725f6a81d821cb47e43968e56295451e4428`。
- 两条 public-only child 均 exit 0、`accepted=true`、三目标市场均完成官方 Gamma 结算，且无
  private channel、凭据或真实订单。
- 可复放逐腿报告 hash：Binance
  `04ba7c1829689a6355619966c9f6cde5967480fddc915d5d78a7edec068c1fcc`；Chainlink
  `e57449e2f8599d401940588eba0541622de26ebda1258e940d5ce935c2421d98`。配对报告 hash 为
  `f8066d26503ab4a5f75f39e55c4714e17078fbe3ed783df466eb2f1cc20b31ca`。
- 诊断配对差：J 的 Chainlink-Binance net PnL 为 `+103.43693357`，K 为
  `-83.453704855`；所有产物继续标 `DESCRIPTIVE_PAPER_ONLY` 和
  `profitabilityClaimEligible=false`。
- 发现预热阶段 05:00 市场被登记进 engine，造成总 engine market=4、计划目标=3；报告对
  目标窗口正确过滤为三市场，但该轮不应作为干净正式样本。

## 修改

- 代码层：新增 `--kj-market-start-at`，MVP 传入 `firstFullMarketStart`；早于该时间的市场不再
  注册策略上下文或 Gamma 结算候选。提交 `8320683`。
- 代码层：新增 `paper:signal-compare-report`，严格复核 paired plan、逐腿报告 hash、窗口、commit、
  run ID 与 runtime signal source。提交 `00682d8`；文档提交 `45b5963`。
- 外部状态：诊断运行与报告均位于
  `/root/polymarket-money-data/signal-compare/kj-compare-20260718-0505/`。

## 验证

- `npm run typecheck`：通过。
- `npm test`：Node 136/136 通过。
- 三次 `paper:report` / `paper:signal-compare-report`：均 accepted，且输出 no-overwrite artifact。

## 决定

- D-028：首市场前预热不得进入 paired evidence 的策略 session 或结算候选；本轮仅作诊断。

## 未决问题

- `--kj-market-start-at` 排除了预热市场，也意味着 K 的 180 秒 EWMA 预热需以独立、可回放的
  warmup 输入合同实现，不能再借用已结束市场的策略 session。
- 需要用户再次明确批准后才可启动修复边界后的下一轮公开三市场采集。

## 下一步

获得启动授权后，使用 `8320683` 的干净工作树运行新的同窗口三市场 Binance/Chainlink paired
paper；完成后仅以新的 pair report 判断信号差异，仍不宣称盈利。
