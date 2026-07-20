# 第一批安全边界

## 结论

第一批没有真实交易客户端、签名代码、私钥读取、用户频道或网络调用。默认配置同时满足：

```text
LIVE_TRADING_ENABLED=false
DRY_RUN=true
CREDENTIAL_MODE=none
EXPLICIT_LIVE_AUTHORIZATION=false
```

即使调用方手工构造 `live=true`、凭据已提供且显式授权的配置，Batch 1 工厂仍拒绝创建
live client，因为本仓库当前不存在可用的 live adapter。

## 配置单一真相

`SafetyConfig.from_mapping()` 接受调用方显式传入的字符串 mapping，不直接读取
`os.environ`。这样测试不会因宿主环境变量产生不同结果。

- 唯一 live 语义来自 `LIVE_TRADING_ENABLED`。
- `PROD`、`FORCE_PROD` 一旦出现就拒绝，不允许第二套生产真相。
- `LIVE_TRADING_ENABLED=true` 与 `DRY_RUN=true` 同时出现时拒绝。
- 布尔值只能是明确的 `true`/`false`，拼写异常时 fail closed。
- 默认运行环境是 development、模式是 dry-run、凭据模式是 none。

## 客户端创建门禁

| 条件 | 结果 |
|---|---|
| 默认配置 | 返回只在内存中产生 `DRY_RUN` 结果的离线客户端 |
| `APP_ENV=test` 请求 live | 拒绝，且注入的 factory 不会被调用 |
| live 未开启 | 拒绝 |
| 缺少显式授权 | 拒绝 |
| 凭据模式不是 approved provider | 拒绝 |
| 上述条件全部满足 | 仍拒绝：Batch 1 没有 live adapter |

`DryRunExecutionClient` 不访问网络、不读取凭据、不产生 exchange order ID，也不把 dry-run
标成 accepted。

## 幂等与未知结果

每个 `OrderIntent` 必须携带非空 `idempotency_key`。`SubmissionCoordinator` 在当前进程
中将 key 绑定到完整 intent 和首次结果：

- 同一 key、同一 intent 再次调用时返回原结果，不再调用 client；
- 首次结果为 `UNKNOWN` 时同样禁止自动重试；
- 同一 key 被用于不同 intent 时抛出冲突并 fail closed。

这是第一批的行为裁判，不是耐久化协议。进程崩溃后的唯一键、unknown outcome 查询、
exchange reconciliation 和状态恢复仍未实现，因此不能据此接入真实执行。

## 明确不包含

- 真实 SDK、签名、私钥、助记词或 API Key；
- 私有用户 WebSocket；
- 下单、撤单、紧急退出或实盘 dry-run 请求；
- live adapter factory 的可达实现；
- 通过网页、CLI 或第二环境变量热切换生产模式。
