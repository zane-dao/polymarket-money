# 2026-07-16 Batch 4B-R2 24 市场预注册观测

## 目标

复用 R1 唯一路径执行 metrics-only、raw=false、24 完整市场/最长 150 分钟公开观测；不训练、
不进入 shadow/live，不使用凭据、User Channel、签名或订单。

## 事实与证据

- 冻结 config SHA-256 `074324aa...9127c` 未修改；collector commit `f227461`。
- 有效 run 7,262.862 秒，24 observed、15 complete、34 incidents，最终 fee evidence 窗口异常
  terminal fail closed；用户决定不重跑。
- Complete-set 正 edge 0；lead-lag 71 triggers/51 episodes/11 markets 且单一来源；maker 无
  markout/queue/fill。唯一 verdict `INCOMPLETE_EVIDENCE`。
- 详细证据在代码仓 `docs/batches/batch-04b-r2/` 与 `reports/batches/batch-04b-r2/`。

## 修改

- AI 项目层：更新 INDEX、CURRENT、D-020、本摘要和会话索引。
- 代码层：Gamma fee 原始数值词法、市场窗口拒绝、working-history 清理、统一 AbortSignal
  socket 收口、降低 metrics snapshot 开销，以及结果/质量/路线/测试报告。
- 外部状态：Linux-native 数据根保留 metrics/summary/analysis；Windows 只交付 handoff。

## 验证

- Python 190/190、Node 95/95、Ruff、TypeScript、clean venv `.[dev]`、pip check、npm ci、
  npm audit 0 vulnerabilities、diff check 全通过。
- 未创建 R2、4B 或 4A 验收标签，未 push。

## 决定

- D-020：不重跑、不降门、不追认；保持 `INCOMPLETE_EVIDENCE`。

## 未决问题

- Graceful-degradation 整改尚未经过新长期运行验证；relay 无有效样本；maker 私有 fill/queue
  和 markout 证据缺失；continuity 仍 `UNVERIFIED`。

## 下一步

停止。只有用户另行授权的新批次才可继续研究；不得进入 shadow/live。
