# 本地研究与 Paper MVP 验收

验收日期：2026-07-18  
代码基线：`a911351`（本文件随后随同当前工作树维护）

## 结论

`polymarket-money` 当前已具备可操作的研究与 paper MVP：固定的 K/J、L V1、L V2
历史研究可从同一 localhost 控制台显式启动；每次结果导出到仓外、可由控制台读取；已有
K/J public-paper 的验收结果也可在同一界面只读查看。该结论只说明产品闭环可用，**不**说明
任何策略盈利、也不授权新的实时采集、shadow 或 live。

## 逐项证据

| MVP 要求 | 当前证据 | 状态 |
|---|---|---|
| 历史策略研究 | `poly-lab paper-kj` 以及 `paper-l-adaptive`；固定研究注册表只允许 K/J frozen FINAL_TEST、L V1 TRAIN、L V2 train-selected VALIDATION | 通过 |
| 模拟成交、仓位、PnL | K/J replay 含 ask/bid、延迟、部分/no-fill、独立钱包、token position、fee/gross/net PnL；L 保持独立的历史研究路径 | 通过，非真实成交 |
| 结果导出 | 每次新的历史运行先写 `summary.json`、`events.ndjson`、`trades.csv`，再以 fsync 的 `publication.json` 提交三份文件的 size/SHA-256/result hash；public-paper 有 hash-bound result/journal/report 路径 | 通过 |
| 本地产品入口 | `npm run mvp:console -- --data-root /root/polymarket-money-data` 仅绑定 `127.0.0.1` | 通过 |
| 控制台运行权限 | 默认只读；只有 `--enable-local-history-runs` 才可发起三种固定的离线运行；API 不接受任意命令、路径、参数或网络模式，且一次只允许一个本地子进程 | 通过 |
| 研究结果可读性 | 历史表显示 net PnL、max drawdown、去最佳三天、fills；仅显示按 Python canonical JSON 规则复算 `result_hash` 成功的摘要；paper 表显示 accepted、plan binding、目标完成数及 J/K PnL | 通过 |
| 实时 paper 可见性 | 控制台只读 `paper-mvp/*/result.json` 或 `final-result.json`；网页没有 realtime 启动 API | 通过 |
| 真实订单安全 | `LIVE_TRADING_ENABLED=false`，无网页实时启动入口、无 private channel、无 signing/order adapter | 通过 |

## 已实际走通的产品路径

1. 控制台 API 启动 `v2-midrange-train-selected` 的离线 Validation BASE；子进程 exit 0，输出被
   `/api/results` 读取。结果 hash 为
   `e36598e51ba4e4334c4ba6f65069f46557aec559f76635fe68d0068b7bccb4c0`。
2. 同一入口重跑冻结 K/J FINAL_TEST BASE_1S：J net
   `+4.8956698638498977551796894`（135 fills），K net
   `-298.4573587392367656725813702`（137 fills），与既有冻结结论一致。
3. `/api/paper-runs` 正确读取既有 hash-bound 三市场 paper：
   `kj-paper-20260716225739-48ff7c99`，`accepted=true`，J/K paper net 分别为
   `182.86189715` / `205.272819795`。
4. `/api/results` 现会复算每份历史 `summary.json` 的 SHA-256；当前三个已发布本地结果均为
   `VERIFIED`，任何缺失、格式错误或不匹配 hash 的摘要均不显示。此核验只证明展示的
   summary 内容完整，不替代对 `events.ndjson`、`trades.csv` 或原始行情的独立审计。
5. 新历史导出只有在三份 sidecar 完整写入、逐文件 SHA-256/size 计算完成后才写入
   `publication.json`。进程中断留下的目录没有该提交清单，不能被未来完整导出校验器误认作
   发布成功；旧结果不追补该文件，也不改写历史产物。

## 验证命令

```text
npm test                         # 144 Node tests
npm run typecheck
.venv/bin/python -m unittest discover -s tests -v  # 200 Python tests
.venv/bin/python -m ruff check research tests
```

## 未跨越的边界

- 历史盘口来自第三方 1 Hz top-of-book，continuity 仍为 `UNVERIFIED`；L 缺连续 quote velocity 和
  point-in-time Chainlink boundary。
- K/J 历史结果并不具有严格 legacy tick/source/phase 等价；J 压力与集中度失败，K 为负。
- paper fill 是显式、保守的模拟，不是交易所真实成交；现有 public paper 仅为描述性证据。
- realtime paper 的新运行属于下一阶段的有限假设检验，应在明确批准后才启动；live 仍需独立、
  更高门槛的设计、对账和授权。
