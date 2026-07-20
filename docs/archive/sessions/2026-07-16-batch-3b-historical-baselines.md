# Batch 3B 真实历史数据与 baseline 研究

## 目标

用固定公开历史数据，在严格时间切分、真实 ask、手续费、至少 1 秒延迟和最佳 ask 数量限制下，
检验 B0/B1/B2/B3 是否出现值得继续验证的正期望迹象；不做复杂调参、shadow 或实盘。

## 事实与证据

- 分支 `batch/3b-historical-baselines`，HEAD `d00c12b`，tag `batch-3b-accepted`，未 push。
- Hugging Face revision `42d917dc8e3205dde8ac909792af0cce2d715c9f`；只下载 BTC markets/ticks。
- 5,599 个 PRIMARY_V2 市场全部有官方 resolution；第三方 outcome 596 null、13 冲突，均未作标签。
- Binance 21 个 BTCUSDT 1s 日档逐个通过官方 CHECKSUM；16,797 个决策点覆盖 100%。
- dataset hash `a27d9d1bf4dc5276c7ae5b11abd64250b6e6dc17f01fd432ab0dc10e4425cafc`；
  frozen config hash `5258fb5c2f71a6a9c2d9e53d1fb18c92002cba7a3adf0e7cf5ca74a0a7b1a0b2`。
- 首次数据门失败暴露覆盖统计与空 size 提前退出耦合；失败关闭且未训练。修复后数据门通过。
- Final B3/30 BASE +1.21615681，但 STRESS -0.07989914，CI 跨 0，删除最好三天后为负。
- clean venv Ruff passed、pytest 172 passed；WSL Node typecheck passed、40 tests passed。

## 决定

结论固定为 `WEAK_RESEARCH_SIGNAL`。不进入 shadow，不连接实盘。第三方行情 continuity 继续
保持 `UNVERIFIED`。后续复杂模型必须另行预注册，不得覆盖本次 Final Test。

## 未决问题

- 缺少可证明连续性、receive time、完整 ask-side 深度和 250ms 执行证据。
- 只有官方最终 resolution 和市场静态 feeSchedule，没有 Chainlink 开收盘点或逐时点 token fee。
- Final Test 只有五天，弱正值集中在单一 UTC 时段和低波动组。

## 下一步

等待用户决定是否先做 Batch 2B 长期只读采集，或另开严格预注册的 GARCH/漂移研究批次。
任何方向都不得自动进入 shadow/live。
