# Paper Simulation 执行核心

本目录是模拟订单、成交、资金、仓位、风险和结算的通用执行核心，不执行网络访问、认证、
签名或真实下单。调用方必须通过后端行情 adapter 提供只读 `PaperMarketSnapshotV1`；前端不得
直接调用本模块或读取其持久化状态。

## 订单和手续费契约

- `PaperOrderRequestV1` 是已有的兼容契约，使用 `成交价 × 数量 × feeRate` 的线性费用。
  它只适合既有手工 Paper 测试和兼容读取，不得用于新增自动策略。
- `PaperOrderRequestV2` 是自动策略的强制契约，必须携带严格的 `PaperFeeEvidenceV1`。
  当前唯一支持的模型为 `POLYMARKET_TAKER_CURVE_V1`。
- 自动策略协调器在接受订单前必须调用 `assertAutomatedPaperOrderRequestV2`，禁止把 V1
  请求静默升级或猜测费用证据。

V2 的风险检查和每一档模拟成交都复用 `backend/core/src/runtime/fee-edge.ts` 中的
`FeeEdgeCalculator`，费用为 `rate × price × (1-price) × quantity`，并沿用统一的五位小数
舍入规则。证据缺失、证据不在生效时间内、费用无法计算或出现未验证的舍入平局时均
fail closed，订单以 `FEE_CALCULATION_UNAVAILABLE` 拒绝，不产生模拟成交。

多档盘口按实际吃到的每一档价格和数量分别计算费用。V2 请求及其费用证据拒绝未知字段；
幂等指纹包含完整请求，因此同一幂等键不能更换费用证据。导出的
`PaperSimulationStateV1` 保存订单、成交、资金和幂等映射；恢复后重放完全相同的 V2 请求
只返回原订单，不会重复扣款或成交。

修改本目录时至少运行：

```bash
npm run build
node --test dist/backend/tests/paper-simulation.test.js dist/backend/tests/paper-session.test.js
```
