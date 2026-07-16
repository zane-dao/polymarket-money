# Batch 3B Baseline Results

主实验：dataset
`a27d9d1bf4dc5276c7ae5b11abd64250b6e6dc17f01fd432ab0dc10e4425cafc`，frozen config
`5258fb5c2f71a6a9c2d9e53d1fb18c92002cba7a3adf0e7cf5ca74a0a7b1a0b2`，primary result
`cb350dae01d41a5d6e359f3376b6c0b7f68c35c0847199b11128fc695d2557f9`。

结论：`WEAK_RESEARCH_SIGNAL`。

- B0：不交易，净值 0，概率指标不适用。
- B1：概率基准本身校准良好，但手续费后的预期净值没有超过所选阈值，全部 horizon 交易数 0。
- B2：所有 horizon 的概率指标显著差于市场，BASE 与 STRESS 全部亏损。
- B3：概率指标基本没有超越市场。30 秒 BASE 净值 +1.21615681，但 STRESS -0.07989914，
  BASE 95% CI `[-6.68994914, 9.06969576]`，删除最好三天后 -3.58785695。

执行使用后续可见 ask 和真实最佳 ask size；midpoint 从未作为成交价。Final B3/30 BASE 有
135 次交易决定，133 次完整成交、2 次部分成交、0 次未成交；手续费 1.41054319，gross
2.6267，net 1.21615681。STRESS 的置信区间为 `[-8.00205503, 7.84225675]`。

固定诊断显示 B3/30 BASE 的正值集中在 UTC 06-11 和低波动组，其他三个 UTC 六小时组中
三个为负；两个 ISO 周一负一正。这不满足“盈利不依赖少数时期”或稳定性条件。

详细概率表、执行表和模型定义见：
`docs/batches/batch-03b-historical-baselines/batch-3b-result.md`。
