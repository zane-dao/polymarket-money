# 第一批黄金测试

## 裁判原则

这些测试是后续迁移的业务裁判。旧项目已有 108 项测试通过，只能说明旧实现满足旧假设，
不能替代本批对市场规则、因果时间、可执行价格、fill 会计和安全门禁的独立验证。

全部测试离线、确定性运行，不读取环境凭据，不访问网络，不调用 Polymarket API。

## 必需场景

| # | 场景 | 测试位置 | 预期 |
|---|---|---|---|
| 1 | Up/Down 映射 | `test_market_rules.py` | token 数组颠倒仍按标签映射 |
| 2 | 上涨结算 | `test_market_rules.py` | Up |
| 3 | 平价结算 | `test_market_rules.py` | Up，并映射 Up token |
| 4 | 下跌结算 | `test_market_rules.py` | Down |
| 5 | 买入定价 | `test_market_rules.py` | best ask，不是 mid |
| 6 | 卖出定价 | `test_market_rules.py` | best bid，不是 mid |
| 7 | 手续费后 PnL | `test_fill_ledger.py` | gross 与 fee 分开，net 精确 |
| 8 | 部分成交 PnL | `test_fill_ledger.py` | 每个 fill 分别计价和收费 |
| 9 | 未成交 | `test_fill_ledger.py` | 不产生 position |
| 10 | 重复 fill | `test_fill_ledger.py` | 第二次不记账 |
| 11 | 重复 settlement | `test_fill_ledger.py` | 第二次不结算 |
| 12 | 未来数据 | `test_market_rules.py` | 抛出 causality violation |
| 13 | unknown order outcome | `test_safety_boundaries.py` | 返回首次 unknown，不调用第二次 |
| 14 | 未授权/测试环境 live client | `test_safety_boundaries.py` | 创建失败，factory 未调用 |
| 15 | 三个人工市场 | `test_fill_ledger.py` + JSON fixture | net PnL 与手算完全一致 |

另有负向约束测试：UTC 必须显式、模糊 `timestamp` 字段禁止、非 Chainlink oracle 拒绝、
非五分钟市场拒绝、开收价跨市场/跨窗口/时间反转拒绝、Settlement 不可变、无幂等键拒绝、
幂等键内容冲突拒绝、旧 `PROD/FORCE_PROD` 配置拒绝、Python 配置与安全示例检查。

## 三个人工市场

fixture：`data/golden/batch-1/manual-markets.json`。所有数值以十进制字符串保存。

| 市场 | fills | payout | cash outlay | fees | net PnL |
|---|---|---:|---:|---:|---:|
| Up 胜 | 买 10 @ 0.55 | 10.00 | 5.50 | 0.10 | 4.40 |
| 平价 Up，部分成交 | 买 4 @ 0.48；买 6 @ 0.50 | 10.00 | 4.92 | 0.05 | 5.03 |
| Down 胜，部分卖出 | 买 8 @ 0.60；卖 3 @ 0.70 | 5.00 | 2.70 | 0.11 | 2.19 |

## 运行方式

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
```

TypeScript contract 使用已有 TypeScript 5.9.3 做 `tsc --noEmit`。若 WSL 没有原生 Node、
必须先安装 Linux Node/npm；不允许调用 Windows `node.exe`/`npm.cmd` 代替 WSL 工具链。
当前验证环境为 `/usr/local/bin/node` v24.18.0、`/usr/local/bin/npm` 11.16.0，且
`node -p "process.platform"` 返回 `linux`。

干净 Python 安装验收从仓库外运行：新建 venv，`pip install` 从 `pyproject.toml` 构建并
安装 wheel，确认导入来自 venv `site-packages`，再执行全部 unittest。
