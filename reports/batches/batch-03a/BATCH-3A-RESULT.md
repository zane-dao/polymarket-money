# Batch 3A Result

## 结论

Batch 3A 的研究样本准入门、因果回放内核、四种显式执行假设、PIT 费率模型和可审计报告已
完成。全部工作离线，未接入模型、策略优化、真实历史数据、WebSocket、凭据或交易入口。

本批复用 Batch 1 的领域对象与账本，没有建立第二套 Fill/Settlement/PnL 真相。发布数据只能
经验证加载器进入 ReplayEngine；重复 ID/幂等键、隔离结算价、未来数据、无结算持仓和未知
费率均失败关闭或降级为不可验证状态。

三个人工市场经 raw fixture → normalized publish/load → PIT replay → execution → per-fill fee →
Batch 1 ledger → Chainlink settlement → report 全链路得到数值净收益 4.40、5.03、2.19，且
毛收益、手续费、payout、cash outlay 与人工计算分别一致。fixture 费率不是历史证据，故这些
结果明确为 `COMPLETE_FEE_UNVERIFIED`，不能解释为真实净收益。

## 验证

- clean venv：`pip install -e '.[dev]'` 成功。
- Ruff：通过。
- pytest：155 passed。
- Node：40 passed；TypeScript build/typecheck 通过。
- WSL：`node`、`npm` 均来自 `/usr/local/bin`，`process.platform=linux`。

详细证据见 `reports/batches/batch-03a/`。结论为：3A 工程完成标准通过，但不自动授权进入
3B；真实历史回测前仍需用户确认、合格 normalized 数据集及可审计历史费率证据。

