# 第一迁移批次结果

日期：2026-07-15

## 结果

第一批已建立独立于两个参考项目和真实 API 的 Python 领域模型、纯业务规则、离线 fill
会计、安全门禁和黄金测试。没有复制旧模块，没有接入 WebSocket、策略、回测、凭据或
真实执行。

## 完成标准

| 标准 | 结果 | 证据 |
|---|---|---|
| 实盘默认绝对关闭 | 满足 | `.env.example` 四项安全默认；live 工厂所有路径仍拒绝；无 live adapter |
| 统一数据和时间含义 | 满足（第一批范围） | `domain.py` 显式七类时间；UTC/字段契约测试；无 generic timestamp |
| 核心业务规则可重复测试 | 满足 | 30 项 Python 离线测试；三个人工市场 PnL fixture |

## 实现内容

- `domain.py`：Market、OutcomeToken、OraclePrice、OrderBookSnapshot、Decision、
  OrderIntent、Fill、Settlement、Position、PnL 及值对象。
- `rules.py`：BTC 五分钟身份、Chainlink BTC/USD、Up/Down 映射、tie=Up、bid/ask、
  oracle settlement builder 和时间因果门禁。
- `Settlement`：不可变地组合 Market 与 opening/closing OraclePrice；winner、token、
  start/end price 全部推导，跨市场、跨窗口、反向时间和错误 oracle 无法构造。
- `ledger.py`：逐 fill、费用、部分成交、重复 fill/settlement 和市场级 PnL 黄金口径。
- `safety.py`：无凭据 dry-run、单一 live 配置、客户端 fail-closed、幂等提交与 unknown
  outcome 不重试。

## 验证结果

- Python：`python3 -m unittest discover -s tests -p 'test_*.py'`，30/30 通过。
- 干净 Python：全新 venv 从项目构建/安装 wheel，导入路径位于 venv `site-packages`，
  从仓库外执行 30/30 通过。
- TypeScript：WSL 原生 Node v24.18.0、npm 11.16.0 执行 `npm ci && npm test`，通过；
  `which node/npm` 均为 `/usr/local/bin`，`process.platform=linux`。
- Python 配置：由 `tomllib` 在测试中解析，包清单与安全默认通过。
- 项目运行依赖：无；Python 实现只使用标准库。环境新增 Node 24 Linux 工具链和
  `python3.14-venv`，没有增加项目运行库。

## 未解决问题

- `FillLedger` 仅为内存黄金实现，没有 durable uniqueness、事件日志或崩溃恢复。
- 未对接官方动态 fee、maker/taker、实际舍入、rebate、账户持仓或官方 winner。
- 未实现订单簿 continuity/hash/gap/staleness、市场发现或只读采集。
- unknown outcome 只禁止重试，尚无 query-by-id/reconciliation。
- TypeScript 旧 scaffold 仍保留早期四时钟/`number` 接口；本批 Python 模型是业务裁判，
  实时 TypeScript schema 要在进入执行控制面前按本文档对齐。
- 未实现回测、GBM/GARCH、VaR/CVaR 或任何策略；这些不属于第一批。
- 新仓尚无首次 Git 提交，当前项目文件仍为 untracked；进入第二批前应建立可回滚基线。

## 实际文件清单

- Python：`research/__init__.py`、`research/polymarket_money/{__init__,domain,rules,ledger,safety}.py`。
- 测试：`tests/unit/{test_configuration,test_domain_model,test_safety_boundaries}.py`、
  `tests/golden/{test_market_rules,test_fill_ledger}.py` 及测试包入口。
- Fixture：`data/golden/batch-1/manual-markets.json`。
- 配置：`.env.example`、`.gitignore`、`pyproject.toml`。
- 第一批文档：`docs/{domain-model,safety-boundaries,golden-tests,batch-1-result}.md`。
- 同步状态文档：`README.md`、`docs/{architecture,known-risks,module-inventory,migration-plan,target-architecture}.md`。
- 项目 AI 层：总索引、spec/plan/goals/background/decisions/operations、会话摘要和旧路径跳转页。
- WSL 环境：官方 Node v24.18.0 安装于 `/usr/local/lib/nodejs/`，node/npm 入口位于
  `/usr/local/bin/`；Ubuntu 安装 `python3.14-venv`。

## 第二批启动时由 AI 完成的准备

1. 核对并记录只读数据源范围：Gamma/CLOB public market channel、Chainlink RTDS、Binance。
2. 将本批 Python 时间/schema 映射成跨语言版本化契约，明确 TypeScript 旧接口的替换方式。
3. 第二批如确需 Polars、PyArrow、DuckDB、Pydantic，由 AI 依据实现范围选择并锁定；
   不因“以后可能需要”提前安装。
4. 固定脱敏 fixture 的来源/provenance/hash 格式和 raw data 保存位置。
5. 继续强制第二批无凭据、只读、不可下单，且断线、gap、stale 一律 fail closed。

以上均由 AI 在第二批范围内自主决定和记录；只有涉及真实凭据、实盘授权、不可逆外部
操作或实质业务取舍时才请求用户决定。

第一批最终验收已满足：全部离线测试通过、实盘入口不可构造、领域规则不能产生矛盾
Settlement、干净环境可重复安装、文档与代码行为一致。完成后停止；本批没有开始数据
采集、回测迁移、策略迁移或实盘开发。
