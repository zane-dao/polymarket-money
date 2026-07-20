# 当前状态

更新时间：2026-07-20

本文件只回答“现在做到哪里、下一步是什么、当前能做什么”。历史过程、旧测试数字和逐次
提交记录不在这里维护；截至 2026-07-18 的完整旧状态已归档为
[当前状态历史快照](../archive/current-state/2026-07-18-current-state-snapshot.md)。

## 当前结论

- `polymarket-money` 是唯一主项目；旧 workbench、旧项目和开源引擎只读。
- 本地研究与 paper MVP 工程闭环已完成，结论为 `MVP_ENGINEERING_COMPLETE`。
- K/J 历史结果与少量公开 paper 结果只具描述性：J 的正值对压力和集中度不稳，K 的冻结
  历史结果为负；均未证明可持续盈利。
- L V1 历史门失败；L V2 仍是 research-only 候选，未进入实时 K/J 路径。
- Batch 4B-R2 以 `INCOMPLETE_EVIDENCE` 关闭且不重跑。公共 CLOB continuity 仍为
  `UNVERIFIED`。
- `paired-20260718-0900` campaign 已在预热前按用户要求永久中止；不得补跑或计入证据。
- 当前没有 shadow/live 准入，也没有可达的真实下单路径。

## 当前 Batch

没有正在执行的产品或研究 Batch。本轮仅整理文档治理，不改变策略、运行时或研究结论。
历史 Batch 的设计与结论从 [Batch 索引](../batches/BATCHES-INDEX.md) 进入。

## 下一步

1. 先提出一个明确、有限、可证伪的研究问题，再决定是否建立新 Batch。
2. 若要启动任何公开联网 paper/campaign，必须取得用户当次明确批准，并在启动前冻结窗口、
   配置、commit/hash 和完整 cohort 验收规则。
3. K/J 保持冻结，禁止用单场或 Final Test 结果反向调参；L 的后续研究须先补齐连续、
   point-in-time 的 CLOB quote 与可验证 Chainlink boundary 输入。
4. shadow/live 继续关闭，只有独立证据门和单独授权才能改变。

## 当前硬边界

- `LIVE_TRADING_ENABLED=false`。
- 不读取凭据，不连接私有用户频道，不签名，不下单或撤单。
- 不把 paper PnL、单场成功、旧测试通过或工程完成当作盈利、连续性或实盘证据。
- 不自动重跑被中止 campaign，不以降低门槛“补齐”不完整证据。

## 最近验证基线

- 当前最新文档化代码验证：Node `147/147`（提交 `517a48a`）。
- 最近完整 MVP 工程审计：Node `146/146`、Python `200/200`、Ruff 与 TypeScript 通过
  （提交 `cfb6f64`）。
- 本轮是文档整改，未重新运行代码测试；文档链接和文件名检查见本轮交付结果。

具体结果必须进入 [报告索引](../../reports/REPORTS-INDEX.md)；长期取舍只进入
[长期决策](../decisions/DECISIONS.md)；未完成工作只进入 [Backlog](BACKLOG.md)。
