# Batch 02.5 verdict

## Verdict

**PASS WITH DOCUMENTED LIMITATIONS**

Batch 2.5 可以验收为 point-in-time normalized dataset gate。它满足：

- manifest-verified raw 是唯一输入，verify 后磁盘篡改也拒绝；
- `visible_at <= decision_time` 是唯一历史可见性边界；
- late event、duplicate lineage、conflict quarantine 和 metadata revision 不泄漏未来；
- 相邻 BTC 五分钟 market/token partition 不混合；
- 任一 sibling token empty/crossed/stale/ambiguous/quarantined，或 market disconnected/
  reconnected-without-snapshot 时，整个 market 不可执行；
- continuity 无法被升级出 `UNVERIFIED`；
- immutable dataset 可确定性构建、原子发布、禁止覆盖并离线重建；
- Python 119/119（Batch 2.5 专项 56/56）、Node 40/40、TypeScript、Ruff 与干净安装验证通过。

## 本结论不证明

- public feed gap-free；
- 长期 reconnect supervisor 可用；
- BTC-only feed 在当前网络能稳定产生更新；
- JSONL 已满足长期容量/性能；
- dataset hash 是第三方签名；
- 数据可直接用于回测；
- 策略、收益或实盘安全。

## Gate to next work

本批完成后停止。下一项建议不是 Batch 3 回测，而是先由用户选择：

1. Batch 2B：长期 reconnect/数据质量监督与失败恢复；或
2. 对 normalized dataset 做独立审阅并定义“哪些 UNVERIFIED/STALE 区间可进入研究样本”的
   dataset acceptance policy。

在新批次明确授权前，不开始回测、特征、GARCH/其他模型或实盘开发。
