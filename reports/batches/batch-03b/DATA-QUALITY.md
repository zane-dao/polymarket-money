# Batch 3B Data Quality

结论：PASS。

| 门槛 | 要求 | 实际 |
|---|---:|---:|
| PRIMARY_V2 有效市场 | >= 2,000 | 5,599 |
| 官方标签覆盖 | >= 95% | 100% |
| 市场身份 | 唯一 | 5,599/5,599 唯一，冲突 0 |
| Train/Test 重叠 | 0 | 0 |
| Binance 覆盖 | >= 99% | 100%（16,797/16,797） |
| 未来数据 | 0 | 0 |
| 可审计排除 | 必须 | 通过；PRIMARY 排除 0 |
| 决策点 | 60/30/15 秒 | 三者各 5,599 |

切分市场数：Train 2,880、Validation 1,440、Final Test 1,279。第三方 outcome 有 596 个
null、13 个与官方标签不一致，均未用作标签。

质量限制不会因门禁通过而消失：Polymarket 行情是第三方 1 Hz top-of-book 缓存采样，
`continuity=UNVERIFIED`、`receive_time=UNOBSERVED`、无完整 L2。Binance 官方日档虽逐日完整并
通过 CHECKSUM，但它只能作为特征，不能升级 Polymarket 行情或结算证据。

第一次构建因 Binance 覆盖被错误地与盘口 size 的提前退出耦合而失败关闭，没有训练模型；
该不可变失败结果保留。修复后证明 21 个 Binance 日档各 86,400 行且无秒级缺口，并把空 size
改为“保留概率样本、执行时不成交”，随后数据门通过。

