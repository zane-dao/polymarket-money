# Batch 4B-R2 route evaluation rules

状态：**PRE-REGISTERED / NO RESULT YET**

允许的分类只有 `NOT_OBSERVED`、`OBSERVED_NOT_EXECUTABLE`、`RESEARCH_CANDIDATE`、
`DATA_INSUFFICIENT` 和 `REQUIRES_PRIVATE_FILL_EVIDENCE`。本批不能宣称盈利。

- Complete-set 至少跨两个市场出现费用后正 edge、存在共同可见数量、通过质量门且披露
  非原子双腿 legging risk，才可分类为 `RESEARCH_CANDIDATE`。
- Lead-lag 至少 200 个有效 trigger、20 个完整市场、来源方向一致、相邻 horizon 不立即
  反转、结果不依赖少量极值，且持续时间超过本地观测延迟与合理执行缓冲，才可分类为
  `RESEARCH_CANDIDATE`。统计必须按 market/time block，不把同 episode trigger 当独立样本。
- Maker 只输出 envelope，不生成 fill、不假设 queue position；最高分类固定为
  `REQUIRES_PRIVATE_FILL_EVIDENCE`。
- Fair-value 明确关闭，固定为 `NOT_OBSERVED`。
