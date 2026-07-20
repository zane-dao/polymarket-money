# Batch 02 遗留问题

## High（进入长期数据或回测前阻断）

1. **连续性不可证明。** CLOB/RTDS 无官方 sequence、cursor 或 replay offset；所有数据集
   只能是 `UNVERIFIED`。后续必须用 snapshot/stale/quality gate 隔离，而不能假设 gap-free。
2. **没有长期连接监督。** 本批只有有限 capture；尚无受控 backoff、长期重连、订阅恢复、
   资源背压、进程监督和运行手册。
3. **尚无 point-in-time normalized dataset。** verified raw 不能直接冒充特征/回测输入；
   可见性、去重、修订、quarantine、市场切换和 lineage 尚未冻结。

## Medium

1. Binance 精确 `btcusdt` filter 在本 WSL/代理环境中 60 秒沉默；显式全符号后备成功，但
   增加流量。长期前应复查 provider 行为，默认仍保持 BTC-only。
2. 成功 smoke 使用 `acaf193`。最终 off-topic RTDS 分类补丁因随后公开网络错误未完成全链
   重验；对称离线测试通过，仍应在下一次允许的有限协议检查中复核。
3. CLOB 线上初始帧是数组；完整 raw 保留并标为 `batch_unverified`，但官方没有为该 outer
   batch 给出连续性语义。
4. smoke 订单簿两 token 各有一个空 side。当前 quality 能发现，后续 normalized layer 必须
   明确不可计算 mid/不可执行，而不是填补。
5. writer 只做进程内串行化；没有跨进程 lease/lock，两个 collector 指向同 segment ID 会
   no-clobber 失败，但没有协调服务。
6. hard-link/fsync 只在 WSL 原生 Linux 文件系统验证，DrvFS 语义未验收。

## Low / evidence debt

1. fail-first 工作过程没有单独 red commit/完整控制台日志；测试行为存在，时间顺序证据有限。
2. 当前 quality 的小样本 latency percentile 仅用于管线验证，不能设生产阈值。
3. 没有压缩 closed segment；这是允许的延后项，不影响 JSONL 回放。

## 明确不属于本批

手续费、成交/队列模拟、FillLedger 持久化、回测、GBM/GARCH、VaR/CVaR、策略、User Channel、
签名、订单、仓位、shadow 和 live 均未实现，也未获本批授权。
