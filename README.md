# polymarket-money

`polymarket-money` 是面向 Polymarket BTC 五分钟市场的 clean-room 研究与 paper 系统。它包含确定性策略逻辑、风险边界、离线回放、公开行情适配和可重放的 paper 执行抽象；没有用户频道、签名客户端或真实下单路径。

完整项目上下文、当前计划、规范和决策均位于 [docs/INDEX.md](docs/INDEX.md)。实质任务必须按该索引渐进阅读；本仓是唯一主项目。

## 安全默认值

- `LIVE_TRADING_ENABLED=false` 必须持续有效。
- 不提交私钥、助记词、API Key、cookie 或账户数据。
- 策略代码保持纯函数和确定性；外部 I/O 只能位于 adapter。
- 不导入旧运行时或开源引擎模块。历史 J/K paper 研究是经审查的 clean-room 重建，并在每份结果中记录信号忠实度限制。

## 目录

- `research/`：notebook、数据集、特征研究、回测和研究报告。
- `research/polymarket_money/`：供应商无关的 Python 领域规则、安全逻辑和离线成交会计。
- `execution/src/domain/`：共享领域契约；`adapters/`：外部系统接口；`strategy/`：纯策略契约；`risk/`：风控配置和决定。
- `data/`：本地数据、确定性 fixture 和 golden 输出；`tests/`：unit、integration、replay、golden 与 shadow 测试。
- `docs/batches/`：Batch 设计、范围和验收要求；`reports/batches/`：测试、环境和验证证据。
- `docs/plan/`：当前计划、路线和 backlog；`docs/spec/`、`docs/goals/`、`docs/decisions/`：稳定边界、目标和长期决定。

## 开发与验证

需要 Python 3.11+ 和 Node.js 24+：

```bash
npm ci
npm test
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

`npm test` 会编译 TypeScript 并运行 Node 运行时测试。公开 smoke 必须使用仓外的绝对 `POLY_DATA_ROOT`；任何测试或脚本均不得启用真实交易。

默认 Binance transport 使用精确的公开 `btcusdt` 过滤。`--binance-transport all-symbols-quarantine` 仅用于上游过滤静默时的有界协议 smoke；非 BTC 帧只能进入 quarantine，不能进入有效 BTC 流。原始 smoke 数据始终位于 Git 仓外。

## 本地 MVP Console

无凭据的本地 console 将历史 K/J、L 回放和有界 realtime-paper 命令呈现在同一 localhost 页面。它不会自动启动采集、paper 或订单，并只读取 `<data-root>/mvp-runs` 下的小型已发布 `summary.json`，不会读取原始采集或 journal。

```bash
npm run mvp:console -- --data-root /root/polymarket-money-data
```

打开 `http://127.0.0.1:4173`。若要允许页面启动三种固定的**离线**历史回放（K/J、L V1、L V2），在启动时显式加入：

```bash
npm run mvp:console -- --data-root /root/polymarket-money-data --enable-local-history-runs
```

API 不接受任意命令、参数、输出路径或网络模式；一次只允许一个本地历史运行。页面也可以显示已有 `paper-mvp/*/result.json` 或恢复后的 `final-result.json` 的验收状态、计划绑定、目标数量和逐策略 paper PnL，但不会读取 journal 或启动 realtime 进程。验收证据见 [MVP Console 验收](docs/batches/batch-06-kj-paper/mvp-console-acceptance.md)。

## 历史 K/J 与 L 研究

`poly-lab build-kj-ewma` 从 Batch 3B 固定的官方 Binance 一秒归档构建 content-addressed、point-in-time 波动率产物；`poly-lab paper-kj` 在 hash 验证后的历史数据上进行无凭据、确定性的 J/K 重建，并输出 `summary.json`、`events.ndjson` 与 `trades.csv`。当前结果的忠实度只能标为 `CANONICAL_5S_EWMA_OFFICIAL_BINANCE_1S_CLOSE`：它不是逐 tick legacy 重现，也不是 live 盈利证据，因为缺旧实时成交流、K 的 USD 换算和 legacy `vol_epoch`。

```bash
.venv/bin/poly-lab paper-kj \
  --dataset /root/polymarket-money-data/external-research/normalized/<已验证数据集> \
  --dataset-hash <数据集哈希> \
  --ewma-artifact /root/polymarket-money-data/external-research/kj-ewma/<产物目录> \
  --strategy both --split FINAL_TEST --horizon 30 --scenario BASE_1S \
  --output /root/polymarket-money-data/paper-runs/my-kj-run
```

输出目录不得已存在，防止静默覆盖。

`L_ADAPTIVE_EXECUTION` 与冻结的 J/K 命令刻意隔离：它是 Python-only、research-only 的动态 edge 实验，使用平滑 30/60/120 秒波动混合、概率拖累及独立导出的费用、overround、延迟、深度和 reprice-risk 项。它只接受 `TRAIN` 或 `VALIDATION`，CLI/API 都拒绝 `FINAL_TEST`，不存在 TypeScript runtime 或 paper-MVP 路径。冻结 V1 未通过独立验证，不能进入 realtime paper、shadow 或 live。

## 公开 Paper 运行边界

TypeScript public runtime 输出 paper-only 的 `kjStrategyContextReady/reason/context` envelope，其中绑定已验证的 Up/Down token ID、fee 证据、book/signal receive stamp、freshness 与来源身份。仅在 `paper` 模式且提供 `--kj-paper-journal` 时，`kj-paper-engine-v2` 才会消费 ready context 并产生 versioned decision、intent、延迟 fill/no-fill、wallet、position、market-state 和官方结算事件；未提供 journal 时，runtime 只输出 StrategyContext 证据，J/K wallet 不会改变。

```bash
npm run runtime:live -- paper \
  --duration-seconds 300 --record metrics \
  --git-commit "$(git rev-parse HEAD)" \
  --kj-paper-journal /root/polymarket-money-data/paper-runtime/kj-inputs.ndjson
```

journal 必须是 Git 仓外、Linux-native、绝对路径且不是 symlink；每个接受输入均 fsync，记录 hash 链和独立 tail checkpoint，并可在重启后严格回放 context、fill、reservation、wallet、position 和 settlement。使用 `npm run paper:inspect -- /absolute/path/to/kj-inputs.ndjson` 离线检查。

K/J 默认快速信号是 Binance spot；有界 paper runtime 可使用 `--kj-signal-source chainlink` 选择公开 Polymarket Chainlink relay。每个 context 都保留 provider、receive stamp、connection ID 和 input hash。这是单一来源运行，不是混合价格；双来源比较必须隔离 wallet 与 EWMA。

完整的 paired/campaign、warmup、结算恢复、replay report、cohort 和 observability 命令、前置条件及 fail-closed 规则见 [Batch 06 设计](docs/batches/batch-06-kj-paper/design.md) 与 [受控 Paper 协议](docs/batches/batch-06-kj-paper/next-controlled-paper-protocol.md)。

最小端到端 product run：

```bash
npm run paper:mvp -- --markets 1
```

它等待下一个完整五分钟市场，以独立 paper wallet 运行 K/J，轮询公开 Gamma 结算结果并记录精确响应。只有所有目标市场已结算、无 pending intent、无 terminal failure、无凭据访问、无 live client、无用户频道且无真实订单时才可能被接受。描述性 paper PnL 不构成盈利、真实成交、shadow 或 live 证据。
