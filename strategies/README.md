# 策略模块

`strategies/` 是回测、Paper Trading 和未来执行层共用的唯一策略实现目录。策略代码必须保持
确定性：不访问网络、数据库、文件系统、钱包或系统时钟；所有输入由调用方显式传入。

## 当前结构

- `catalog.json`：策略元数据、内置冻结版本、参数 Schema、允许模式、实现版本和执行器键的唯一权威登记源。
- `src/index.ts`：TypeScript 统一标准化输入与 `NO_TRADE | TARGET_POSITION` 输出合同。
- `src/kj-context.ts`、`src/kj-warmup.ts`：K/J 的纯上下文和预热逻辑。
- `src/python/registry.py`：从 `catalog.json` 生成 Python 执行视图，只维护执行器函数映射。
- `src/python/kj_l.py`：J/K 历史重建以及 L V1/V2 的确定性研究实现。
- `src/python/kj_ewma.py`：K/J 的 EWMA 信号实现。
- `tests/`：策略注册、版本隔离、冻结参数和 fail-closed 边界测试。
- `TEST-RESULTS.md`：策略专项测试结果与历史研究证据索引。

`research/polymarket_money/kj_paper.py` 和 `kj_ewma.py` 只是兼容导入层。新代码必须从
`strategies.src.python` 导入，不能继续往兼容层增加策略实现。

## L V1 与 L V2

- `L_ADAPTIVE_EXECUTION_V1`：版本 `l-adaptive-execution-v1-preregistered`，历史 gate 已失败，
  状态固定为 `RESEARCH_GATE_FAILED`。
- `L_ADAPTIVE_EXECUTION_V2`：版本 `l-adaptive-execution-v2-candidate`，允许公开行情驱动的
  `PAPER_ONLY` 验证，状态为 `PAPER_CANDIDATE`；不具备真实下单权限。

V2 的 TypeScript 实时实现仍是显式输入、无 I/O 的纯决策函数，通过既有 Paper engine 合同运行。
K/J/L 可分别选择，但每个新的去重订单簿状态只触发所选策略一次；Binance 单独变化与心跳不触发
正式决策。不得打开 `FINAL_TEST`，也不得因已看到的验证结果事后调参。实时 Paper 只能形成执行与
稳定性证据，不能把稀疏历史参数扫描或短时在线结果称为盈利证明。

## 修改规则

### 新增一个可在 Web 工作台验证的策略

当前采用“开发者在 catalog 内登记内置版本、用户可另存不可变参数版本”的安全模型。Web 页面不会
上传 Python/TypeScript 源码，也不会动态导入用户文件。新增策略不需要修改页面、Web command 或
`scripts/run_workbench_backtest.py` 回测框架，只需完成以下受审查的注册：

1. 只在 `catalog.json` 增加策略身份、展示信息、内置版本、实现版本、参数 Schema、允许模式和执行器键；
2. 在 `src/python/registry.py` 的执行器映射绑定已有的纯策略实现。离线回测策略必须绑定
   `workbench_backtest` runner；未绑定则 fail closed；
3. 在 `strategies/tests/test_python_registry.py` 测试生成的执行视图，在
   `backend/tests/strategy-management.test.ts` 测试参数缺失、类型、范围和未知参数；
4. 启动 Web 后，Runner、策略页和回测页会自动显示 catalog 中的策略及内置版本；无需先保存版本，
   也无需添加页面条件分支。用户另存的不可变版本与内置版本通过同一后端读取接口选择。

这里的“新增策略”只表示登记仓库内经过审查的确定性实现，不表示允许 UI 任意上传或执行代码。
策略适配器不得访问网络、数据库、文件、系统时钟、钱包或下单接口。

新增或修改策略时，还应同时：

1. 在唯一 `catalog.json` 增加或更新明确版本；
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
