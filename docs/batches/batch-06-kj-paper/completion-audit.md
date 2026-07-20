# Batch 06：K/J 研究与 Paper MVP 完成度审计

审计日期：2026-07-18
代码分支：`batch/06-kj-paper-loop`
审计基线：`a7f6231`。下列 L 研究边界、恢复加固和本地 MVP 结果发布均已在当前工作树验证。

## 决定

当前工程 MVP 可运行且可 replay 验证，但项目总目标尚未完成。

- `MVP_ENGINEERING_COMPLETE`：历史 K/J 研究和有界 public-data paper loop 已连接 market identity、signal、intent、延迟理论 fill、wallet reservation、token position、官方 settlement、PnL、durable journal、recovery、finalization 和 report export。
- `CURRENT_PLAN_BOUND_MULTI_MARKET_EVIDENCE_COMPLETE`：两次获批的三市场非重叠 public run 均在 context 前记录 `RUN_PLAN`，返回 `accepted=true`，并生成 replay-verified 的 `DESCRIPTIVE_PAPER_ONLY` report；这只是产品路径证据。
- `NOT_SHADOW_OR_LIVE_READY`：public CLOB continuity 仍为 `UNVERIFIED`，fill 仍是理论模型，历史 K/J 不具 strict legacy signal fidelity，且没有稳定的独立样本正 edge。

## 逐项证据与限制

| 要求 | 结论 | 证据与剩余限制 |
|---|---|---|
| 唯一主项目 | 已证明 | 新代码与工程文档均在本仓；D-022 将 workbench 和参考仓标为只读。旧产品仍作历史参考。 |
| 旧 K/J 路径与复用决策 | 已证明（可得来源范围） | `docs/archive/reference-audits/legacy-project-deep-audit.md`、`docs/archive/reference-audits/legacy-module-inventory.md`、`docs/batches/batch-04b-multi-edge/reuse-register.md` 和 `docs/archive/reference-audits/open-source-engine-review.md` 记录职责、来源与许可证边界；仍缺旧 live tick、K USD conversion、`vol_epoch`。 |
| 历史/公开数据进入 K/J | 已证明 | `build-kj-ewma`、`paper-kj` 和 public runtime 均有 hash/identity 约束；Python 与 runtime 是代表性契约一致，不是逐字节等价。 |
| market identity 与官方结算 | 已证明 | adapter 验证 slug/condition/time/token；精确 Gamma response 进入 journal 并在 replay 重验。上游没有可证明 gap-free cursor。 |
| paper execution 与会计 | 已证明为理论 paper 模型 | 冻结 intent、一秒 latency、slippage guard、partial/no-fill、独立 J/K wallet、reservation、position、fee/PnL identity 均有测试；没有 queue、hidden liquidity 或真实成交证明。 |
| durable restart 与篡改检测 | 已证明为 paper input | fsync、sequence/hash chain、checkpoint、replay、plan binding、tamper/truncation/symlink 测试通过；不是 exchange open-order reconciliation。 |
| delayed settlement recovery | 已证明离线闭环 | `paper:settle -> paper:finalize -> paper:report -> paper:cohort-observability-report` 复用同一 acceptance contract；计划绑定后的真实公开 delayed case 尚未发生。 |
| 本地研究产品面 | 已证明 | localhost-only `mvp:console` 只显示固定 offline K/J、L V1/L V2 研究，不启动 public paper 或订单。 |
| 策略盈利 | 未证明 | Final Test 中 J BASE 微正但 stress/集中度移除后为负；K 两种 scenario 均负。不得用 Final Test 调参，也不进入 shadow/live。 |
| L adaptive | 历史 gate 拒绝 | Python-only V1 的 TRAIN 为 -20.66、冻结 VALIDATION 为 -1287.05；缺连续 quote velocity 与 point-in-time Chainlink boundary，Final Test 保持关闭。 |

## 当前验证

```text
Python: 200 passed
Node/TypeScript: 146 passed
Ruff: passed
TypeScript typecheck: passed
git diff --check: passed
```

`pnlReconciliationResidual` 只允许绝对值不超过 `1e-60`，且 accepted result 的 final cash/net PnL 仍必须与 wallet 严格匹配。K 的 180 秒 journaled `WARMUP_SIGNAL` 只更新 EWMA，不能创建 market、intent、wallet event 或 settlement candidate；来源 family 不可混用。

两次 plan-bound 三市场 run 和其 cohort 均为 `DESCRIPTIVE_PAPER_ONLY`，`profitabilityClaimEligible=false`。后续正式 campaign 必须使用 `paper:campaign-plan`、campaign-bound `paper:mvp`、`paper:campaign-cohort-report` 与 `paper:campaign-cohort-observability-report`；任一缺窗、失败或身份/安全冲突不得补跑或择优汇总。

## 下一证据门

后续有界 run 应在不改参数的前提下积累独立预注册多市场样本，记录连接稳定性、官方 resolution delay、fill/no-fill 与 PnL 分布。每次 run 必须满足：`resultKind=INITIAL`、`accepted=true`、`planBinding=HASH_CHAINED`；恰好完成计划 target 且无 pending risk；commit/window/journal/runtime 与 hash-chained plan 匹配；terminal failure 为空且 credential/user-channel/order counter 为零；`paper:report` 验证 settlement/PnL identity 并导出稳定 hash。结果持续只是描述性 paper 证据。
