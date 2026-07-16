# Batch 3B 手续费证据

## 分级与 headline

5,599 个 PRIMARY_V2 官方市场响应均包含 `feesEnabled=true` 和 `feeSchedule.rate=0.07`，并绑定
官方响应 hash 与 fetch time。本批将其定级为 `MARKET_STATIC_OFFICIAL`，允许
`net_pnl_verified=true`，作为 headline 手续费情景。

逐 share taker fee 使用：

`fee = quantity * feeRate * price * (1 - price)`

手续费按每个 fill 的真实 ask 与实际成交数量计算；未成交不收费，部分成交只对成交量收费。

## 情景

| 情景 | feeRate | 证据等级 | net_pnl_verified | 用途 |
|---|---:|---|---|---|
| OFFICIAL_MARKET_STATIC | 每市场 0.07 | MARKET_STATIC_OFFICIAL | true | headline |
| CONSERVATIVE_0_0625 | 0.0625 | 情景 | false | 敏感性 |
| CONSERVATIVE_0_07 | 0.07 | 情景 | false | 敏感性/公式复核 |

没有把当前 token fee-rate API 的返回值事后回填成 point-in-time 证据，也没有声称达到
`POINT_IN_TIME_OFFICIAL`。官方文档缓存 hash：fees
`c7a67cedf97d13534af08fba586b6f50f114b201daf8ec9c919c3288e1b696a4`，fee-rate
`b84cebb21192fe763d9e31b0935ba10c0ac52aea6d52bf5ffc98f375db9b4cb3`，changelog
`70afc3c57ee4d8452c042dadeb5291f2cdc1342d3731e43af12c2d04643edccc`。

## 限制

`MARKET_STATIC_OFFICIAL` 低于逐时点 token 响应。若未来发现 feeSchedule 字段可被事后改变，
需将 headline 净值降级为未验证，并以保存于交易时点的官方 fee-rate 证据重算。

