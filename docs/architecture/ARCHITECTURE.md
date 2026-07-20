# 当前架构

`polymarket-money` 是项目代码、工程文档和 AI 项目管理文档的唯一主仓。旧产品、旧知识工作区和开源引擎仅作只读参考，不能形成第二套运行时或事实来源。

## 分层与依赖方向

```text
public adapters -> domain snapshots -> pure strategy -> risk gates -> paper engine
                                      |                               |
                                      +---- durable journal/replay ----+
```

- `research/`：Python 离线数据质量、历史回放、回测、K/J 与 L 研究；不持有真实执行凭据。
- `execution/src/domain/`：供应商无关的金额、时间、原始事件与机会类型。
- `execution/src/adapters/`：唯一允许外部 I/O 的层，包含公开市场数据和 Gamma 官方结算。
- `execution/src/strategy/`：K/J context 与 warmup 等显式输入、确定性逻辑。
- `execution/src/runtime/`：机会判断、风险相关运行时检查和 paper 生命周期。
- `execution/src/storage/`：append-only journal、SHA-256 链、checkpoint 与严格 replay。
- `execution/src/product/`：MVP、结算恢复、单次报告、cohort 与 campaign 汇总。

## 当前运行链

公开行情经 adapter 进入带 ReceiveStamp、市场身份、费用与时钟校验的 context；K/J 仅在显式 paper 模式和 durable journal 存在时可变更独立模拟钱包。冻结 intent 在规定延迟后按后续公开盘口模拟 fill/partial/no-fill。只有 Gamma 原始官方结算证据可以完成市场。journal 可在重启后重放恢复，报告会复核计划绑定、运行安全、结算与 PnL 恒等式。

`monitor` 不改钱包；RTDS Chainlink relay 仅是观测/信号，不能作为正式结算。当前不存在可达的 live adapter，也不进入 shadow/live。实现细节和验证见 [Batch 06 设计](../batches/batch-06-kj-paper/design.md)。
