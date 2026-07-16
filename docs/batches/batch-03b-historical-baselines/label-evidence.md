# Batch 3B 标签证据

## Headline 标签规则

训练、验证、测试和结算只接受 `OFFICIAL_RESOLUTION` 或更强的官方证据。本批没有取得可独立
复核的 Chainlink 开收盘价对，因此没有把 Binance 或第三方 outcome 冒充 oracle；headline
标签来自已关闭官方市场中明确的 1/0 `outcomePrices`。

每个市场必须同时满足：condition ID 一致、slug 对齐 UTC 五分钟边界、官方 `closed=true`、
Up/Down 与 token ID 可一一映射、价格明确一胜一负、证据抓取晚于市场结束、无身份冲突。
任一条件失败就排除，最终 tick、midpoint 和 Hugging Face `outcome` 均不能成为标签。

## 审计结果

| 项目 | 结果 |
|---|---:|
| PRIMARY_V2 市场 | 5,599 |
| OFFICIAL_RESOLUTION | 5,599 |
| 官方标签覆盖率 | 100% |
| 身份冲突 | 0 |
| 官方标签排除 | 0 |
| 第三方 outcome 为 null | 596 |
| 第三方 outcome 与官方不一致 | 13 |

596 个 null 和 13 个冲突证明第三方 outcome 只能用于审计比较。它们没有进入任何模型标签、
评估标签或结算。每条官方证据均绑定响应 SHA-256 和 fetch time；重复日边界响应只比较稳定的
市场证据字段，动态 series 元数据不参与身份判定。

## 剩余限制

官方 Gamma 响应是事后获取的市场静态/结算证据，不是市场结束当时保存的 oracle 数据。
因此本批能证明“官方最终 winner”，但不能证明 Chainlink 开收盘价格本身的逐点来源链。

