# Batch 4B-R1 result

Batch 4B-R1 已完成。第二次 Sol 唯一结论为
`PASS_WITH_NONBLOCKING_EVIDENCE_DEBT`；本批没有启动长期观测。

## 已关闭的 Critical

- ReceiveStamp、raw-event-v2 与 Python offline replay/normalization 使用同一亚秒排序合同；
- RuntimeIncident 与 writer emergency terminal path 失败关闭；
- decimal.js 私有 clone、Python/TS fee fixture 与单一 complete-set calculator 路径一致；
- OpportunityObservation 与 RouteEvaluation 分离，lineage/provenance/config hash 完整；
- baseline/fixed horizon 严格 PIT as-of，next-update 不污染 route-bound target evidence；
- external/Polymarket connection 分离，坏盘口、重连和信息类 CLOB 帧不会复用或刷新旧状态；
- episode v1、500ms gap、252-cell 网格与 raw/episode/market 计数冻结。

## 验证

Python 190/190、Node 89/89、Ruff、TypeScript、pip check、npm audit 与 diff check 均通过。
完整命令级结果见 `reports/batches/batch-04b-r1/TEST-RESULTS-BATCH-04B-R1.md`。

## 保留限制

- fee 精确 tie 仍为 `ROUNDING_TIE_UNVERIFIED`；
- CLOB continuity 仍为 `UNVERIFIED`；
- RouteEvaluation 仍为 `DATA_INSUFFICIENT`；
- 150 分钟观测、验收 tag、训练、shadow/live、User Channel、凭据、签名和订单均未执行。
