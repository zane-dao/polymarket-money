# Point-in-Time Fee Model

费率由版本化、半开区间 `[effective_from, effective_to)` 的 `FeeSchedule` 提供，并按 market、
实际可执行时点和显式 `MAKER` / `TAKER` / `NO_FEE` 角色选择。重叠区间失败关闭；每个 Fill
独立计算并按声明的 quantum/rounding 舍入，不能先聚合再舍入。

缺少匹配费率时费用数值暂记零，但 `fee_verified=false`、原因是 `UNKNOWN_FEE`；费率表只有
在具备可审计历史证据时才能把 `historical_verified` 设为 true。Batch 3A 的人工费率只用于
验证算术，全部标为非历史已验证，因此即使毛收益、手续费和数值净收益都能精确复算，
`net_pnl_verified` 仍为 false，状态为 `COMPLETE_FEE_UNVERIFIED`。

本批没有接入或声称掌握真实历史 Polymarket 费率、maker rebate 或费率来源证据。进入真实
历史回测前必须建立带来源 hash 的费率证据合同。

