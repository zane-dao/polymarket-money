# 策略模块

`strategies/` 是回测、Paper Trading 和未来执行层共用的唯一策略实现目录。策略代码必须保持
确定性：不访问网络、数据库、文件系统、钱包或系统时钟；所有输入由调用方显式传入。

## 当前结构

- `src/index.ts`：TypeScript 统一策略输入、输出与注册表。
- `src/kj-context.ts`、`src/kj-warmup.ts`：K/J 的纯上下文和预热逻辑。
- `src/python/registry.py`：Python 策略权威注册表，列出 B0-B3、J、K、L V1、L V2。
- `src/python/kj_l.py`：J/K 历史重建以及 L V1/V2 的确定性研究实现。
- `src/python/kj_ewma.py`：K/J 的 EWMA 信号实现。
- `tests/`：策略注册、版本隔离、冻结参数和 fail-closed 边界测试。
- `TEST-RESULTS.md`：策略专项测试结果与历史研究证据索引。

`research/polymarket_money/kj_paper.py` 和 `kj_ewma.py` 只是兼容导入层。新代码必须从
`strategies.src.python` 导入，不能继续往兼容层增加策略实现。

## L V1 与 L V2

- `L_ADAPTIVE_EXECUTION_V1`：版本 `l-adaptive-execution-v1-preregistered`，历史 gate 已失败，
  状态固定为 `RESEARCH_GATE_FAILED`。
- `L_ADAPTIVE_EXECUTION_V2`：版本 `l-adaptive-execution-v2-candidate`，仅限离线研究，状态固定为
  `RESEARCH_ONLY_CANDIDATE`。

两者共用经过审查的纯决策函数，但使用不同冻结配置和注册表身份。L 不得混入 K/J 实时路径，
不得打开 `FINAL_TEST`，也不得因已有结果事后调参。进入实时 Paper 之前仍需连续 CLOB quote
velocity 与 point-in-time Chainlink boundary 证据。

## 修改规则

### 新增一个可在 Web 工作台验证的策略

当前采用“开发者注册、用户保存参数版本”的安全模型。Web 页面不会上传 Python/TypeScript
源码，也不会动态导入用户文件。新增策略不需要修改页面、Web command 或
`scripts/run_workbench_backtest.py` 回测框架，只需完成以下受审查的注册：

1. 在 `src/python/registry.py` 增加 `StrategyDescriptor`。离线回测策略必须提供
   `workbench_backtest` 适配器；适配器接收已校验的历史数据、参数、初始资金和仓位上限，返回
   统一研究结果及其结果策略 ID。没有适配器的策略会 fail closed，不能被回测 worker 执行；
2. 在 `backend/strategy-management/index.ts` 的默认 catalog 注册同一个 `strategyId`、展示名称、
   `runtime: "python"`、`allowedModes: ["backtest"]`（需要 Paper 时另行审查）和参数 Schema；
3. 在 `strategies/tests/test_python_registry.py` 测试注册适配器，在
   `backend/tests/strategy-management.test.ts` 测试参数缺失、类型、范围和未知参数；
4. 启动 Web 后，策略页会自动从后端 catalog 显示该策略。用户通过页面校验参数、保存不可变语义
   版本；回测页从同一后端定义和已保存版本中选择，无需添加页面条件分支。

这里的“新增策略”只表示登记仓库内经过审查的确定性实现，不表示允许 UI 任意上传或执行代码。
策略适配器不得访问网络、数据库、文件、系统时钟、钱包或下单接口。

新增或修改策略时，还应同时：

1. 在统一注册表增加或更新明确版本；
2. 在 `strategies/tests/` 增加确定性、版本和安全边界测试；
3. 更新本文件及 `TEST-RESULTS.md`；
4. 若接口、状态或准入边界改变，同步更新 `docs/architecture/ARCHITECTURE.md`、
   `docs/plan/CURRENT.md` 和 `docs/decisions/DECISIONS.md`；
5. 保持 `LIVE_TRADING_ENABLED=false`，策略层永远不能持有真实下单能力。

运行策略专项测试：

```bash
python3 -m unittest discover -s strategies/tests -p 'test_*.py'
npm run build
node --test dist/strategies/tests/*.test.js
```
