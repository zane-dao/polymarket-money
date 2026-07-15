# Dataset Acceptance Policy

Batch 3A 只接受经 Batch 2.5 发布器落盘、由验证加载器重新校验且显式绑定
`dataset_hash` 的 normalized dataset。`ReplayEngine` 只能通过 `open()` 创建；手工拼装
receipt、直接传入内存 dataset 或 hash 不匹配都会失败关闭。

## 三种准入状态

- `EXECUTION_ELIGIBLE`：市场身份及 Up/Down 映射有效，两侧盘口可交易，连接、快照、
  新鲜度及隔离状态全部通过。只有该状态可调用策略并模拟成交。
- `FEATURE_ONLY`：身份结构可用，但盘口断线、陈旧、空侧、等待快照、市场关闭或不接单。
  可用于明确允许的非成交研究，不得产生模拟 Fill。
- `EXCLUDED`：身份/映射无效、active quarantine、跨 manifest 歧义导致 reset、交叉盘口，
  或 continuity 被错误升级。不得用于特征或成交。

连续性固定保留为 `UNVERIFIED`，任何组件不得把它升级为 VERIFIED。隔离记录按决策时点
求 active 状态；新连接且新快照只能解除可恢复的传输隔离，永久业务键冲突不会被解除。

## 汇总口径

覆盖率按可识别市场窗口的持续时间计算，不按事件数计算。`exclusion_reasons` 表示“命中该
原因的市场数”，同一市场同一原因只计一次；`reason_duration_coverage` 单独记录原因持续
时间占可度量窗口的比例。身份缺失的市场没有可信窗口，因此只计 excluded 市场与原因，
不进入时间覆盖率分母；这是明确限制，不得解读为零时长缺陷。

