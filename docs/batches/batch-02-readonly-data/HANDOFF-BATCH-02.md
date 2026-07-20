# HANDOFF-BATCH-02

## 1. 本批目标

建立无凭据公共数据入口：版本化 raw contract、BTC 五分钟市场身份、CLOB/Chainlink/
Binance 只读采集、不可变 JSONL/manifest、数据质量和 manifest-gated Python replay。

## 2. 最终结论

第二批通过并停止。63 项 Python、40 项 Node、TypeScript 类型检查、干净安装和一次完整有限
smoke 均有证据。没有私有频道、签名、订单、策略或回测；live 仍绝对关闭。

## 3. commit、tag、branch

- Batch 1：`7f3c1c4429217c36edf0f018a5f3efb065cea312`，tag `batch-1-accepted`
- 成功 smoke collector：`acaf1934a6a84f3b0d49f547a7a88a903bd3fc90`
- 最终代码验证点：`b35c6e20964b7538a04a9d49ba62b5c8318797ab`
- Batch 2 tag：`batch-2-accepted`（交付时解析到包含本 handoff 的最终提交）
- branch：`batch/2-readonly-data`
- 未 push

## 4. 修改文件摘要

新增语言无关 schema、TypeScript public adapters/book state/raw writer、Python contract/
identity/quality/replay、脱敏 fixtures、smoke/verify scripts、离线与 replay 测试，以及本批
设计/结果/证据文档。没有复制参考项目，也没有把 raw smoke 数据放入 Git。

完整清单：`reports/batches/batch-02/FILE-LIST.md`。

## 5. 测试摘要

- Python 63/63；全新 venv wheel install、`pip check`、仓库外执行均通过。
- Node 40/40；`npm ci`、typecheck、dependency tree 通过，0 npm vulnerabilities。
- smoke `smoke-20260715125957-6347222a`：4/4 manifest、0 partial、Python 9/9 checks。
- smoke raw 路径在仓库外，不交付给审阅者。

## 6. 关键设计决定

- TypeScript 在 I/O 边界记录最早 receive time 并耐久落 raw；Python 只验证和离线回放。
- `RawEventEnvelopeV1` 是跨语言唯一 wire contract，source/server 不存在时为 null。
- 市场身份按 slug epoch、精确 300 秒窗口、label-token、Chainlink 规则和 orderbook 联合验证。
- 没有官方 sequence 时永远 `continuity=UNVERIFIED`。
- 默认 Binance 只订阅 `btcusdt`；显式 smoke 后备可收全符号，但只让 BTC parsed，其余
  quarantine，且 transport scope 进入 manifest。
- closed segment/manifest no-clobber；replay 只消费验证时锁定的 bytes。

## 7. 最高风险

公开 CLOB/RTDS 无可验证 sequence/cursor，所以“保存了所有收到的事件”不能推导为“上游
没有丢包”。任何后续 feature/backtest 必须继承 `UNVERIFIED` 和 gap/stale fail-closed。

## 8. 未解决问题

- Binance 单符号 filter 在本环境中 60 秒沉默，长期方案尚未决定。
- final off-topic 分类补丁的重采集被公共网络 reset/error 阻断；离线对称测试已通过。
- 无长期 reconnect supervisor、跨进程 lease、DrvFS durability、point-in-time dataset。
- 无手续费/成交模拟、回测、策略、订单账本、shadow/live。

## 9. 下一步建议

只做一个进入第三批前的设计门：冻结 verified raw 到 point-in-time normalized dataset 的
可见性、lineage、质量标志和不可变版本合同。未获单独批准前不开始回测或策略。

## 10. 详细文档的项目内路径

- `reports/batches/batch-02/BATCH-2-RESULT.md`
- `docs/batches/batch-02-readonly-data/data-contract.md`
- `docs/batches/batch-02-readonly-data/market-identity.md`
- `docs/batches/batch-02-readonly-data/raw-storage.md`
- `docs/batches/batch-02-readonly-data/BATCH-02-DATA-QUALITY.md`
- `docs/batches/batch-02-readonly-data/data-provenance.md`
- `reports/batches/batch-02/BATCH-2-VERDICT.md`
- `reports/batches/batch-02/TEST-RESULTS-BATCH-2.md`
- `reports/batches/batch-02/SMOKE-CAPTURE-QUALITY.md`
- `reports/batches/batch-02/UNRESOLVED-ISSUES-BATCH-02.md`
