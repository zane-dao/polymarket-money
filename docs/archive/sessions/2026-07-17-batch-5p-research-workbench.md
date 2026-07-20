# 2026-07-17 Batch 5P 旧产品重建与最小研究工作台

## 目标

停止策略收益与 R2 研究，在旧 Tauri/React 产品上完成可日常运行的 Legacy 研究、公开监控与
paper 工作台；不使用凭据、User Channel、签名或真实订单。

## 事实与证据

- 旧知识入口不是代码仓；实际源码为 `/mnt/c/Users/seeta/Desktop/hello-world`，来源
  `d08ba3e`。Linux 代码工作副本为 `/root/projects/polymarket-paper-workbench`。
- API 实跑发现并修复 rust extension namespace 误判、Windows D 路径、`--no-prices` 假离线。
- K Start/Pause/Resume/Stop、J Paper Simulation、JSON/CSV、React production build、Tauri
  release/WSLg、公开 market/book/BTC 与 Stop 均实际通过。
- 关键 Python 71/71；前端 91 modules build；npm audit 0；Tauri release 冷构建成功。
- 公开 smoke 只显示 `MONITOR_ONLY`，safe mode 的账户/订单/watchdog/config-write 均 403。

## 修改

- AI 项目层：更新 CURRENT、D-021、会话索引与本摘要。
- 代码层：新增 Workbench API/React 页面/单命令启动器/必要测试和三份指定说明；修改旧 API、
  config 路径与 vol 降级。
- 外部状态：只生成 `/mnt/d/polypolycache/HANDOFF-BATCH-05P.md`；安装锁定前端依赖及
  Ubuntu Tauri/Rust 构建依赖；未改系统代理配置。

## 验证

- `python3 -m unittest tests.test_workbench tests.test_config tests.test_signal tests.test_signal_registry tests.test_api -v`
- `npm run build`
- `PATH=/usr/bin:$PATH npm run tauri -- build --no-bundle`
- `./scripts/run-workbench.sh --offline` 与有界公开 Live Monitor API smoke。
- 结果：71/71、React/Tauri build、窗口、公开快照、Stop/导出和负向安全门均通过。

## 决定

- D-021：旧产品工作副本为唯一 UI 主体；Legacy 与 Strict 明确分离；公开 monitor 不等于
  live trading。

## 未决问题

- Strict K/J 尚未适配 polymarket-money；公开 monitor 未做长期恢复/continuity 证明。
- Rustup 源曾 `tls handshake eof`，最终使用 Ubuntu Rust/Cargo 1.93.1；用户 shell 中旧
  rustup shim 仍未配置，因此项目构建命令显式把 `/usr/bin` 放在 PATH 前，不改全局设置。

## 下一步

停止。后续仅在用户另行授权时做 Strict 外部适配或公开监控恢复性小改；不验证收益、
不重跑 R2、不进入 shadow/live trading。
