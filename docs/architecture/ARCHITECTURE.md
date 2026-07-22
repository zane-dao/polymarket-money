# 当前架构

`polymarket-money` 是唯一主仓。参考项目保持只读；当前不建立第二套策略、账本、回放、
费用或产品入口。

## 最终确认的简化结构

```text
polymarket-money/
├── frontend/              React、TSX、HTML、CSS 及前端测试
├── src-tauri/             Tauri 配置、启动、系统能力和轻量命令桥接
├── backend/               market-data、backtest、risk、storage 等业务后端
├── strategies/            可被回测、paper 和后续执行共同调用的独立策略模块
├── tests/                 跨模块测试
├── data/                  说明、schema 和小型样本
└── docs/                  项目文档
```

这是一张目标图，不要求当前一次性创建所有目录。没有真实实现时不建空层级；现有代码只有
在职责、接口和测试明确后才按小批次移动。

## 当前工作树

- `frontend/src/`：已有 React 应用壳、8 个独立页面模块、共享 UI/图表组件、框架无关状态机、
  严格 command DTO 校验和可注入数据源端口。设计稿 HTML 只作为人工视觉规格，生产源码不
  导入、读取或解析它；已验证模式的策略、数据集、回测、查询和 Paper 操作均来自后端命令，
  不直接访问数据库、文件或公网。
- `src-tauri/src/`：提供 app-status 探测、固定短命令桥和唯一长期 Paper host owner；只接受
  闭合命令与 DTO，不承载策略、回测、账本或风控业务规则。
- `backend/`：已有 `market-data/`、`backtest/`、`risk/`、`storage/` 和测试；原顶层
  `execution/` 的 TypeScript 实现已整体归入 `backend/core/`，不再保留顶层 execution 目录。
- `strategies/src/`：拥有 TypeScript 策略合同、注册表与 K/J context/warmup；Python 公共注册表
  明确列出 B0-B3、J、K、L V1 和 L V2。J/K/L 的确定性研究实现已迁入
  `strategies/src/python/kj_l.py`，原 `research/polymarket_money/kj_paper.py` 仅保留兼容导入。
  `strategies/README.md` 说明用法，`strategies/TEST-RESULTS.md` 汇总专项验证与 L 历史证据边界；
  成交模拟、持久化和公共行情生命周期仍由后端拥有。
- `backend/core/`：保存原 TypeScript domain、adapter、runtime、storage 和 product 实现；其中
  runtime/paper 属于后端消费者，不属于策略实现。
- `research/polymarket_money/`：现有 Python 数据质量、回放、回测和尚待拆分的策略研究代码。
  旧只读 `polymarket_paper/strategy/main.py` 不可原样迁移；当前 J/K 是其经过审查的重构谱系，
  不是对旧网络、存储、结算和下单编排的复制。
- `tests/`、`data/`、`docs/`：继续使用现有结构。

## 模块职责与依赖

```text
frontend -> src-tauri bridge -> backend use cases -> strategy interface
                                      |              ^
                                      + backtest ----+
                                      + paper -------+
                                      + execution ---+
```

- `frontend` 只展示状态和提交显式请求，不读取数据库、文件或网络。
- `src-tauri` 只验证/转换 command DTO、提供必要系统能力并调用后端接口；业务规则不放这里。
- `backend` 按真实业务拆分，market-data 负责标准市场输入，backtest 负责因果回放，risk 负责
  独立风控决定，storage 负责接口与实现隔离。当前 facade 保证新调用路径存在且不复制实现；
  后续每次只迁移一个已验证模块。
- `strategies` 拥有统一的策略输入、决策输出、注册表和具体实现。策略是纯业务模块，不依赖
  frontend、Tauri、数据库实现、网络客户端或下单逻辑。
- 回测、paper 与未来执行只依赖策略公共接口，不直接引用具体策略文件。新增策略应只增加
  实现、注册项和测试。

## 当前运行链与不变量

现有公共行情仍经 `backend/core/src/adapters` 进入 domain snapshot，再由确定性策略、风险门和
paper engine 处理；journal/replay 保持唯一持久真相。迁移后只能改变目录和接口边界，不能
改变其经过验证的业务语义。

- `LIVE_TRADING_ENABLED=false`；前端或 Tauri 状态不能改写。
- 所有金额、概率和费用跨模块使用规范十进制字符串，时间使用明确 UTC 字段。
- 策略不执行 I/O；外部 I/O 通过 backend adapter，Tauri command 不拼接任意 shell。
- 会启动联网采集、paper 运行或任何账户操作的入口仍需用户当次明确批准。
- 实时 Paper 使用 Rust/Tauri 持有的唯一 Node 子进程和私有 stdin/stdout NDJSON IPC；renderer
  不能指定 executable、URL、文件路径或环境。子进程只加载固定 canonical 构建产物，短命令与
  长期 host 都禁止 `POLYMARKET_BACKEND_CLI` override。
- 公共实时输入由 Gamma/CLOB market 与 Binance Spot 组合 feed 提供；任一源断开、Binance 信号
  陈旧或 CLOB 快照陈旧时 host fail closed。CLOB continuity 仍明确为 `UNVERIFIED`。
- 组合 feed 使用同一 `ReceiveClock` 形成 K/J point-in-time context；K/J engine 的输入、决策、
  intent、fill 和结算事件写入可恢复 journal，前端只显示后端返回的 `STOPPED/RUNNING/DEGRADED`
  状态、钱包和事件，不生成 fallback。
- 回测 decisions/orders/fills/settlements/equity/replay、比较、健康和异常均走后端只读查询服务；
  查询先校验结果 SHA-256 sidecar，再做分页和字段白名单。数据库尚未接入时健康状态明确为
  `unavailable/degraded`，不会伪造正常状态。
- `monitor` 不改钱包；Chainlink relay 不作为官方结算；当前无 shadow/live 准入。

## 本地发布环境

个人生产采用最小的本地服务器模拟：4173 运行不可变 `stable` release 并只写
`production-sim` 数据根；4273 运行不可变 `candidate` release 并只写 `staging-sim` 数据根。
4174 仅为可选 Vite 热更新工具，其固定 API 代理指向 4273，不构成第三个部署环境。

release 同时冻结已构建的 TypeScript 后端、React 静态文件及 Python 回测运行所需源码；普通工作区
构建不得覆盖 release。测试通过时只移动 candidate/stable 指针，不重新构建。后端在启动时校验
`POLYMARKET_ENV`、release ID 与数据根后缀，并通过 app-status 模块公开运行身份；前端持续展示该
身份。当前只模拟本机 paper-only 生产，不改变联网批准或真实交易边界。

开发分支可供4174工作区热更新和4273固定 candidate 验证，但不得直接晋升到4173。合并后在干净
`main` checkout 生成最终 candidate，并由4273验证该精确产物；promotion 与 production-sim 启动
均拒绝非 `main` 或带未提交修改的 release。4173绑定的是一个明确 main commit，不是会自动变化的
分支头。
