# Batch 07 桌面架构整合

## 目标

在不改变现有研究结论、paper 会计和安全门的前提下，采用简化的 `frontend/`、轻量
`src-tauri/`、模块化 `backend/` 与独立 `strategies/` 目标。当前批先修复半完成变更并保持
现有代码可构建，不执行大规模目录重排。

## 已冻结边界

- 写入仓仅 `/root/projects/polymarket-money`；`/mnt/d/polymarket-paper` 与
  `/root/projects/polymarket-trade-engine` 只读。
- 不启动采集，不读取凭据，不连接账户/用户频道，不签名、下单或撤单。
- 不复制参考引擎 runtime、wallet、PnL、recovery 或 live gate。
- 不先移动 `execution/`、`research/` 或策略；接口与测试稳定后才调整目录。
- 不为空模板创建 `backend/`、`strategies/` 或其子目录。
- 安装或升级 npm/cargo/系统包前必须取得用户明确批准。

## 迁移单元

### 07A 盘点与目标架构

- 输入：当前主仓、旧知识工作区、开源引擎、既有审计和当前测试。
- 输出：模块职责、依赖、复用/适配/废弃表、目标边界和环境阻塞。
- 完成标准：报告可追溯到路径、commit、测试命令和工作树状态。
- 回滚：纯文档，可整体 revert。

### 07B 半完成修改收口

- 前端合同固定在 `frontend/src/`；不得使用顶层通用 `src/` 混放前后端。
- `src-tauri/src/` 只保留轻量系统状态与未来 command 桥接，不建立业务 domain/service 层。
- `AppStatusV1` 仅包含应用版本、UTC 时间、安全模式、
  `liveTradingEnabled=false`、模块可用性和数据根配置状态；不读取秘密。
- 本轮完成标准：现有 TypeScript 与 Rust 测试通过、diff 无空白错误、文档反映真实状态。
- 建立有代码和测试的 `backend/{market-data,backtest,risk,storage,tests}` 与
  `strategies/{src,tests}`；旧实现通过兼容入口逐步迁移，不建空目录、不复制实现。

### 07C React 工作台（经用户后续授权执行）

- 设计稿 HTML 只作视觉/交互规格，生产实现不得依赖它。
- React 页面按 app shell、页面、共享组件、domain/reducer、port/adapter 拆分。
- 预览数据必须独立且显式标记；真实数据只允许从校验后的只读 source 接入。
- 验收包括独立 TypeScript、组件测试、production build、localhost bundle smoke 和全仓回归。

### 后续批次

- 解耦并迁移 K/J context/warmup 到已经建立的 `strategies/`。
- 按实际职责评估现有代码进入 `backend/market-data`、`backtest`、`risk` 或 `storage`，不得
  为匹配模板一次性搬迁。
- Tauri command 与真实本地产物 read-model 在单独小批次接入；不把预览 adapter 当成真实来源。

## DTO 与调用规则

- DTO 名称带版本；时间为 UTC ISO 8601；金额/费用/概率为规范十进制字符串。
- command 层不含业务逻辑；service 不依赖 React；domain 不依赖 Tauri/vendor SDK。
- Python 仅以离线、固定子命令、结构化 stdin/stdout 和有界超时运行。
- TypeScript 保留模块不得通过 HTTP localhost 再造第二套产品 API；优先稳定库接口，必要的
  子进程桥也必须固定 executable/argv、超时、输出上限和 schema。

## 验证矩阵

| 对象 | 必需验证 |
|---|---|
| React | typecheck、组件/逻辑测试、production build |
| Rust/Tauri | fmt、clippy、unit/integration test、Tauri build |
| TypeScript 模块 | 现有 147 项及新增 contract/integration tests |
| Python 模块 | pytest、Ruff、共享 golden；环境缺失时不得声称通过 |
| 跨语言 | JSON schema/fixture、错误映射、超时、路径与安全负例 |
| 安全 | `LIVE_TRADING_ENABLED=false`、无秘密字段、无任意 shell/路径、离线可测 |

## 停止条件

- 参考来源有未解释的本地修改或许可证不明：不迁移该实现，只记录行为。
- 新路径需要凭据、账户、签名、订单或联网采集：停止并取得单独授权。
- 旧/新测试语义冲突：保留当前可信合同，先写 fail-first 证据再决定适配。
- Python/Rust/Node 环境缺失：记录精确错误；安装前请求批准。
