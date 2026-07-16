# Batch 4B Reuse Gate

状态：**通过（仅观测；不授权代码迁移或交易接入）**

审计范围：主项目 `/root/projects/polymarket-money`，旧项目路径
`/root/projects/polymarket-paper`（不存在），开源引擎实际路径
`/root/projects/olymarket-trade-engine`（请求名称缺少首字母 `p`）。参考项目均只读；本报告
及 `docs/reuse-register.md` 是本次唯一写入位置。

## 最终决定

Batch 4B 的四种 edge 只能复用主项目现有的 point-in-time 数据合同、盘口状态、延迟/质量
门禁和确定性金额/费用规则。它们只产生不可变 `OpportunityRecord` 观测，不产生
`OrderIntent`、`Fill`、订单请求或真实 PnL。不得建立第二本账、第二套回放器、第二套
盘口或第二条 WebSocket 路径。

| 能力 | 主项目现状 | 参考实现/成熟库 | 重复实现风险 | 决定 | 验证/退出条件 |
|---|---|---|---|---|---|
| Complete-set edge | `execution/src/runtime/opportunities.ts`，使用统一 quote/depth/fee 证据 | 旧项目 `strategy/*`（路径不可访问）；引擎 `engine/strategy/*` | 两腿 edge 被误称原子无风险利润 | **REUSE_CURRENT** | 空侧、stale、未知费用拒绝；common visible size；显示 legging risk |
| Cross-venue lead-lag | 同一 `OpportunityRecord` 合同；公共 source adapters | 引擎 `tracker/ticker.ts`；无可直接复用的因果合同 | 把 source time 当 receive latency；未来数据泄漏 | **REUSE_CURRENT** | 50/100/250/500/1000/2000/3000ms 窗口；PIT 检查；延迟敏感性报告 |
| Maker envelope | 观测 spread/depth/lifetime/churn/markout | 引擎 simulation 与 wallet tracker；旧项目策略（不可访问） | 伪造 queue position/fill/rebate PnL | **REUSE_CURRENT** | 只输出上下界和 adverse selection；maker fill 恒为未知 |
| Fair-value mispricing | 观测接口，不装载模型或全局状态 | 参考项目模型仅作研究对照 | 未验证模型输出被当作可交易 edge | **DEFER** | 需独立模型验证、PIT 样本和基准对照后再批准 |
| Replay/ledger/PnL | Batch 3A `ReplayEngine`/`ExecutionModel`/`FeeModel`/`FillLedger` | 参考实现均有不同时间/费用语义 | 生成第二回测器或第二账本 | **REUSE_CURRENT** | 既有 Batch 1–3B 测试；4B 观测不得写 ledger |
| Public market data | `execution/src/adapters/market-data/*`，无凭据、bounded、quarantine | 引擎 CLOB tracker；官方 RTDS/CLOB SDK | 引入签名、User Channel 或第二 socket | **REUSE_CURRENT** | fake transport；无凭据；single bounded path；断线/stale fail closed |
| Terminal/reporting | 现有 CLI/JSON snapshot；Rich 可选但未在本批引入 | 引擎 `utils/terminal.ts`；Rich 14.3.4 已在 Python 环境 | 另建 UI 或将显示当作数据源 | **USE_MATURE_LIBRARY**（仅展示） | 非 TTY 与 TTY 同一快照；无网络副作用；依赖需显式锁定 |

## 路径与版本证据

- `pwd` 工作根为 `/root/projects/polymarket-money`；当前工作分支为
  `batch/4a-minimal-research-runtime`（4B 尚未由本子任务创建/切换分支）。
- `/root/projects/polymarket-paper` 不存在；不能声称本次重新读取该项目。
- `/root/projects/polymarket-trade-engine` 不存在；实际只读引擎为
  `/root/projects/olymarket-trade-engine`，HEAD `eda6759323b1b4cdb3559ca97876436c8fc231fd`，
  `LICENSE` 为 MIT。引擎依赖含 `@polymarket/clob-client-v2`、builder relayer、ethers、
  commander；这些能力包含签名/交易面，本批不安装、不实例化、不接入。
- 主项目当前 Node 依赖仅 TypeScript 5.9.3 与 Node 类型；Python 环境报告 Rich 14.3.4、
  pytest 8.4.2、ruff 0.15.21。官方/第三方 SDK 不作为运行时依赖新增。
- 旧项目许可证在既有审计中未发现；按许可证未知处理，不能复制其源码。

## 重复实现清单（必须阻止）

1. 另一个 edge 计算器：所有 gross/net edge 统一从当前费用证据与 Decimal 规则导出。
2. 另一个市场/订单簿状态机：继续使用 snapshot、sequence、stale、quarantine 语义。
3. 另一个回放器或账本：4B 记录机会，不改变 Batch 3A 裁判。
4. 自建交易 SDK、签名器、User Channel、钱包状态恢复：明确禁止。
5. maker queue/fill 模拟：只有上下界与 markout，不写理论成交。

## 验收方法

离线测试必须覆盖：四类 opportunity 的稳定序列化与拒绝理由、未来事件排除、空盘口/断线/
stale/quarantine fail-closed、双腿 common size 与 legging risk、lead-lag 多窗口、maker
无伪造 fill、无 `OrderIntent`、无 live client，以及 Batch 1–3B 全部回归测试。任何网络
验证仅使用公开、无凭据 fake/受限路径；不发送订单。若未来改变本登记决定，先更新
`docs/reuse-register.md`、测试和本 Gate，再实现适配层。

## 结论

复用主项目已有合同和状态机，参考项目仅提供行为/缺陷对照；成熟 SDK 只可用于协议研究。
Batch 4B 当前可继续做本地受限观测，但不构成实盘适用性或盈利证明。旧项目与引擎均不
直接接入，且本报告没有改变任何参考仓库。
