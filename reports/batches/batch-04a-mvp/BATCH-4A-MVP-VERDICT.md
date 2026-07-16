# Batch 4A-MVP 判定

## 结论

**LOCAL_SHORT_CAPTURE_ONLY**。

WSL 的 ext4 虚拟空间充足，但实际 raw 写入会扩张位于 D 盘的 `ext4.vhdx`。D 盘剩余约
17.20 GiB，保留 10 GiB 后仅约 7.20 GiB 可安全使用；短样本压缩后约 2.46 GiB/day，
14 天约 34.48 GiB，因此本机不适合连续 14 天采集。可用于短时实验、回放和滚动采集。

## 已满足

- 统一 `poly-lab` CLI 五个入口。
- replay 复用 Batch 3A 因果回放和成交/账本内核。
- monitor/paper 无凭据、无签名、无 User Channel、无真实订单路径。
- raw 有 60 分钟/2 GiB/10 GiB 三重边界，DrvFS 被拒绝。
- D 盘盘点为只读；无原始数据复制或修改。
- Batch 1 至 3B Python 与 Node 测试全部通过。

## 遗留

30 分钟 monitor 与 60 分钟 raw 的网络长时验证尚未执行；长期重连、真实机会持续时间和
压缩率需在后续受控窗口补测。不得据此宣称真实收益或稳定实盘能力。
