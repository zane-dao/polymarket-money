# Batch 3B 实验预注册

## 研究问题

在固定 UTC 切分、官方结算标签、真实 ask、官方手续费、至少 1 秒延迟和最佳 ask 数量限制下，
四个简单 baseline 是否出现值得长期采集或 shadow 验证的正期望迹象。

## 固定范围

- 仅 PRIMARY_V2；PRE_V2 不混入，2026-04-28 cutover 完全排除。
- Train `[2026-04-29, 2026-05-09)`；Validation `[2026-05-09, 2026-05-14)`；
  Final Test `[2026-05-14, 2026-05-19)`。
- 禁止随机 shuffle；scaler 和 B3 权重只在 Train 拟合。
- 只用 Validation 在阈值 0.00/0.01/0.02 中选择一次，并在 Final Test 前冻结配置 hash。
- 决策点固定为结束前 60、30、15 秒，不搜索其他秒数。
- 每市场最多 1 share、最多一笔、taker、持有到结算、不加仓、不提前退出、不复投。

## 数据可见性与执行

决策 headline 采用 `SAMPLE_TIME_PLUS_1S`。执行情景固定为 DEBUG_0S、BASE_1S、
CONSERVATIVE_2S、STRESS_1S_PLUS_TICK；结论至少看 BASE 和 STRESS。midpoint 只能形成概率，
买入必须使用执行时可见 ask。ask size 缺失则不成交，小于 1 则部分成交；空侧、缺样本、
价格越界和市场结束后样本均不成交。

## 冻结证据

- dataset hash：`a27d9d1bf4dc5276c7ae5b11abd64250b6e6dc17f01fd432ab0dc10e4425cafc`
- frozen config hash：`5258fb5c2f71a6a9c2d9e53d1fb18c92002cba7a3adf0e7cf5ca74a0a7b1a0b2`
- primary result SHA-256：`cb350dae01d41a5d6e359f3376b6c0b7f68c35c0847199b11128fc695d2557f9`
- 固定诊断 SHA-256：`68a0aa644f311c04fa052ad5f364859a60502be04341f8dd2f9e19a041493ae9`

首次通过数据门的 Final Test 结果保持不可变。之后的诊断只用同一冻结配置补充分切分、周、
UTC 时段和 Train-only 波动率三分位汇总，不调参、不改变主结论、不覆盖 primary result。

