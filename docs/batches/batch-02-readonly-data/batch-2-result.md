# Batch 02 结果：可信只读数据入口

## 结论

第二批功能验收通过，停止在只读数据边界。项目已经能够在无凭据模式下，把公开市场发现、
CLOB 订单簿和两个 RTDS 价格源保存为可校验的不可变 raw dataset，并由 Python 从已验证的
精确 bytes 确定性回放。没有新增 User Channel、签名、下单、撤单、策略、回测或实盘路径；
`LIVE_TRADING_ENABLED=false` 未改变。

有限联机验证曾在已提交采集器 `acaf1934a6a84f3b0d49f547a7a88a903bd3fc90`
完整通过。最终分支随后只修正“合法但 off-topic RTDS 帧应 quarantine，而不是 parse error”
的分类，并由对称离线测试覆盖；两次对最终提交的重采集分别遇到公开 Gamma TLS reset 和
public WebSocket transport error，因此没有把网络瞬时失败伪造成新的成功证据。这是明确的
证据限制，不影响此前真实 smoke 对四个数据源、manifest/checksum 和回放链的验证。

## Git 基线

- Batch 1 基线：`7f3c1c4429217c36edf0f018a5f3efb065cea312`
- Batch 1 标签：`batch-1-accepted`
- Batch 2 分支：`batch/2-readonly-data`
- 成功 smoke 的 collector commit：`acaf1934a6a84f3b0d49f547a7a88a903bd3fc90`
- 最终 RTDS 分类实现 commit：`b35c6e20964b7538a04a9d49ba62b5c8318797ab`
- 未 push；仓库级本地 identity 为 `Codex <codex@local.invalid>`

## 实现内容

### 语言无关合同

`contracts/raw-event-v1.schema.json` 固定 `RawEventEnvelopeV1`。source/server 可空但不得
伪造；receive/process/persist 必填且只接受毫秒精度 UTC `Z` 格式。原始 payload、UTF-8
SHA-256、parser 状态、连接/订阅/市场/token 身份全部保留。外部价格和数量保留 decimal
lexeme，不通过二进制 float 建立业务真相。

### 公开来源和事件

- Gamma：按精确 slug 查询并验证 BTC 五分钟窗口、condition、Up/Down token、orderbook、
  Chainlink BTC/USD 和 tie=Up 规则。
- CLOB Market Channel：`book`、`price_change`、`tick_size_change`、`last_trade_price`、
  `best_bid_ask`、`new_market`、`market_resolved`；处理全部 `price_changes[]` 和 `size=0`。
- RTDS Chainlink：只接受 `btc/usd`，区分外层 server time、payload source time 和本地
  receive time。
- RTDS Binance：默认精确 `btcusdt`；有限 smoke 可显式使用
  `all-symbols-quarantine`，但只有 `btcusdt` 能进入有效流。
- transport 审计：连接、订阅、PING/PONG、超时、错误、提前关闭和 capture complete。

`market_resolved` 只是待对账事实，不会构造黄金 Settlement。CLOB 没有官方 sequence/cursor
时，batch array 和订单簿状态始终明确标为 `UNVERIFIED`。

### 订单簿与断线

状态为 `WAITING_FOR_SNAPSHOT`、`ACTIVE_UNVERIFIED`、`STALE`、`DISCONNECTED` 和
`RESET_REQUIRED`。新连接必须为全部预期 token 获得 snapshot；断线立即清空旧状态；错误
condition/token、旧 connection delta、非法 Decimal 和过期数据 fail closed。

### 不可变存储与恢复

- `POLY_DATA_ROOT` 必须是仓库外绝对路径；逐级拒绝 symlink 和仓库内路径。
- `.jsonl.partial` 使用 exclusive create；每次 durable append 执行 fsync。
- close 后 SHA-256，并以 hard-link no-clobber 发布、目录 fsync、权限收紧为 0400。
- manifest 对真实文件重新核对 path、bytes、hash、line/schema/count、时间范围和 IDs。
- Python 只接受 final manifest；任何损坏使整个数据集零输出。回放使用验证时保存的 bytes，
  不重新打开可能被替换的路径。
- partial 只识别和报告，不自动续写、截断或伪装为完整 segment。

## 测试结果

- Python：63/63 通过；包含第一批全部黄金和安全测试。
- Node：40/40 通过；TypeScript `tsc --noEmit` 通过。
- 全新仓库外 venv 构建 wheel、安装、`pip check` 和 63 项测试通过。
- `npm ci`、40 项测试、typecheck、`npm ls --all` 通过；`npm audit --omit=dev` 为 0 漏洞。
- Python runtime dependencies：0；Node runtime dependencies：0。

详细命令和环境见 `reports/batches/batch-02/TEST-RESULTS-BATCH-2.md` 与
`reports/batches/batch-02/ENVIRONMENT-BATCH-2.md`。

## 有限联机验证

成功 run：`smoke-20260715125957-6347222a`，仓库外路径
`/tmp/polymarket-money-batch-02-smoke-accepted-H540nS`。该路径仅是本机临时证据，不进入
Git、handoff 或 review pack。

- 严格识别 `btc-updown-5m-1784120100`，窗口为 2026-07-15 12:55–13:00 UTC；发现时
  lifecycle 可采集。
- Gamma、CLOB、Chainlink、Binance 共 4 个 final manifest，0 partial。
- CLOB 同时观察到两个预期 token 的完整 snapshot；Chainlink 与 Binance 都观察到具有
  source/server/receive 三时钟的目标 BTC 更新。
- Python 验证四个 segment checksum、manifest 聚合和回放，9/9 smoke checks 为 true。
- 所有 source 的 continuity 均为 `UNVERIFIED`。

实际异常没有删除：RTDS 初始空帧；一条 off-topic subscribe frame；全符号 Binance 中两个
非 BTC 帧进入 quarantine；CLOB 两个 token 的快照各有一个空 side。详情见
`reports/batches/batch-02/SMOKE-CAPTURE-QUALITY.md`。

## 尚未解决

1. 官方公开流无可靠 sequence/cursor，不能证明上游无丢包。
2. Binance 精确单符号过滤在本环境中沉默；后备全符号模式只适合受限验证，不应直接成为
   长期采集默认。
3. 成功 smoke 使用 `acaf193`；最终 off-topic 分类补丁因随后公共网络抖动未完成第二次全链
   联机验证，但已通过 Python/TypeScript 负向测试。
4. 没有长期重连 supervisor、跨进程 writer lease、DrvFS durability 证明或运维部署。
5. 没有 point-in-time 规范化数据集、特征、手续费、成交模拟、回测、策略或真实执行。

完整分级见 `reports/batches/batch-02/UNRESOLVED-ISSUES.md`。

## 完成标准判断

满足第二批三个核心门：公开输入身份可验证；收到的 raw bytes 可不可变保存并由 manifest
重放；任何不能证明的连续性和异常均 fail closed/显式报告。有限 smoke 和 clean install
也有可重复证据。因此可标记 `batch-2-accepted`，但它不授权第三批、shadow 或实盘。

第三批开始前唯一建议任务：先审阅并冻结“verified raw → point-in-time normalized dataset”
的因果可见性合同、版本/lineage 和质量排除规则；在该合同获批前不要实现回测或策略。
