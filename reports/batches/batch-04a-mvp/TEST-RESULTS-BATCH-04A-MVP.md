# Batch 4A-MVP 测试与验证结果

## 自动化测试

- TypeScript build：通过（`npm run build`）。
- Node 单元测试：50/50 通过（`npm test`）。
- Python 测试：182/182 通过（`.venv/bin/python -m pytest -q`，3.59s）。
- CLI 帮助：五个命令均已注册：`replay`、`monitor`、`paper`、`inventory`、`storage-report`。

## 功能边界验证

- replay 使用既有 `ReplayEngine`、`ExecutionModel`、`FeeModel` 和账本；确定性 replay hash 测试通过。
- monitor 的 `--record none` 不写 raw；metrics/raw 记录策略和共享字节预算测试通过。
- raw 输出拒绝 `/mnt/d` 的 9p/DrvFS，并强制时长、字节数和 10 GiB 余量。
- inventory 使用只读元数据扫描、跳过敏感路径和符号链接；D 盘原文件未修改。
- paper observer 只产生 `THEORETICAL_FILL`，maker 不产生伪造成交，且不创建 live client。

## 有限运行说明

此前已完成 10 秒有界 raw 预检（见 `STORAGE-MEASUREMENT.md`）。本次恢复时没有重新执行
30 分钟 monitor 或 60 分钟 raw capture：前者会依赖持续公共网络，后者会在 D 盘物理空间
不足时造成不必要风险。报告只采用已测短样本，不把未运行项目冒充实测。

## 未完成验证

真实公共流的 30 分钟 monitor、最长 60 分钟 raw capture，以及完整机会持续时间分布仍应在
专门的受控窗口执行；它们不影响本批离线安全边界和容量结论。
