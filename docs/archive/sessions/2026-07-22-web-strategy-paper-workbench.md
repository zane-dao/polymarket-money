# 2026-07-22 05:56 Asia/Singapore｜Web 策略与 Paper 执行工作台收口

## 目标

把现有 React 页面接入本机 Web 后端，重点收口新策略扩展、参数与历史验证、可比回测展示，以及
真实公开行情驱动但绝不发送真实订单的完整 Paper 生命周期；Tauri 延后。

## 事实与证据

- 生产浏览器只调用同源 `/api/commands/*` 固定白名单，不直接访问数据库、业务文件或公网行情。
- Python 回测 worker 通过策略注册表分派，新受审查策略不再要求修改页面、Web command 或 worker。
- 策略对比由后端强制使用相同数据集版本、费用、延迟、初始资金和最大仓位。
- GTC/GTD 开放订单随新快照按 FIFO 和共享深度重撮合，GTD 由后台时钟自动过期；账本与请求可恢复。
- 官方 Gamma 结算只在当次明确联网批准后启用，并通过严格市场身份绑定和 hash-linked outbox 恢复。

## 修改

- AI 项目层：D-049 与 CURRENT 明确 Web 为当前入口、Tauri 延后；README 说明 Web 启动和 `dist/`。
- 代码层：接通策略、数据集、回测、对比、Paper、回放、健康与结算 Web 链；补齐策略注册分派和订单生命周期。
- 外部状态：未启动联网采集，未读取凭据，未连接钱包，未签名或发送真实订单。

## 验证

- `npm test`：251/251。
- `npm run frontend:test -- --run`：22/22。
- `npm run frontend:build`：通过。
- `npm run frontend:e2e`：桌面/移动本机真实 Web server 4/4。
- `python3 -m unittest discover -s strategies/tests -p 'test_*.py'`：9/9。
- TypeScript typecheck、后端 build 与 `git diff --check`：通过。

## 决定

- 短期操作入口只使用 Web；Tauri 问题以后单独处理。
- 页面不允许上传或执行任意策略代码；新增实现必须先进入受审查注册表。
- `LIVE_TRADING_ENABLED=false` 持续有效；所谓实盘逻辑仅指真实公开行情驱动的 Paper 状态机。

## 未决问题

- 本轮没有公开网络持续运行证据，CLOB continuity 继续为 `UNVERIFIED`。
- 策略参数合法、回测通过和工程测试通过均不等于盈利能力已证明。

## 下一步

- 如需验证公开行情链，先取得当次明确联网批准，再做有界、paper-only 的短时 Web 运行并保留证据。
