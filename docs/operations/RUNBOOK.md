# 运行手册

默认只做离线验证。`npm run mvp:console -- --data-root <仓外目录>` 启动 localhost 的只读结果浏览；加入 `--enable-local-history-runs` 后才允许固定的离线历史回放。

`paper:mvp`、campaign 与 settle 命令均可能访问公开网络，因此每次执行前必须取得用户对具体范围、窗口和运行时长的明确批准。不得读取凭据、连接私有频道、签名、下单或撤单。

paper 运行必须使用仓外数据目录、显式 durable journal 与预绑定计划；结束后通过 `paper:report` 或相应 cohort 报告重放验收。完整命令和当前限制见 [Batch 06 协议](../batches/batch-06-kj-paper/next-controlled-paper-protocol.md)。
