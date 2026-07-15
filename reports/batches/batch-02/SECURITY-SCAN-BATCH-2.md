# Batch 02 安全与仓库扫描

## 结论

通过。扫描范围是 Batch 1 标签到当前候选工作树的受控文件，以及 Git 跟踪清单；没有读取
真实 `.env`、用户凭据目录或参考项目秘密。

- 私钥 PEM header：0
- `sk-...` 形态命中：1 个，仅为负向测试字符串 `sk-not-a-public-endpoint`；真实 token 0
- 常见 API key/private key/mnemonic/passphrase 非占位赋值：0
- 真实 `.env` 跟踪文件：0；只跟踪 `.env.example`
- 大于 10 MiB 的跟踪文件：0
- `data/raw/` 跟踪内容：仅 `.gitkeep`
- smoke/runtime/review-pack 原始输出进入 Git：0
- `LIVE_TRADING_ENABLED=false`：示例和默认保持。3 个 `true` 文本只出现在 fail-closed
  错误消息/架构说明中，不是启用配置
- User Channel、签名、place/cancel 实现：本批新增 0

长 hex 命中只来自脱敏/public condition、token、fixture hash 和测试 hash；它们不是凭据。

## ignore 边界

`.gitignore` 覆盖 `.env*`（保留 example）、node_modules、venv、build/dist、日志、raw/
processed datasets、数据库 sidecar、Parquet/Arrow、partial/temp、runtime-data、smoke-data 和
review-packs。项目外 `~/review-packs/polymarket-money/batch-02/` 默认只放 handoff。

## 依赖

- Python runtime：无第三方依赖。
- Node runtime：无第三方依赖。
- Node dev：TypeScript 5.9.3、`@types/node` 24.13.3、传递 `undici-types` 7.18.2。
- `npm audit --omit=dev`：0 vulnerabilities。
