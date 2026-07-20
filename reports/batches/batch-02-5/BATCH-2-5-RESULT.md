# Batch 02.5 result

## 最终结论

Batch 2.5 的三个核心门禁均已实现并通过离线验收：

1. 只有 `visible_at <= decision_time` 的事实能进入历史 view；
2. 任一 token 空侧、stale、disconnected、crossed、重连未 snapshot、因果歧义或 quarantine
   都会使整个 market 的 book 不可执行；
3. verified raw 可确定性生成、原子发布并离线重建 content-addressed normalized dataset。

结论为 **PASS WITH DOCUMENTED LIMITATIONS**。这不是回测数据“已适用”结论，也不是公开流
gap-free、长期采集稳定或实盘适用结论。

## 实际实现

- 新增 language-neutral normalized record/manifest schema；
- 新增 immutable fact、quarantine、direct/dependency raw lineage、canonical duplicate/conflict 规则；
- 新增 `as_of(decision_time, market_id)` 和六态盘口 gate（含空侧专用 `UNTRADEABLE`）；
- 新增 Gamma、CLOB snapshot/delta、Chainlink、Binance、connection/quality normalization；
- 扩展 `VerifiedDataset`，把 exact manifest provenance 纳入 verifier proof；
- 新增 deterministic build、single-writer atomic publish、no-overwrite 和 offline load；
- 明确拒绝 DrvFS；Binance all-symbol fallback 必须显式 opt-in 并进入 manifest。
- 将 raw manifest SHA、persist time、segment/line/message ordinal 纳入因果顺序；跨 manifest
  同毫秒且内容不同的状态不猜顺序，直接失败关闭；
- 严格绑定 Gamma payload、raw envelope 与 manifest subscription；即使错误声明的 market 身份
  之后才出现，也只在依赖身份可见后进入永久 quarantine，不泄漏未来；
- 严格校验 CLOB collector 的 `{audit_event, details}` 轨迹；no-op heartbeat 不改变连接状态，
  terminal audit 使旧 book 失效。

初始实现提交：`6ab1552e8ef271b332bf4103ae55112af9f42459`；最终硬化提交：
`ba13ccd`。Fail-first 测试提交：`1121538`；该提交在实现不存在时按预期产生两个 import error。

## 验证结果

| Gate | 结果 |
|---|---|
| 新增 Batch 2.5 Python 测试 | 56/56 PASS |
| Python 全量 | 119/119 PASS |
| Node 全量 | 40/40 PASS |
| TypeScript `tsc --noEmit` | PASS |
| clean Python venv `pip install -e '.[dev]'` | PASS |
| clean venv pytest | 119/119 PASS |
| Ruff | PASS |
| clean `npm ci` | PASS，0 vulnerabilities |
| `git diff --check` | PASS |

测试覆盖未来/晚到可见性、重连、断线、stale、空侧、crossed、continuity、duplicate lineage、
conflict quarantine、metadata revision、市场隔离、标签映射、Decimal/UTC、raw tamper、no-overwrite、
deterministic hash、版本变化、offline reload、DrvFS、显式 Binance fallback、CLOB audit envelope、
duplicate dataset identity、Gamma future identity claim、同毫秒跨 manifest 歧义和 market-wide
sibling-token fail-closed。

## 有限协议复核

2026-07-15 复核了 Polymarket 官方 RTDS 文档：Binance specific-symbol subscription 仍使用
`filters`，`btcusdt` 仍是支持 symbol；外层 timestamp 是发送毫秒，payload timestamp 是价格
记录毫秒。来源：[official RTDS documentation](https://docs.polymarket.com/market-data/websocket/rtds)。

随后只用 `btc-only`、15 秒 timeout、20-frame/1 MiB 上限做了一次无凭据、不落盘 probe：观察
1 个非目标帧，0 个 BTC parsed update，结果为 timeout/public-network failure。未启用
all-symbol fallback，未伪造成功。离线 off-topic/fallback tests 已通过，因此按批次规则记为
evidence debt，不阻断 normalized gate。

## 固定遗留决定

- continuity 继续且永久传播 `UNVERIFIED`；
- 长期 reconnect supervisor 延后到 Batch 2B；
- Binance 默认 BTC-only；fallback 只允许显式 opt-in + manifest；
- 空侧 midpoint null，不可执行；
- 当前保持 single-writer；
- DrvFS 不在支持范围。

## 未做

没有回测、特征、GBM/GARCH、策略、动态手续费、Fill/PnL 持久化、shadow、User Channel、签名、
订单、仓位、live、长期后台采集或 Batch 3 工作。
