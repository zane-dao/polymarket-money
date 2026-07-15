# Backtest Report Contract

报告包含 dataset/replay/config hash、准入汇总、执行模型、latency、费率表版本、决策/意图/
全成/部分成/未成/Fill 数量、排除时点及原因、毛收益、手续费、数值净收益、PnL 状态和逐市场
审计链。逐市场记录保留 Decision、OrderIntent、每个 Fill、结算开收价、winner、winning token、
settlement time、payout 和 PnL，可从 Fill 追溯到 Intent 与 Decision。

计数恒等式为 `intent = fully_filled + partially_filled + unfilled`。有成交但未结算时状态为
`UNSETTLED`，没有成交为 `NOT_APPLICABLE_NO_FILLS`；二者都不能声称净收益已验证。只有所有
有成交市场均已结算且每笔费率有历史验证时，状态才是 `COMPLETE_VERIFIED`。

所有结果必须携带固定声明：

> Results are conditional on captured, continuity-unverified public data.

本批报告是回放内核和会计计算验证，不是策略盈利报告，也不是实盘适用性证明。

