# Batch 4B-R1 fee and edge contract

状态：**IMPLEMENTED / TIE EVIDENCE DEBT EXPLICIT**

## Decimal Reuse Gate

选择锁定的 `decimal.js@10.6.0`，没有实现自定义 BigInt 通用数学库。唯一 TS wrapper
`money-decimal-v1` 通过 `Decimal.clone` 隔离全局配置：precision 80、ROUND_HALF_EVEN、
toExpNeg -100、toExpPos 100。业务入口拒绝 JavaScript number、指数、NaN/Infinity、负零和
非 canonical decimal string；记录只保存普通非指数十进制字符串。

## 唯一公式

TS 的 `FeeEdgeCalculator` 与 Python `FeeModel` 使用同一合同和 fixture：

```text
fee = quantity * fee_rate * price * (1 - price)
```

每条腿独立舍入至五位小数；maker fee 为 0，rebate 只可作为 scenario。费用证据绑定
market、condition、liquidity role、effective interval、rate、reference 和 status。缺证据或
未验证证据不得产生 verified net edge。Python 与 TS 对缺证据统一返回 amount=null /
`MISSING_FEE_EVIDENCE`，并共同拒绝 price > 1。

官方材料没有证明精确半 quantum 的 tie-breaking。实现先用精确值识别 tie，再返回
`ROUNDING_TIE_UNVERIFIED`、amount=null，并拒绝该笔 verified edge；不靠猜测选择 rounding。

`paper.ts` 与 `opportunities.ts` 已删除各自的活跃公式并委托同一 calculator；Python 回放继续
复用 Batch 3A 的唯一 `FeeModel`，没有第二本账或第二条 PnL 路径。

## 证据

跨语言 `fee-edge-v1.json` 覆盖 0.01/0.50/0.99、分数数量、小额归零、五位小数、精确 tie、
缺证据、price 上界和 complete-set 双腿。测试还会修改全局 Decimal 配置，结果必须保持不变。
Gamma fee rate 入口只接受 canonical decimal string，并经同一 Money wrapper 验证；number 或
指数形式失败关闭。Paper audit 显式保存 gross edge，runtime 不再硬编码为 null。

> Batch 4B-R2 compatibility note (2026-07-16): the current public Gamma response was verified to
> emit `feeSchedule.rate` as the JSON numeric token `0.07`. R2 therefore preserves the exact raw
> JSON number lexeme before `JSON.parse` binary-float conversion and passes that string through the
> same Money/FeeEdgeCalculator contract. Programmatic JavaScript numbers, exponent tokens and
> non-canonical numeric lexemes remain rejected. This supersedes only the Gamma boundary statement
> above; it does not add a second fee calculation path.
