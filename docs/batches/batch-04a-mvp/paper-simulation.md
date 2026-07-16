# Batch 4A-MVP Paper Simulation

## 定位

Paper 模式是公开行情上的研究观察器，不是交易客户端，也不宣称真实利润。它不连接 User
Channel，不读取凭据，不签名，不发订单，不维护另一套真实/模拟账户。

支持的统一观察器：

- `NO_TRADE`
- `COMPLETE_SET_ARBITRAGE_OBSERVER`
- `LEAD_LAG_OBSERVER`
- `MAKER_ENVELOPE_OBSERVER`

## 规则

- taker 先记录候选机会；配置延迟未满足时 theoretical fill 固定为空。延迟到期后才使用
  当时新观察到的 ask/bid 和可见数量，不回用候选时刻的旧盘口。
- 任何触达结果只标为 `THEORETICAL_FILL`，`orderSubmitted=false`。
- 双腿完整组合只报告可执行数量、费用后 edge 和非原子 legging risk。
- 费用率只取当前 Gamma 公开 `feeSchedule.rate`；未知时 edge 为 null、可执行量为 0。
- maker 不生成 fill，不假设 queue position，只报告 spread、markout、adverse selection
  与成交上下界。
- 空盘口、stale、等待 snapshot 或隔离状态不产生机会或理论成交。
- `COMPLETE_SET_ARBITRAGE_OBSERVER` 的 edge 是机会诊断，不进入 PnL 账本。

实际成交、费用、部分成交、settlement 和 PnL 仍只有 Batch 3A 的 `ExecutionModel`、
`FeeModel`、`FillLedger` 路径。实时 observer 不复制这套逻辑。

## 审计字段

每条 audit 至少含 observer、observedAt、marketId、可执行数量、费用后 edge、legging risk、
理论 fill 分类、queuePosition、上下界、`orderSubmitted=false` 与
`claimsRealProfit=false`。summary 另记录 theoretical fill 数和 real order 数，后者必须为 0。
