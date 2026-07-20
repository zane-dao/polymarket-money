# Batch 02 fail-first 证据

## 可核对的负向裁判

本批新增的负向测试包括：

- 模糊/非法 UTC 时间、local clock 因果倒退；
- 错 slug/window/oracle/token/orderbook/lifecycle；
- 非 BTC symbol、错误 RTDS topic/type、合法 off-topic snapshot、坏 JSON；
- CLOB 全部 `price_changes[]`、零 size 删除、错误 condition/token、delta-before-snapshot；
- 任意 auth/wallet-like subscription、任意 URL、超 frame/HTTP/total byte budget；
- 并发 append、同 ID 冲突、close 竞态、仓库内 root、symlink/path traversal；
- segment/manifest 覆盖、假 hash/count/IDs、重复 segment、未知字段、敏感 config；
- verify 后文件替换、伪造 `VerifiedDataset`、partial replay；
- Binance transport scope 与有效 `btcusdt` filter 不一致。

这些测试在对应保护被移除或输入被替换为反例时会失败；最终 63 项 Python 和 40 项 Node
全部通过。

## 证据限制

实现阶段先在工作树内建立反例再补最小实现，但没有为每个 red 状态建立独立 Git commit，
也没有保留完整 red console transcript。因此 Git 历史只能证明最终负向裁判存在，不能独立
证明每个测试的精确书写先后。此项作为过程 evidence debt 保留，不把事后描述冒充审计日志。
